#include "Networking.h"

#include <iostream>
#include <fstream>
#include <filesystem>
#include "Addresses1147.h"
#include "ChannelLookup.h"
#include "Hooking.h"
#include "NativeDiagnostics.h"
#include "OwnerRelevancy.h"
#include "ReplicationCadence.h"

using namespace SDK;

extern "C" {
    __declspec(dllexport) volatile unsigned long long DR_ActorReplicationAttempts = 0;
    __declspec(dllexport) volatile unsigned long long DR_OwnerReplicationSkipped = 0;
    __declspec(dllexport) volatile unsigned long long DR_ActorUpdatesDeferred = 0;
    __declspec(dllexport) volatile unsigned long long DR_ChannelAssignmentTrackingEnabled = 0;
}

namespace Networking {
    UNetDriver* NetDriver = nullptr;

    template <typename T>
    static T Fn(uintptr_t Rva) { return reinterpret_cast<T>(Hooking::Base + Rva); }

    template <typename T>
    static T& Field(void* Object, uintptr_t Offset) { return *reinterpret_cast<T*>(reinterpret_cast<uintptr_t>(Object) + Offset); }

    static void* VirtualAt(void* Object, uintptr_t SlotOffset) { return *reinterpret_cast<void**>(*reinterpret_cast<uintptr_t*>(Object) + SlotOffset); }

    uint32_t ConnectionState(UNetConnection* Connection) { return Field<uint32_t>(Connection, Off::ConnectionState); }

    static std::vector<AActor*> BuildConsiderList(UWorld* World, UNetDriver* Driver) {
        std::vector<AActor*> Actors;
        static ReplicationCadence Cadence;
        static UWorld* PreviousWorld = nullptr;
        if (PreviousWorld != World) { Cadence.Clear(); PreviousWorld = World; }
        const double Now = GetTickCount64() / 1000.0;
        Cadence.Prune(Now);

        for (ULevel* Level : World->Levels) {
            if (!Level) continue;
            for (AActor* Actor : Level->Actors) {
                if (!Actor || Actor->RemoteRole == ENetRole::ROLE_None || Actor->bActorIsBeingDestroyed)
                    continue;

                if (!reinterpret_cast<UWorld*(*)(AActor*)>(VirtualAt(Actor, VTable::ActorGetWorld))(Actor))
                    continue;

                // An unreliable multicast is only sent within NetCullDistanceSquared of the viewer's
                // location. This loop already sends every actor to every client, so that distance
                // must not drop gameplay effects either (kept from the damage-number investigation).
                if (Actor->NetCullDistanceSquared < 1.0e16f)
                    Actor->NetCullDistanceSquared = 1.0e16f;

                const bool Urgent = Actor->bReplicateMovement || Actor->bTearOff || Actor->bNetTemporary ||
                    Actor->IsA(APawn::StaticClass()) || Actor->IsA(AController::StaticClass());
                if (!Cadence.Due(Actor, Actor->Index, Now, Actor->NetUpdateFrequency, Urgent)) {
                    ++DR_ActorUpdatesDeferred;
                    continue;
                }

                Fn<void(*)(AActor*, UNetDriver*)>(Addr::CallPreReplication)(Actor, Driver);
                Actors.push_back(Actor);
            }
        }
        return Actors;
    }

    using ActorChannelIndex = ChannelIndex<AActor>;

    static AActor* ChannelActor(UChannel* Channel) {
        return Channel && Channel->Class == UActorChannel::StaticClass()
            ? static_cast<UActorChannel*>(Channel)->Actor : nullptr;
    }

    // Only scopes on the current game thread receive assignment notifications.
    struct ChannelTrackingScope;
    static thread_local ChannelTrackingScope* ActiveChannelTracking = nullptr;

    struct ChannelTrackingScope {
        UNetConnection* Connection;
        ActorChannelIndex& Index;
        ChannelTrackingScope* Previous;

        ChannelTrackingScope(UNetConnection* InConnection, ActorChannelIndex& InIndex)
            : Connection(InConnection), Index(InIndex), Previous(ActiveChannelTracking) {
            ActiveChannelTracking = this;
        }
        ~ChannelTrackingScope() { ActiveChannelTracking = Previous; }
        ChannelTrackingScope(const ChannelTrackingScope&) = delete;
        ChannelTrackingScope& operator=(const ChannelTrackingScope&) = delete;
    };

    static void NoteActorAssignment(UNetConnection* Connection, AActor* Actor, bool Completed = false) {
        for (auto* Scope = ActiveChannelTracking; Scope; Scope = Scope->Previous)
            if (Scope->Connection == Connection) {
                if (Completed) Scope->Index.AssignmentCompleted(Actor, Connection->OpenChannels.Num(),
                    [Connection](int i) { return Connection->OpenChannels[i]; }, ChannelActor);
                else Scope->Index.ActorAssigned(Actor);
            }
    }

    using SetChannelActorFn = void(*)(UActorChannel*, AActor*, unsigned int);
    static void* OriginalSetChannelActor = nullptr;

