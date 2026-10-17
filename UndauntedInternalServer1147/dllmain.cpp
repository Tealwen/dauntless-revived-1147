// Dauntless Revived server/client DLL for the Dauntless 1.14.7 client (CL 647472, UE 4.26.2).
// Port of UndauntedInternalServer (1.4.4). This first version carries the minimum needed to boot
// a Ramsgate game server and let a client connect; the gameplay helpers of the 1.4.4 DLL
// (abilities RPC fix, fall recovery, trials, vendor tabs, ...) are not ported yet.

#include <windows.h>
#include <shellapi.h>
#include <io.h>
#include <share.h>
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <string>
#include <thread>
#include <vector>

#include "SDK.hpp"
#include "SDK/GameplayAbilities_parameters.hpp"
#include "Addresses1147.h"
#include "AutoPressStart1147.h"
#include "CellFusionTime1147.h"
#include "CityIdlePolicy.h"
#include "ConnectedPlayers1147.h"
#include "CrashFixes1147.h"
#include "DeveloperStyle1147.h"
#include "Endpoints1147.h"
#include "EngineString.h"
#include "FallRecovery1147.h"
#include "Hooking.h"
#include "HuntIdlePolicy.h"
#include "HuntUnlock1147.h"
#include "NativeDiagnostics.h"
#include "Networking.h"
#include "NoPlatinumPrice1147.h"
#include "ServerFrameLimit.h"
#include "Social1147.h"
#include "UiHitchProfile1147.h"
#include "VendorTabs1147.h"
#include "constants.h"

using namespace SDK;

namespace Globals {
    static bool AmServer = false;
    bool Listening = false;
    bool DoListen = false;
    const wchar_t* ServerAPIKey = nullptr;
    const wchar_t* MapPath = nullptr;
    const wchar_t* BehemothPath = nullptr;
    const wchar_t* MatchmakerHuntId = nullptr;
    const wchar_t* ExpectedPlayerString = nullptr;
    int Port = 0;
    std::wstring MetagameAddress;
}

template <typename T>
static T Original(void* Trampoline) { return reinterpret_cast<T>(Trampoline); }

// ---------------------------------------------------------------- shared hooks

// UseEOS(): false selects the Phoenix/MCP login path that the 1.4.4 backend already speaks,
// so no Epic service is involved. Same effect as -DisableEOS, which the command-line
// allow list would strip.
static void* OrigUseEOS = nullptr;
static bool UseEOSHook() { return false; }

// EasyAntiCheat client start-up: never runs without the EAC bootstrapper anyway.
static void* OrigEACInit = nullptr;
static void EACInitHook(void*) {}

static void* OrigHasFinishedLoading = nullptr;
static bool HasFinishedLoadingHook(UObject* Object) {
    if (Original<bool(*)(UObject*)>(OrigHasFinishedLoading)(Object))
        return true;
    // Client: the inventory finishes on its own once its own inventory query completes. Forcing it ready
    // let the loadout resolve its items against an empty inventory 20 ms early, and it never retries
    // ("ResolveItemInstanceId: No InventoryItem"): empty loadout menus and an unequipped character.
    if (!Globals::AmServer && Object->Class && Object->Class->GetName().contains("inventory"))
        return false;
    std::cout << "[FORCEREADY] " << Object->GetFullName() << std::endl;
    return true;
}

static std::map<std::wstring, std::wstring> EndpointMap;

static void BuildEndpointMap() {
    for (const auto& [Key, Path] : Endpoints1147)
        EndpointMap[Key] = L"http://" + Globals::MetagameAddress + Path;
}

static void* OrigConfigGetString = nullptr;
static bool ConfigGetStringHook(void* Config, const wchar_t* Section, const wchar_t* Key, FString* Value, FString* Filename) {
    if (Key && !EndpointMap.empty()) {
        if (auto It = EndpointMap.find(Key); It != EndpointMap.end()) {
            EngineString::Assign(Value, It->second.c_str());
            return true;
        }
    }

    // Servers only override Phoenix endpoints; clients also point Epic's MCP services home.
    if (!Globals::AmServer && Section && Key && std::wstring(Section).contains(L"Mcp")) {
        const std::wstring K(Key);
        // Chat (XMPP over WebSocket): address, port, SSL and domain of the metagame's chat server
        if (Social1147::XmppConfig(Section, Key, Value)) return true;
        // The notification service is STOMP over a WebSocket (metagame realtime/stomp.ts)
        if (std::wstring(Section).contains(L"Stomp") && K == L"Protocol") { EngineString::Assign(Value, L"ws"); return true; }
        if (K.contains(L"protocol") || K.contains(L"Protocol")) { EngineString::Assign(Value, L"http"); return true; }
        if (K.contains(L"Domain") || K.contains(L"RedirectUrl")) { EngineString::Assign(Value, Globals::MetagameAddress.c_str()); return true; }
    }

    return Original<bool(*)(void*, const wchar_t*, const wchar_t*, FString*, FString*)>(OrigConfigGetString)(Config, Section, Key, Value, Filename);
}

