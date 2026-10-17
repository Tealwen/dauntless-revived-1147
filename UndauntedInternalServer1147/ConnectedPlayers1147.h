#pragma once

// x-dauntless-game-session-id / x-dauntless-connected-player-ids on the game server's HTTP requests, for 1.14.7.
// Port of UpdateConnectedPlayerSnapshot and the ProcessRequest header code of the 1.4.4 dllmain.cpp; the
// engine-independent part is ConnectedPlayerSnapshot.h (already in this folder, identical to 1.4.4).
//
// The metagame reads them only in POST /candidate/player/alive (routes/matchmaking.ts, the game's
// ExpectedPlayerStatusEndpoint / KeepAlivePlayerStatusEndpoint): with a valid session id and a complete snapshot,
// MatchmakingRoster.reconcileExpected drops party members who never arrived or left; without them the roster is
// returned unchanged (legacy behaviour: nothing breaks, no-shows are just never removed from the expected list).
//
// Server only. Update() on the game thread after every engine tick; AddHeaders() from the CurlProcessRequest hook.
// An HTTP worker only ever sees a copied string under a mutex.

#include <windows.h>
#include <array>
#include <string>
#include <string_view>
#include <vector>

#include "SDK.hpp"
#include "Addresses1147.h"
#include "ConnectedPlayerSnapshot.h"
#include "EngineString.h"
#include "Hooking.h"