    static void SetChannelActorHook(UActorChannel* Channel, AActor* Actor, unsigned int Flags) {
        // Capture the owner while Channel is live; never dereference Channel after the engine call.
        auto* Connection = Channel ? Channel->Connection : nullptr;
        NoteActorAssignment(Connection, Actor);
        reinterpret_cast<SetChannelActorFn>(OriginalSetChannelActor)(Channel, Actor, Flags);
        NoteActorAssignment(Connection, Actor, true);
    }

    void InitChannelTracking() {
        if (Hooking::Hook("UActorChannel::SetChannelActor", Addr::SetChannelActor, Prologue::SetChannelActor,
                SetChannelActorHook, &OriginalSetChannelActor)) {
            DR_ChannelAssignmentTrackingEnabled = 1;
        } else {
            std::cerr << "Actor channel assignment tracking unavailable; using conservative channel lookup" << std::endl;
        }
    }

    static ActorChannelIndex IndexActorChannels(UNetConnection* Connection) {
        return IndexChannels<AActor>(Connection->OpenChannels.Num(),
            [Connection](int i) { return Connection->OpenChannels[i]; }, ChannelActor,
            DR_ChannelAssignmentTrackingEnabled != 0);
    }

    static UActorChannel* GetActorChannelForConnectionAndActor(UNetConnection* Connection, AActor* Actor, ActorChannelIndex& Index) {
        return static_cast<UActorChannel*>(FindChannel(Actor, Index, Connection->OpenChannels.Num(),
            [Connection](int i) { return Connection->OpenChannels[i]; }, ChannelActor));
    }

    // UWorld::SetActiveLevelCollection copies the active FLevelCollection's NetDriver into
    // World->NetDriver during every world tick. Ours is in none of them, so while gameplay ran the
    // world had no driver: AActor::GetNetDriver() returned null and every RPC sent by gameplay
    // (damage numbers, hit reactions, deaths) was dropped. The 1.4.4 DLL patched the lookup
    // (GetNetDriverInternal); 2.1.1 sets the collections, as here.
    static void SetDriverOnLevelCollections(UWorld* World, UNetDriver* Driver) {
        static int Reported = 0;
        int Updated = 0;
        for (FLevelCollection& Collection : World->LevelCollections) {
            if (Collection.NetDriver != Driver) {
                Collection.NetDriver = Driver;
                ++Updated;
            }
        }
        if (Updated && Reported++ < 3)
            std::cout << "GameNetDriver set on " << Updated << " level collection(s)" << std::endl;
    }

    bool Listen(UEngine* Engine, int Port) {
        UWorld* World = UWorld::GetWorld();
        if (!Engine || !World) return false;
        NetDriver = nullptr;

        FName GameNetDriver = UKismetStringLibrary::Conv_StringToName(L"GameNetDriver");
        const bool Created = Fn<bool(*)(UEngine*, UWorld*, FName, FName)>(Addr::CreateNamedNetDriver)(Engine, World, GameNetDriver, GameNetDriver);
        std::cout << "Net driver create: " << Created << std::endl;

        // GameNetDriver is NetDriverEOS (IpNetDriver fallback): ask the engine rather than scan objects.
        NetDriver = Fn<UNetDriver*(*)(UEngine*, UWorld*, FName)>(Addr::FindNamedNetDriver)(Engine, World, GameNetDriver);
        if (!NetDriver) {
            std::cerr << "Net driver creation failed" << std::endl;
            return false;
        }
        std::cout << NetDriver->GetFullName() << std::endl;

        const auto SetWorld = Fn<void(*)(UNetDriver*, UWorld*)>(Addr::NetDriverSetWorld);
        SetWorld(NetDriver, World);

        FURL Url{};
        Url.Port = Port;
        FString Error{};
        // UWorld derives from FNetworkNotify: pass the address of that base sub-object.
        void* Notify = reinterpret_cast<uint8_t*>(World) + Off::WorldNetworkNotify;
        const auto InitListen = reinterpret_cast<bool(*)(UNetDriver*, void*, FURL*, bool, FString*)>(VirtualAt(NetDriver, VTable::NetDriverInitListen));
        const bool Listening = InitListen(NetDriver, Notify, &Url, false, &Error);
        std::cout << "Listen Status: " << Listening << std::endl;
        if (!Listening && Error.IsValid()) std::cout << "Listen error: " << Error.ToString() << std::endl;

        SetWorld(NetDriver, World);
        World->NetDriver = NetDriver;
        SetDriverOnLevelCollections(World, NetDriver);

        // A unique per-launch marker lets deployment wait for the actual listening world.
        wchar_t ReadyPath[32768] = {};
        const DWORD Length = GetEnvironmentVariableW(L"DR_SERVER_READY_FILE", ReadyPath, 32768);
        if (Listening && Length > 0 && Length < 32768) {
            std::ofstream Ready{std::filesystem::path(ReadyPath)};
            Ready << GetCurrentProcessId() << ":" << Port;
        }
        return Listening;
    }