// ---------------------------------------------------------------- server hooks

static void* OrigCommandLine = nullptr;
static const wchar_t* CommandLineHook() {
    // Read by the engine instead of the real command line, which keeps our positional
    // arguments away from the engine and bypasses the shipping allow list.
    return L"Dauntless-Win64-Shipping.exe -server -unattended -nullrhi -nosound -EpicPortal -RepDriverDisable -DisableEOS -NoEAC";
}

// Client: the real (allow-listed) command line plus the switches the allow list would strip.
// Many call sites parse -DisableEOS themselves, so patching UseEOS alone is not enough.
static const wchar_t* ClientCommandLineHook() {
    static SRWLOCK Lock = SRWLOCK_INIT;
    static std::wstring Source;
    static std::vector<std::wstring*> Buffers; // kept alive: callers may hold older pointers
    const wchar_t* Current = Original<const wchar_t*(*)()>(OrigCommandLine)();
    AcquireSRWLockExclusive(&Lock);
    if (Buffers.empty() || Source != Current) {
        Source = Current;
        Buffers.push_back(new std::wstring(Source + L" -DisableEOS -NoEAC"));
    }
    const wchar_t* Result = Buffers.back()->c_str();
    ReleaseSRWLockExclusive(&Lock);
    return Result;
}

static void* OrigGetDefaultMap = nullptr;
static FString* GetDefaultMapHook(FString* Out) {
    FString* Ret = Original<FString*(*)(FString*)>(OrigGetDefaultMap)(Out);

    std::wstring Url(Globals::MapPath);
    if (!std::wstring(Globals::BehemothPath).contains(L"NO_BEHEMOTH"))
        Url += L"?MonsterClass=" + std::wstring(Globals::BehemothPath);
    if (!std::wstring(Globals::MatchmakerHuntId).contains(L"NO_MM_HUNTID"))
        Url += L"?HuntId=" + std::wstring(Globals::MatchmakerHuntId);
    if (!std::wstring(Globals::ExpectedPlayerString).contains(L"NO_EXPECTED_PLAYERS")) {
        const std::wstring Players(Globals::ExpectedPlayerString);
        Url += L"?PlayerHuntIds=" + Players;
        // 1.14.7 has no PlayerHuntIds: AArchonGameMode::InitGame (0x1906EB0) reads ExpectedPlayerCount, and the
        // pre-match airship waits for that many players before the arrival sequence. Without it a party's
        // hunt started with the first player in. The list is "uid:huntId,uid:huntId,...".
        const auto Count = std::count(Players.begin(), Players.end(), L',') + 1;
        Url += L"?ExpectedPlayerCount=" + std::to_wstring(Count);
    }

    EngineString::Assign(Ret, Url.c_str());
    return Ret;
}

static void* OrigNetMode = nullptr;
static int NetModeHook(void*) { return 1; } // NM_DedicatedServer

static void* OrigSetReplicationDriver = nullptr;
static void SetReplicationDriverHook(UNetDriver* Driver, UReplicationDriver*) {
    // The replication graph is replaced by Networking::TickNetworking.
    Original<void(*)(UNetDriver*, UReplicationDriver*)>(OrigSetReplicationDriver)(Driver, nullptr);
}

// The 1.4.4 DLL named these two the other way round. Every level counts as initialised for
// every connection, and no connection counts as saturated.
static void* OrigIsLevelInitializedForActor = nullptr;
static bool IsLevelInitializedForActorHook(void*, const void*, void*) { return true; }

static void* OrigIsNetReady = nullptr;
static bool IsNetReadyHook(void* Connection, bool Saturate) {
    Original<bool(*)(void*, bool)>(OrigIsNetReady)(Connection, Saturate);
    return true;
}