namespace ConnectedPlayers1147 {
using namespace SDK;

inline ConnectedPlayerSnapshot::Cache Cache;

// The deploy server names the ready file <game session uuid>.ready (UndauntedDeployServer gameservers.ts).
inline const std::wstring& GameSessionId() {
    static const std::wstring Id = [] {
        static wchar_t ReadyFile[32768] = {};
        const auto Length = GetEnvironmentVariableW(L"DR_SERVER_READY_FILE", ReadyFile, 32768);
        return Length > 0 && Length < 32768
            ? ConnectedPlayerSnapshot::SessionIdFromReadyFile(std::wstring_view(ReadyFile, Length)) : std::wstring{};
    }();
    return Id;
}

inline uint32_t StateOf(UNetConnection* Connection) {
    return *reinterpret_cast<const uint32_t*>(reinterpret_cast<uintptr_t>(Connection) + Off::ConnectionState);
}

// Driver: our listening driver, or nullptr while not listening.
// 1.4.4 also required World->NetDriver == Driver. Not here: on 1.14.7 the engine rewrites World->NetDriver from the
// level collections during the world tick (README, fix 4), so that check is not a reliable sign of a stale driver.
inline void Update(UNetDriver* Driver) {
    if (GameSessionId().empty()) return;
    const auto Now = GetTickCount64();
    static ULONGLONG NextCapture = 0;
    static std::vector<std::array<std::uintptr_t, 4>> PreviousShape;
    UWorld* World = UWorld::GetWorld();
    if (!Driver || !World || Driver->World != World || Driver->ServerConnection) {
        Cache.Publish({}, Now);
        NextCapture = 0;
        return;
    }

    std::vector<std::array<std::uintptr_t, 4>> Shape;
    std::vector<UNetConnection*> Active;
    bool Complete = true;
    int ConnectionCount = 0;
    const auto Inspect = [&](UNetConnection* Connection) {
        if (!Connection || ++ConnectionCount > ConnectedPlayerSnapshot::MaxConnections) {
            Complete = false;
            return;
        }
        const uint32_t State = StateOf(Connection);
        if (State != 2 && State != 3) {
            Shape.push_back({reinterpret_cast<uintptr_t>(Connection), 0, 0, State});
            if (State != 1) Complete = false; // only USOCK_Closed is known inactive
            return; // a closed/unknown connection may keep stale controller fields
        }
        auto* Controller = Connection->PlayerController;
        auto* PlayerState = Controller ? Controller->PlayerState : nullptr;
        Shape.push_back({reinterpret_cast<uintptr_t>(Connection), reinterpret_cast<uintptr_t>(Controller),
            reinterpret_cast<uintptr_t>(PlayerState), State});
        if (!Controller || !PlayerState
            || !Controller->IsA(AArchonPlayerController::StaticClass())
            || !PlayerState->IsA(AArchonPlayerState::StaticClass())) {
            Complete = false;
            return;
        }
        Active.push_back(Connection);
    };
    const auto ValidCount = [](const auto& Connections) {
        const int Count = Connections.Num();
        return Count >= 0 && Count <= ConnectedPlayerSnapshot::MaxConnections && (Count == 0 || Connections.IsValid());
    };
    if (!ValidCount(Driver->ClientConnections)) Complete = false;
    else for (UNetConnection* Connection : Driver->ClientConnections) {
        Inspect(Connection);
        if (!Connection) continue;
        if (!ValidCount(Connection->Children)) { Complete = false; continue; }
        for (UChildConnection* Child : Connection->Children) {
            Inspect(Child);
            // Child connections are one level deep; anything else makes the snapshot incomplete.
            if (!Child || Child->Parent != Connection || Child->Children.Num() != 0) Complete = false;
        }
    }
    if (!Complete) {
        Cache.Publish({}, Now);
        NextCapture = 0;
        return;
    }
    if (Now < NextCapture && Shape == PreviousShape) return;

    ConnectedPlayerSnapshot::Builder Snapshot;
    if (!Active.empty() && (!UArchonGameplayStatics::StaticClass()
        || !UArchonGameplayStatics::StaticClass()->GetFunction("ArchonGameplayStatics", "IsValidNetId")
        || !UArchonGameplayStatics::GetDefaultObj())) {
        Cache.Publish({}, Now);
        PreviousShape = std::move(Shape);
        NextCapture = Now + 1000;
        return;
    }
    for (UNetConnection* Connection : Active) {
        auto* PlayerState = static_cast<AArchonPlayerState*>(Connection->PlayerController->PlayerState);
        if (!PlayerState->Class->GetFunction("ArchonPlayerState", "GetUniqueIdAsString")
            || !UArchonGameplayStatics::IsValidNetId(PlayerState->UniqueId)) {
            Snapshot.Invalidate();
            break;
        }
        FString Id = PlayerState->GetUniqueIdAsString();
        const bool Valid = Id.IsValid() && Id.Num() >= 2
            && Id.Num() <= static_cast<int>(ConnectedPlayerSnapshot::MaxPlayerIdLength + 1)
            && Id.CStr()[Id.Num() - 1] == L'\0';
        if (Valid) Snapshot.AddConnection(3, std::wstring_view(Id.CStr(), Id.Num() - 1)); // copies the id
        // The returned FString was allocated by the engine and Dumper-7's FString never frees it.
        if (Id.CStr()) EngineString::Realloc(Id.CStr(), 0);
        if (!Valid) {
            Snapshot.Invalidate();
            break;
        }
    }
    Cache.Publish(Snapshot.Header(), Now);
    PreviousShape = std::move(Shape);
    NextCapture = Now + 1000;
}

// FCurlHttpRequest::SetHeader copies both strings, so stack FStrings are fine here (as for the apikey header).
inline void AddHeaders(void* Request) {
    const auto& SessionId = GameSessionId();
    if (SessionId.empty()) return;
    const auto SetHeader = reinterpret_cast<void(*)(void*, FString*, FString*)>(Hooking::Base + Addr::CurlSetHeader);
    const std::wstring Snapshot = Cache.Read(GetTickCount64());
    FString SessionHeader(L"x-dauntless-game-session-id");
    FString SessionValue(SessionId.c_str());
    FString ConnectedHeader(L"x-dauntless-connected-player-ids");
    FString ConnectedValue(Snapshot.c_str());
    SetHeader(Request, &SessionHeader, &SessionValue);
    // Always set, so a reused/retried request loses an old value. Empty (invalid JSON) means unknown; [] means empty.
    SetHeader(Request, &ConnectedHeader, &ConnectedValue);
}

}