    void TickNetworking() {
        UWorld* World = UWorld::GetWorld();
        if (!NetDriver || !World) return;

        // The engine can destroy our driver (a travel, a shutdown after a failed login). Writing a
        // stale pointer back into World->NetDriver crashes UWorld::Tick, so ask the engine each tick.
        static FName GameNetDriver = UKismetStringLibrary::Conv_StringToName(L"GameNetDriver");
        UNetDriver* Live = Fn<UNetDriver*(*)(UEngine*, UWorld*, FName)>(Addr::FindNamedNetDriver)(UEngine::GetEngine(), World, GameNetDriver);
        if (Live != NetDriver) {
            std::cout << "Net driver changed or gone; replication stopped" << std::endl;
            DR_WriteDiagnostic("net_driver_lost\n", 16);
            NetDriver = nullptr;
            return;
        }
        World->NetDriver = NetDriver;
        NetDriver->World = World;
        SetDriverOnLevelCollections(World, NetDriver);

        static ULONGLONG NextDiagnostic = 0;
        static unsigned DiagnosticCount = 0;
        if (DiagnosticCount < 4096 && GetTickCount64() >= NextDiagnostic) {
            ++DiagnosticCount;
            NextDiagnostic = GetTickCount64() + 30000;
            int Ready = 0, Owned = 0;
            for (auto* Connection : NetDriver->ClientConnections) {
                if (!Connection) continue;
                Owned += Connection->OwningActor != nullptr;
                Ready += ConnectionState(Connection) == 3;
            }
            char Line[512] = {};
            int Size = sprintf_s(Line, "net driver=%s connections=%d owned=%d open=%d\n",
                NetDriver->GetName().c_str(), NetDriver->ClientConnections.Num(), Owned, Ready);
            if (Size > 0) DR_WriteDiagnostic(Line, Size);
        }

        static FName ActorName = UKismetStringLibrary::Conv_StringToName(L"Actor");

        ++Field<uint32_t>(NetDriver, Off::NetDriverReplicationFrame);

        bool HasReadyConnection = false;
        for (UNetConnection* Connection : NetDriver->ClientConnections) {
            if (Connection && Connection->OwningActor && ConnectionState(Connection) == 3) {
                HasReadyConnection = true;
                break;
            }
        }
        if (!HasReadyConnection) return;

        std::vector<AActor*> Actors = BuildConsiderList(World, NetDriver);

        const auto SendClientAdjustment = Fn<void(*)(APlayerController*)>(Addr::SendClientAdjustment);
        const auto CreateChannelByName = Fn<UActorChannel*(*)(UNetConnection*, FName*, unsigned int, int)>(Addr::CreateChannelByName);
        const auto SetChannelActor = Fn<void(*)(UActorChannel*, AActor*, unsigned int)>(Addr::SetChannelActor);
        const auto ReplicateActor = Fn<int64_t(*)(UActorChannel*)>(Addr::ReplicateActor);

        for (UNetConnection* Connection : NetDriver->ClientConnections) {
            if (!Connection || !Connection->OwningActor || ConnectionState(Connection) != 3)
                continue;

            auto Channels = IndexActorChannels(Connection);
            ChannelTrackingScope TrackAssignments(Connection, Channels);
            for (AActor* Actor : Actors) {
                // Preserve owner-only isolation rather than opening private actors on every client.
                auto* Pawn = Connection->PlayerController ? Connection->PlayerController->Pawn : nullptr;
                if (Actor->bOnlyRelevantToOwner && !Actor->bAlwaysRelevant &&
                    !(Pawn && Actor->Instigator == Pawn) &&
                    !IsConnectionOwner(Actor, Connection->OwningActor,
                        static_cast<AActor*>(Pawn), [](AActor* Value) { return Value->Owner; })) {
                    ++DR_OwnerReplicationSkipped;
                    continue;
                }
                if (Actor->Class->CastFlags & EClassCastFlags::PlayerController) {
                    if (Actor != Connection->OwningActor)
                        continue;
                    Connection->ViewTarget = static_cast<APlayerController*>(Actor)->GetViewTarget();
                    SendClientAdjustment(static_cast<APlayerController*>(Actor));
                }

                UActorChannel* ActorChannel = GetActorChannelForConnectionAndActor(Connection, Actor, Channels);
                if (!ActorChannel) {
                    ActorChannel = CreateChannelByName(Connection, &ActorName, 1 << 1 /* EChannelCreateFlags::OpenedLocally */, -1);
                    if (ActorChannel)
                        SetChannelActor(ActorChannel, Actor, 0);
                }

                if (ActorChannel && ActorChannel->Actor) {
                    ++DR_ActorReplicationAttempts;
                    Field<uint32_t>(ActorChannel, Off::ActorChannelFlags) |= Off::ActorChannelFlagBit;
                    ReplicateActor(ActorChannel);
                }
            }
        }
    }
}