static void* OrigNetDriverNetMode = nullptr;

static void* OrigProcessRequest = nullptr;
static bool ProcessRequestHook(void* Request) {
    const auto SetHeader = reinterpret_cast<void(*)(void*, FString*, FString*)>(Hooking::Base + Addr::CurlSetHeader);
    FString Header(L"x-undaunted-gameserver-apikey");
    FString Key(Globals::ServerAPIKey);
    SetHeader(Request, &Header, &Key);
    ConnectedPlayers1147::AddHeaders(Request);
    return Original<bool(*)(void*)>(OrigProcessRequest)(Request);
}

static UWorld* ObjectWorld(UObject* Object) {
    for (UObject* Current = Object; Current; Current = Current->Outer)
        if (Current->IsA(UWorld::StaticClass()))
            return static_cast<UWorld*>(Current);
    return nullptr;
}

static AArchonPlayerStart* PickPlayerStartFallback(AArchonPlayerState* PlayerState, const FName& StartGroup, bool MatchGroup) {
    UWorld* PlayerWorld = ObjectWorld(PlayerState);
    std::vector<AArchonPlayerStart*> Candidates;
    for (int i = 0; i < UObject::GObjects->Num(); i++) {
        UObject* Obj = UObject::GObjects->GetByIndex(i);
        if (!Obj || Obj->IsDefaultObject() || !Obj->IsA(AArchonPlayerStart::StaticClass()))
            continue;
        auto* Start = static_cast<AArchonPlayerStart*>(Obj);
        if (PlayerWorld && ObjectWorld(Start) != PlayerWorld) continue;
        if (MatchGroup && Start->GroupName != StartGroup) continue;
        Candidates.push_back(Start);
    }
    if (Candidates.empty()) return nullptr;
    const int32 Slot = PlayerState ? PlayerState->PlayerStartSlot : -1;
    return Candidates[Slot >= 0 ? static_cast<size_t>(Slot) % Candidates.size() : 0];
}

// Phoenix's GetPlayerStartForPlayer filters by group and slot; fall back to any start in the same world.
static void* OrigGetStartSpot = nullptr;
static AArchonPlayerStart* GetStartSpotHook(AArchonPlayerState* PlayerState, FName StartGroup) {
    if (auto* Start = Original<AArchonPlayerStart*(*)(AArchonPlayerState*, FName)>(OrigGetStartSpot)(PlayerState, StartGroup)) {
        FallRecovery::RememberStart(PlayerState, Start);
        return Start;
    }
    auto* Start = PickPlayerStartFallback(PlayerState, StartGroup, true);
    if (!Start) Start = PickPlayerStartFallback(PlayerState, StartGroup, false);
    std::cout << "Player start fallback for group=" << StartGroup.ToString() << " -> "
              << (Start ? Start->GetFullName() : std::string("none")) << std::endl;
    FallRecovery::RememberStart(PlayerState, Start);
    return Start;
}

// Ability activation. A client's ServerTryActivateAbility(WithEventData) RPC is not activated by the
// native handler on this server (no damage, no hit reactions), so it is replaced by the same work done
// directly: press input, InternalTryActivateAbility, release input if that failed. As in the 1.4.4 DLL.
static bool TryActivateAbility(UAbilitySystemComponent* Component, FGameplayAbilitySpecHandle& Handle, bool InputPressed,
    FPredictionKey& PredictionKey, FGameplayEventData* TriggerEventData) {
    if (InputPressed)
        Component->ServerSetInputPressed(Handle);

    void* InstancedAbility = nullptr;
    const auto InternalTryActivate = reinterpret_cast<bool(*)(UAbilitySystemComponent*, int32_t, FPredictionKey*, void**, void*, FGameplayEventData*)>(
        Hooking::Base + Addr::InternalTryActivateAbility);
    const bool Activated = InternalTryActivate(Component, Handle.Handle, &PredictionKey, &InstancedAbility, nullptr, TriggerEventData);

    if (!Activated && InputPressed)
        Component->ServerSetInputReleased(Handle);
    return Activated;
}

// Resolved on the game thread at the first engine tick (UObjects do not exist when the DLL loads).
static UFunction* TryActivateWithEventData = nullptr;
static UFunction* TryActivatePlain = nullptr;
static void ResolveAbilityFunctions() {
    if (TryActivatePlain) return;
    UClass* Class = UAbilitySystemComponent::StaticClass();
    if (!Class) return;
    TryActivateWithEventData = Class->GetFunction("AbilitySystemComponent", "ServerTryActivateAbilityWithEventData");
    TryActivatePlain = Class->GetFunction("AbilitySystemComponent", "ServerTryActivateAbility");
    std::cout << "Ability RPCs: " << (TryActivatePlain && TryActivateWithEventData ? "found" : "NOT FOUND") << std::endl;
}

static void* OrigProcessEvent = nullptr;
// DR_TRACE_EVENTS=word1,word2: logs (once per function) every ProcessEvent whose function name
// contains one of the words. A diagnostic for finding which gameplay calls a server runs.
static std::vector<std::string> TraceWords = [] {
    std::vector<std::string> Words;
    char Value[512] = {};
    const auto Length = GetEnvironmentVariableA("DR_TRACE_EVENTS", Value, sizeof(Value));
    if (Length == 0 || Length >= sizeof(Value)) return Words;
    std::string All(Value), Word;
    for (char C : All + ",") {
        if (C == ',') { if (!Word.empty()) Words.push_back(Word); Word.clear(); }
        else Word += static_cast<char>(tolower(C));
    }
    return Words;
}();

static void TraceEvent(UObject* Object, UFunction* Function) {
    static std::map<UFunction*, int> Seen;
    if (TraceWords.empty() || !Function || Seen.size() > 4000) return;
    auto& Count = Seen[Function];
    if (Count++ > 0) return; // first call of each function only
    std::string Name = Function->GetFullName(), Lower = Name;
    for (auto& C : Lower) C = static_cast<char>(tolower(C));
    for (const auto& Word : TraceWords)
        if (Lower.find(Word) != std::string::npos) {
            std::cout << "[event] " << Name << " on " << (Object ? Object->GetName() : "null") << std::endl;
            return;
        }
}

// Diagnostic (with DR_TRACE_EVENTS): why a damage-number multicast does not reach the clients.
static void ProcessEventHook(UObject* Object, UFunction* Function, void* Parms) {
    UFunction* const WithEventData = TryActivateWithEventData;
    UFunction* const Plain = TryActivatePlain;
    TraceEvent(Object, Function);

    if (Function && Function == WithEventData) {
        auto* P = static_cast<Params::AbilitySystemComponent_ServerTryActivateAbilityWithEventData*>(Parms);
        TryActivateAbility(static_cast<UAbilitySystemComponent*>(Object), P->AbilityToActivate, P->InputPressed, P->PredictionKey, &P->TriggerEventData);
        return; // forwarding would activate it twice
    }
    if (Function && Function == Plain) {
        auto* P = static_cast<Params::AbilitySystemComponent_ServerTryActivateAbility*>(Parms);
        TryActivateAbility(static_cast<UAbilitySystemComponent*>(Object), P->AbilityToActivate, P->InputPressed, P->PredictionKey, nullptr);
        return;
    }
    const bool Profiled = UiHitchProfile::Begin(Object, Function);
    Original<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(Object, Function, Parms);
    if (Profiled) UiHitchProfile::End();
    if (!Globals::AmServer) {
        AutoPressStart1147::OnProcessEvent(Object, Function);
        DeveloperStyle::OnProcessEvent(Object, Function);
        CellFusionTime::Tick();
        VendorTabs::OnProcessEvent(Object);
        NoPlatinumPrice::OnProcessEvent(Object);
    }
}

static HuntIdlePolicy HuntIdle;
static CityIdlePolicy CityIdle;
static bool IsCity = false;

extern "C" {
    __declspec(dllexport) volatile unsigned long long DR_ServerTickCount = 0;
}

// Only the client's login screen asks for the progression configuration. Without it, every
// joining player's UProgressionComponent parks for good (its resume delegate names no UFunction),
// HuntPass and the bounties wait behind it, and the player is dropped after 60 s. So the server
// asks itself, through the game's own UFunction, once the world exists and again until it has it
// (PORT-1.14.7/07-progression-loading.md).
static void KickProgressionConfiguration() {
    static ULONGLONG NextTry = 0;
    if (GetTickCount64() < NextTry) return;
    NextTry = GetTickCount64() + 10000;

    UWorld* World = UWorld::GetWorld();
    UGameInstance* Instance = World ? World->OwningGameInstance : nullptr;
    if (!Instance || !Instance->IsA(UArchonGameInstance::StaticClass())) return;
    auto* GameInstance = static_cast<UArchonGameInstance*>(Instance);
    if (GameInstance->HasQueriedProgressionConfiguration()) {
        NextTry = ~0ull; // done
        std::cout << "Progression configuration loaded" << std::endl;
        return;
    }
    std::cout << "Querying the progression configuration" << std::endl;
    GameInstance->QueryCurrentHuntPassSeasonData({});
}

// The replication pass runs at the start of UNetDriver::TickFlush, where the engine's own
// ServerReplicateActors would. This game uses push-model replication: blueprints mark properties
// dirty during the world tick and the marks are cleared at the end of the frame, so a pass after
// UGameEngine::Tick never saw a change (monster health, hit states). Found on 2.1.1
// (AwakeningInternal, 16 October 2026).
// One log line every 10 s: frames per second, engine and replication time, slowest frame.
static struct {
    unsigned long long Frames = 0, EngineMicros = 0, ReplicationMicros = 0, WorstMicros = 0, Attempts = 0;
    std::chrono::steady_clock::time_point Since = std::chrono::steady_clock::now();
} Perf;
extern "C" volatile unsigned long long DR_ActorReplicationAttempts;

static void ReportPerf() {
    const auto Now = std::chrono::steady_clock::now();
    const double Seconds = std::chrono::duration<double>(Now - Perf.Since).count();
    if (Seconds < 10 || !Perf.Frames) return;
    const unsigned long long Attempts = DR_ActorReplicationAttempts;
    char Line[256];
    sprintf_s(Line, "[perf] %.1f fps, engine tick %.1f ms (of which replication %.1f ms), slowest frame %.1f ms, %.0f actor updates/s",
        Perf.Frames / Seconds, Perf.EngineMicros / 1000.0 / Perf.Frames, Perf.ReplicationMicros / 1000.0 / Perf.Frames,
        Perf.WorstMicros / 1000.0, (Attempts - Perf.Attempts) / Seconds);
    std::cout << Line << std::endl;
    Perf = {};
    Perf.Since = Now;
    Perf.Attempts = Attempts;
}

static void* OrigTickFlush = nullptr;
static void TickFlushHook(UNetDriver* Driver, float DeltaSeconds) {
    if (Globals::Listening && Driver && Driver == Networking::NetDriver) {
        DR_TickStage = 2;
        const auto Start = std::chrono::steady_clock::now();
        Networking::TickNetworking();
        Perf.ReplicationMicros += std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - Start).count();
        DR_TickStage = 3;
    }
    Original<void(*)(UNetDriver*, float)>(OrigTickFlush)(Driver, DeltaSeconds);
}

static void* OrigEngineTick = nullptr;
static void EngineTickHook(UGameEngine* Engine, float DeltaTime, bool bIdleMode) {
    static const int FrameLimit = [] {
        wchar_t Setting[32] = {};
        const auto Length = GetEnvironmentVariableW(L"DR_SERVER_MAX_FPS", Setting, 32);
        return ParseServerFrameLimit(Length < 32 ? Setting : nullptr);
    }();
    static auto PreviousTick = std::chrono::steady_clock::now();
    if (FrameLimit > 0) {
        std::this_thread::sleep_until(PreviousTick + std::chrono::microseconds(1000000 / FrameLimit));
        PreviousTick = std::chrono::steady_clock::now();
    }

    DR_TickStage = 1;
    ++DR_ServerTickCount;
    const auto EngineStart = std::chrono::steady_clock::now();
    Original<void(*)(UGameEngine*, float, bool)>(OrigEngineTick)(Engine, DeltaTime, bIdleMode);
    HuntUnlock1147::Tick();
    CellFusionTime::Tick();
    const auto EngineMicros = std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - EngineStart).count();
    ++Perf.Frames;
    Perf.EngineMicros += EngineMicros;
    Perf.WorstMicros = (std::max)(Perf.WorstMicros, static_cast<unsigned long long>(EngineMicros));
    if (Globals::Listening) ReportPerf();


    ResolveAbilityFunctions();
    KickProgressionConfiguration();
    {
        UNetDriver* const ListeningDriver = Globals::Listening ? Networking::NetDriver : nullptr;
        FallRecovery::Tick(ListeningDriver, DeltaTime);
        ConnectedPlayers1147::Update(ListeningDriver);
    }

    if (Globals::DoListen) {
        Globals::DoListen = false;
        Globals::Listening = Networking::Listen(UEngine::GetEngine(), Globals::Port);
    }

    if (Globals::Listening && Networking::NetDriver) {
        bool HasConnection = false;
        int ActiveConnections = 0;
        for (UNetConnection* Connection : Networking::NetDriver->ClientConnections) {
            const auto State = Connection ? Networking::ConnectionState(Connection) : 0;
            if (State == 2 || State == 3) { // pending or open
                HasConnection = true;
                ++ActiveConnections;
            }
        }
        static auto PreviousIdleCheck = std::chrono::steady_clock::now();
        const auto Now = std::chrono::steady_clock::now();
        // Ramsgate: the player count, once a second, for the deploy server's city pool (as the 1.4.4 DLL).
        // Without it a city older than 3 minutes counts as full and every arrival gets a new Ramsgate.
        if (IsCity) {
            static auto NextOccupancyWrite = Now;
            if (Now >= NextOccupancyWrite) {
                NextOccupancyWrite = Now + std::chrono::seconds(1);
                wchar_t Directory[32768] = {};
                const auto Length = GetEnvironmentVariableW(L"GAMESERVER_READY_DIR", Directory, 32768);
                if (Length > 0 && Length < 32768) {
                    const auto File = std::filesystem::path(Directory) / (L"city-occupancy-" + std::to_wstring(GetCurrentProcessId()) + L".txt");
                    const auto Temporary = std::filesystem::path(File.wstring() + L".tmp");
                    { std::ofstream Output(Temporary); Output << GetCurrentProcessId() << " " << ActiveConnections << "\n"; }
                    MoveFileExW(Temporary.c_str(), File.c_str(), MOVEFILE_REPLACE_EXISTING);
                }
            }
        }
        const double Elapsed = std::chrono::duration<double>(Now - PreviousIdleCheck).count();
        PreviousIdleCheck = Now;
        const bool IdleExpired = IsCity ? CityIdle.Advance(Elapsed, HasConnection) : HuntIdle.Advance(Elapsed, HasConnection);
        if (IdleExpired) {
            std::cout << "Idle timeout on port " << Globals::Port << std::endl;
            DR_WriteDiagnostic("idle_timeout\n", 13);
            TerminateProcess(GetCurrentProcess(), 0);
        }

        // Stamina only regenerates when the server ticks it (as in the 1.4.4 DLL).
        for (UNetConnection* Connection : Networking::NetDriver->ClientConnections) {
            if (!Connection || !Connection->PlayerController || !Connection->PlayerController->Pawn)
                continue;
            auto* Pawn = Connection->PlayerController->Pawn;
            if (!Pawn->IsA(ABP_PlayerCharacter_C::StaticClass()) || Pawn->IsActorBeingDestroyed())
                continue;
            static_cast<ABP_PlayerCharacter_C*>(Pawn)->TickStamina(ECityExecFilter::Both, ERemoteExecFilter::All);
        }
    }
}

// ---------------------------------------------------------------- install

static void InstallSharedHooks() {
    using namespace Hooking;
    Hook("UseEOS", Addr::UseEOS, Prologue::UseEOS, UseEOSHook, &OrigUseEOS);
    Hook("EAC client init", Addr::EACClientInit, Prologue::EACClientInit, EACInitHook, &OrigEACInit);
    Hook("HasFinishedLoading", Addr::HasFinishedLoading, Prologue::HasFinishedLoading, HasFinishedLoadingHook, &OrigHasFinishedLoading);
    Hook("FConfigCacheIni::GetString", Addr::ConfigGetString, Prologue::ConfigGetString, ConfigGetStringHook, &OrigConfigGetString);
    HuntUnlock1147::Install();
}

static void InstallServerHooks() {
    using namespace Hooking;
    Hook("FCommandLine::Get", Addr::CommandLineGet, Prologue::CommandLineGet, CommandLineHook, &OrigCommandLine);
    Hook("GetGameDefaultMap", Addr::GetGameDefaultMap, Prologue::GetGameDefaultMap, GetDefaultMapHook, &OrigGetDefaultMap);
    Hook("UWorld::InternalGetNetMode", Addr::WorldInternalGetNetMode, Prologue::WorldInternalGetNetMode, NetModeHook, &OrigNetMode);
    Hook("UNetDriver::GetNetMode", Addr::NetDriverGetNetMode, Prologue::NetDriverGetNetMode, NetModeHook, &OrigNetDriverNetMode);
    Hook("UGameEngine::Tick", Addr::GameEngineTick, Prologue::GameEngineTick, EngineTickHook, &OrigEngineTick);
    Hook("UNetDriver::SetReplicationDriver", Addr::SetReplicationDriver, Prologue::SetReplicationDriver, SetReplicationDriverHook, &OrigSetReplicationDriver);
    Hook("UNetConnection::IsNetReady", Addr::ConnectionIsNetReady, Prologue::ConnectionIsNetReady, IsNetReadyHook, &OrigIsNetReady);
    Hook("UNetDriver::IsLevelInitializedForActor", Addr::IsLevelInitializedForActor, Prologue::IsLevelInitializedForActor,
        IsLevelInitializedForActorHook, &OrigIsLevelInitializedForActor);
    for (const auto& F : Patches::Called)
        if (!BytesMatch(F.Rva, F.Prologue)) Fail(F.Name, F.Rva, "unexpected bytes in a function the DLL calls");
    Hook("GetPlayerStartForPlayer", Addr::GetPlayerStartForPlayer, Prologue::GetPlayerStartForPlayer, GetStartSpotHook, &OrigGetStartSpot);
    Hook("FCurlHttpRequest::ProcessRequest", Addr::CurlProcessRequest, Prologue::CurlProcessRequest, ProcessRequestHook, &OrigProcessRequest);
    Hook("UObject::ProcessEvent", Addr::ProcessEvent, Prologue::ProcessEvent, ProcessEventHook, &OrigProcessEvent);
    Hook("UNetDriver::TickFlush", Addr::NetDriverTickFlush, Prologue::NetDriverTickFlush, TickFlushHook, &OrigTickFlush);
    Networking::InitChannelTracking();

    for (const auto& P : Patches::Server)
        Patch(P.Name, P.Rva, P.Expected, P.Replacement);
    CrashFixes1147::Apply();
}

static void OpenConsole() {
    FILE* Dummy;
    // DR_LOG_FILE sends the log to a file instead of a console window.
    wchar_t LogFile[MAX_PATH] = {};
    const auto Length = GetEnvironmentVariableW(L"DR_LOG_FILE", LogFile, MAX_PATH);
    FILE* Log = Length > 0 && Length < MAX_PATH ? _wfsopen(LogFile, L"w", _SH_DENYNO) : nullptr; // readable while running
    if (Log) {
        freopen_s(&Dummy, "NUL", "w", stdout);
        freopen_s(&Dummy, "NUL", "w", stderr);
        _dup2(_fileno(Log), _fileno(stdout));
        _dup2(_fileno(Log), _fileno(stderr));
        setvbuf(stdout, nullptr, _IONBF, 0);
    } else {
        AllocConsole();
        freopen_s(&Dummy, "CONOUT$", "w", stdout);
        freopen_s(&Dummy, "CONOUT$", "w", stderr);
        freopen_s(&Dummy, "CONIN$", "r", stdin);
    }
    std::cout << "Dauntless Revived " << UNDAUNTED_INTERNAL_VERSION << " for Dauntless 1.14.7 (based on Undaunted by gwog)" << std::endl;
}

static void MainThread() {
    while (!UWorld::GetWorld())
        Sleep(Globals::AmServer ? 1000 : 10);
    Sleep(3000);
    if (Globals::AmServer) {
        std::cout << "UWorld is live: " << UWorld::GetWorld()->GetFullName() << std::endl;
        Globals::DoListen = true;
    }
}

// DR_TRACE_FILE: one line per start-up step, written without the CRT (start-up diagnostics).
static void Trace(const char* Step) {
    wchar_t Path[MAX_PATH] = {};
    const auto Length = GetEnvironmentVariableW(L"DR_TRACE_FILE", Path, MAX_PATH);
    if (!Length || Length >= MAX_PATH) return;
    HANDLE File = CreateFileW(Path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, 0, nullptr);
    if (File == INVALID_HANDLE_VALUE) return;
    DWORD Written = 0;
    WriteFile(File, Step, static_cast<DWORD>(strlen(Step)), &Written, nullptr);
    WriteFile(File, "\r\n", 2, &Written, nullptr);
    CloseHandle(File);
}

static void Init() {
    Trace("init");
    Hooking::Base = reinterpret_cast<uintptr_t>(GetModuleHandleW(nullptr));
    Globals::AmServer = std::string(GetCommandLineA()).contains("-server");

    if (!Hooking::IsExpectedBuild(Build::SizeOfImage, Build::CheckSum)) {
        MessageBoxA(nullptr, "This DLL only supports the Dauntless 1.14.7 client (CL 647472).", "Dauntless Revived", MB_ICONERROR);
        return;
    }

    Trace("build ok");
    int NumArgs = 0;
    wchar_t** Args = CommandLineToArgvW(GetCommandLineW(), &NumArgs);
    Trace("args");

    if (Globals::AmServer) {
        // <apikey> <port> <map> <behemoth|NO_BEHEMOTH> <mmHuntId|NO_MM_HUNTID> <uid:hunt,...|NO_EXPECTED_PLAYERS> <ip:port> -server
        if (NumArgs <= 8) {
            MessageBoxA(nullptr, "INVALID GAMESERVER ARGS", "INVALID GAMESERVER ARGS", 0);
            ExitProcess(0);
        }
        Globals::ServerAPIKey = Args[1];
        Globals::Port = std::stoi(std::wstring(Args[2]));
        Globals::MapPath = Args[3];
        Globals::BehemothPath = Args[4];
        Globals::MatchmakerHuntId = Args[5];
        Globals::ExpectedPlayerString = Args[6];
        IsCity = std::wstring(Globals::MapPath).contains(L"/ramsgate/ramsgate_01_persistent");

        wchar_t Metagame[256] = {};
        const auto Length = GetEnvironmentVariableW(L"DR_METAGAME_ADDRESS", Metagame, 256);
        Globals::MetagameAddress = Length > 0 && Length < 256 ? Metagame : L"127.0.0.1:61000";

        OpenConsole();
        std::cout << "Running as a server on port " << Globals::Port << ", map " << std::string(Globals::MapPath, Globals::MapPath + wcslen(Globals::MapPath)) << std::endl;
        // The engine reads these before our hooks could intervene.
        *reinterpret_cast<uint8_t*>(Hooking::Base + Addr::GIsServer) = 1;
        *reinterpret_cast<uint8_t*>(Hooking::Base + Addr::GIsClient) = 0;
    } else {
        if (NumArgs > 2) Globals::MetagameAddress = Args[1];
        Social1147::Init(Globals::MetagameAddress);
        Trace("client args");
        OpenConsole();
        Trace("console");
        std::cout << "Running as a client, metagame " << std::string(Globals::MetagameAddress.begin(), Globals::MetagameAddress.end()) << std::endl;
    }

    if (!Globals::MetagameAddress.empty())
        BuildEndpointMap();

    Trace("endpoints");
    DR_InitDiagnostics();
    MH_Initialize();
    Trace("minhook");
    InstallSharedHooks();
    Trace("shared hooks");
    if (Globals::AmServer)
        InstallServerHooks();
    else {
        Hooking::Hook("FCommandLine::Get", Addr::CommandLineGet, Prologue::CommandLineGet, ClientCommandLineHook, &OrigCommandLine);
        // Client: press start, the F2 console, developer style, and the DR_TRACE_EVENTS diagnostic
        // (the ability RPCs stay unresolved here).
        Hooking::Hook("UObject::ProcessEvent", Addr::ProcessEvent, Prologue::ProcessEvent, ProcessEventHook, &OrigProcessEvent);
        // DR_PROFILE_UI=1: [ui-hitch] lines for frames of 500 ms or more (UiHitchProfile1147.h)
        if (UiHitchProfile::Enabled())
            Hooking::Hook("UGameEngine::Tick (ui profile)", Addr::GameEngineTick, Prologue::GameEngineTick,
                UiHitchProfile::EngineTickHook, &UiHitchProfile::OrigEngineTick);
    }

    if (Hooking::Failures)
        std::cout << Hooking::Failures << " hook(s) failed; see above." << std::endl;

    CreateThread(nullptr, 0, [](LPVOID) -> DWORD { MainThread(); return 0; }, nullptr, 0, nullptr);
}

BOOL APIENTRY DllMain(HMODULE Module, DWORD Reason, LPVOID)
{
    if (Reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(Module);
        Init();
    }
    return TRUE;
}
