#pragma once

// Hunt unlocks and the weekly Trials for Dauntless 1.14.7: the port of the 1.4.4 DLL's
// GetEscalationSeason hook (UHuntCatalog::IsHuntUnlocked, 1.4.4 RVA 0x14F2A30) and TrialsSchedule.h.
// Evidence and open questions: PORT-1.14.7/11-hunts-trials.md.
//
//  - IsHuntUnlocked: Arena (Trials player hunts) and Escalation hunts get the game's unlock requirements
//    (Slayer's Path nodes, quests, ranks) without its schedule test, whose rows expired. A weekly Trial row
//    (Arena_MatchmakerHunt_{Hard,Elite}_NNN) passes only when it is this week's row, because the Trials
//    screen shows the first row the catalog accepts. Everything else keeps the game's own rule.
//    1.14.7 also asks the player's USchedulerComponent whether the hunt id is scheduled
//    (Scheduler->IsAvailable), so an expired schedule locks a hunt even when its quests are done.
//  - The Trials schedule: the cooked gen_arena_hunts_schedule rows ended long ago. Rewrite the weekly
//    "Scheduled_Arena_Hunt_*" rows in memory to cover last week and the weeks ahead with the servers'
//    pick (TrialsRotation.h, shared with the deploy server and the metagame). 1.14.7 also cooks a
//    gen_arena_hunts_schedule_new table; both are patched when they hold such rows.
//
// The rotation itself is the 1.4.4 header, included as is (pure C++, no SDK), so the pool stays the
// one the deploy server test checks. 1.14.7 differences are guarded: a pool row that no loaded
// matchmaker table contains is left untouched and reported (hunt_trials pool_row_missing).
//
// Runs on the game thread only: Tick() is called from the IsHuntUnlocked detour (client and server)
// and from the server's UGameEngine::Tick hook.

#include <windows.h>
#include <algorithm>
#include <chrono>
#include <cstring>
#include <initializer_list>
#include <cstdint>
#include <cstdio>
#include <ctime>
#include <iostream>
#include <set>
#include <string>
#include <vector>

#include "Hooking.h"
#include "NativeDiagnostics.h"
#include "SDK.hpp"
#include "../UndauntedInternalServer/TrialsRotation.h"

namespace HuntUnlock1147 {

// UHuntCatalog::IsHuntUnlocked native body (05-addresses-misc.md item 6c; exec thunk 0x23EFA30).
// bool f(const UHuntCatalog* this, const FString& HuntID, const FHunt_UnlockInfo& Unlock,
//        const FHunt_UnlockInfo& AltUnlock, AArchonPlayerController* PC)   PC at [rsp+0x28].
// The first 5 bytes are `mov [rsp+8],rbx`: no RIP-relative operand, MinHook-safe.
inline constexpr uintptr_t IsHuntUnlockedRva = 0x1B2F8D0;
inline constexpr std::initializer_list<int> IsHuntUnlockedPrologue =
    {0x48, 0x89, 0x5C, 0x24, 0x08, 0x48, 0x89, 0x6C, 0x24, 0x10, 0x48, 0x89, 0x74, 0x24, 0x18, 0x57};

inline void Log(const char* Line) {
    std::cout << Line;
    DR_WriteDiagnostic(Line, static_cast<DWORD>(strlen(Line)));
}

inline int64_t NowUnix() { return static_cast<int64_t>(std::time(nullptr)); }
inline int64_t& Ticks(SDK::FDateTime& Time) { return *reinterpret_cast<int64_t*>(&Time); }

// ------------------------------------------------------------------ data tables

inline std::vector<SDK::UDataTable*> FindDataTables(bool (*Accept)(const std::string&)) {
    std::vector<SDK::UDataTable*> Out;
    SDK::UClass* TableClass = SDK::UDataTable::StaticClass();
    for (int I = 0; I < SDK::UObject::GObjects->Num(); ++I) {
        SDK::UObject* Object = SDK::UObject::GObjects->GetByIndex(I);
        if (!Object || !Object->IsA(TableClass) || Object->IsDefaultObject())
            continue;
        if (Accept(Object->GetName()))
            Out.push_back(static_cast<SDK::UDataTable*>(Object));
    }
    return Out;
}

inline bool IsScheduleTable(const std::string& Name) { return Name.starts_with("gen_arena_hunts_schedule"); }
inline bool IsMatchmakerTable(const std::string& Name) { return Name.find("matchmaker_hunts") != std::string::npos; }

// The weekly rows of one schedule table in name order (the daily test rows stay expired).
inline std::vector<std::pair<std::string, SDK::FScheduleData*>> WeeklyRows(SDK::UDataTable* Table) {
    std::vector<std::pair<std::string, SDK::FScheduleData*>> Rows;
    auto& Map = Table->RowMap;
    for (int I = 0; I < Map.NumAllocated(); ++I) {
        if (!Map.IsValidIndex(I) || !Map[I].Value())
            continue;
        std::string Name = Map[I].Key().ToString();
        if (Name.starts_with("Scheduled_Arena_Hunt_"))
            Rows.emplace_back(std::move(Name), reinterpret_cast<SDK::FScheduleData*>(Map[I].Value()));
    }
    std::sort(Rows.begin(), Rows.end(), [](auto& A, auto& B) { return A.first < B.first; });
    return Rows;
}

// Every row name of the loaded matchmaker hunt tables (empty when none is loaded yet).
inline std::set<std::string> MatchmakerRowNames() {
    std::set<std::string> Names;
    for (SDK::UDataTable* Table : FindDataTables(IsMatchmakerTable)) {
        auto& Map = Table->RowMap;
        for (int I = 0; I < Map.NumAllocated(); ++I)
            if (Map.IsValidIndex(I))
                Names.insert(Map[I].Key().ToString());
    }
    return Names;
}

// ------------------------------------------------------------------ Trials schedule

struct PatchedTable { SDK::UDataTable* Table; int32_t Index; int64_t FirstTicks; };
inline std::vector<PatchedTable> Patched;
inline std::chrono::steady_clock::time_point NextCheck{};
inline int MissingChecks = 0;
inline bool DumpedOnce = false;

inline void DumpTable(SDK::UDataTable* Table, const std::vector<std::pair<std::string, SDK::FScheduleData*>>& Rows) {
    // Once per process: what 1.14.7 cooked, so the rotation can be checked against it.
    char Line[512];
    sprintf_s(Line, "hunt_trials table=%s weekly_rows=%zu\n", Table->GetName().c_str(), Rows.size());
    Log(Line);
    for (size_t K = 0; K < Rows.size() && K < 4; ++K) {
        std::string Items;
        for (int I = 0; I < Rows[K].second->ScheduledItems.Num(); ++I)
            Items += (I ? "," : "") + Rows[K].second->ScheduledItems[I].ID.ToString();
        sprintf_s(Line, "hunt_trials row=%s items=%.400s\n", Rows[K].first.c_str(), Items.c_str());
        Log(Line);
    }
}

inline bool Patch(SDK::UDataTable* Table, const std::set<std::string>& Known) {
    auto Rows = WeeklyRows(Table);
    if (Rows.empty())
        return false;
    if (!DumpedOnce) DumpTable(Table, Rows);

    // Row 0 is last week, so the leaderboard's Previous tab resolves too.
    const int64_t FirstWeek = TrialsRotation::WeekAt(NowUnix()) - 1;
    int Missing = 0;

    for (size_t K = 0; K < Rows.size(); ++K) {
        const int64_t Week = FirstWeek + static_cast<int64_t>(K);
        const std::string Suffix = TrialsRotation::SuffixForWeek(Week);
        SDK::FScheduleData* Row = Rows[K].second;

        Ticks(Row->StartTime) = TrialsRotation::UnixToTicks(TrialsRotation::WeekStartUnix(Week));
        Ticks(Row->EndTime) = TrialsRotation::UnixToTicks(TrialsRotation::WeekStartUnix(Week + 1));
        Row->IsRepeatable = false;

        for (int I = 0; I < Row->ScheduledItems.Num(); ++I) {
            auto& Item = Row->ScheduledItems[I];
            const std::string Current = Item.ID.ToString();
            const char* Difficulty = Current.contains("_Elite_") ? "Elite" : Current.contains("_Hard_") ? "Hard" : nullptr;
            if (!Difficulty)
                continue;

            const std::string Id = std::string("Arena_MatchmakerHunt_") + Difficulty + "_" + Suffix;
            if (!Known.empty() && !Known.contains(Id)) { ++Missing; continue; } // keep the cooked id
            const std::wstring WideId(Id.begin(), Id.end());
            Item.ID = SDK::UKismetStringLibrary::Conv_StringToName(SDK::FString(WideId.c_str()));
        }
    }

    Patched.push_back({Table, Table->Index, Ticks(Rows[0].second->StartTime)});
    char Line[320];
    sprintf_s(Line, "hunt_trials patched table=%s rows=%zu first_week=%lld current=%s (%s) verify=%s pool_row_missing=%d\n",
        Table->GetName().c_str(), Rows.size(), static_cast<long long>(FirstWeek),
        TrialsRotation::SuffixForWeek(FirstWeek + 1).c_str(), TrialsRotation::BehemothForWeek(FirstWeek + 1).c_str(),
        Known.empty() ? "none-loaded" : "matchmaker-tables", Missing);
    Log(Line);
    return true;
}

inline bool StillPatched() {
    if (Patched.empty())
        return false;
    for (const auto& P : Patched) {
        // Compare by the remembered GObjects slot so a freed table is never dereferenced.
        if (SDK::UObject::GObjects->GetByIndex(P.Index) != P.Table)
            return false;
        auto Rows = WeeklyRows(P.Table);
        if (Rows.empty() || Ticks(Rows[0].second->StartTime) != P.FirstTicks)
            return false;
    }
    return true;
}

// Cheap after the first patch: re-checks every 30 s that the tables are still patched.
inline void Tick() {
    const auto Now = std::chrono::steady_clock::now();
    if (Now < NextCheck)
        return;
    NextCheck = Now + std::chrono::seconds(Patched.empty() ? 2 : 30);
    if (StillPatched())
        return;

    Patched.clear();
    auto Tables = FindDataTables(IsScheduleTable);
    if (!Tables.empty()) {
        const auto Known = MatchmakerRowNames();
        for (SDK::UDataTable* Table : Tables)
            Patch(Table, Known);
        DumpedOnce = true;
    }

    if (Patched.empty() && ++MissingChecks == 30)
        Log("hunt_trials table_missing\n");
}

// This week's row as the server's scheduler replicated it to this player, or "".
inline std::string ReplicatedTrialSuffix(SDK::AArchonPlayerController* PC) {
    if (!PC)
        return {};
    SDK::USchedulerComponent* Scheduler = PC->GetSchedulerComponent();
    if (!Scheduler)
        return {};

    const int64_t NowTicks = TrialsRotation::UnixToTicks(NowUnix());
    std::string Best;
    int64_t BestEnd = 0;
    auto& Items = Scheduler->AvailableScheduledItems;
    for (int I = 0; I < Items.Num(); ++I) {
        std::string Suffix;
        if (!TrialsRotation::TrialRowSuffix(Items[I].ID.ToString(), Suffix) || Items[I].EndTime <= NowTicks)
            continue;
        if (Best.empty() || Items[I].EndTime < BestEnd) {
            Best = Suffix;
            BestEnd = Items[I].EndTime;
        }
    }
    return Best;
}

// For a weekly Trial row id: only this week's row. Handled = false for any other hunt id.
inline bool IsTrialRowUnlocked(const std::string& HuntId, SDK::AArchonPlayerController* PC, bool& Handled) {
    std::string Suffix;
    Handled = TrialsRotation::TrialRowSuffix(HuntId, Suffix);
    if (!Handled)
        return false;

    std::string Current = ReplicatedTrialSuffix(PC);
    if (Current.empty()) {
        // Same pick from this machine's clock, computed once per week (the screen asks for every row).
        static int64_t CachedWeek = INT64_MIN;
        static std::string CachedSuffix;
        const int64_t Week = TrialsRotation::WeekAt(NowUnix());
        if (Week != CachedWeek) {
            CachedSuffix = TrialsRotation::SuffixForWeek(Week);
            CachedWeek = Week;
        }
        Current = CachedSuffix;
    }
    return Suffix == Current;
}

// ------------------------------------------------------------------ IsHuntUnlocked

inline void* OrigIsHuntUnlocked = nullptr;
using IsHuntUnlockedFn = bool (*)(SDK::UHuntCatalog*, SDK::FString*, SDK::FHunt_UnlockInfo*, SDK::FHunt_UnlockInfo*, SDK::AArchonPlayerController*);

// The two steps of the native after its schedule test (disassembly of 0x1B2F8D0):
//   bool Check(UHuntCatalog*, const FHunt_UnlockInfo*, AArchonPlayerController*, const FString* HuntID)  0x1B1EAE0
//     (quests, item, ranks, feature flag, event, Slayer's Path nodes)
//   bool Equals(const FHunt_UnlockInfo*, const FHunt_UnlockInfo*)  0x1B124B0, against the empty default at 0x69BF580:
//     an empty AltUnlock is not checked.
inline constexpr uintptr_t CheckUnlockInfoRva = 0x1B1EAE0;
inline constexpr std::initializer_list<int> CheckUnlockInfoPrologue =
    {0x48, 0x89, 0x5C, 0x24, 0x08, 0x4C, 0x89, 0x4C, 0x24, 0x20, 0x55, 0x56, 0x57};
inline constexpr uintptr_t UnlockInfoEqualsRva = 0x1B124B0;
inline constexpr std::initializer_list<int> UnlockInfoEqualsPrologue =
    {0x48, 0x89, 0x5C, 0x24, 0x10, 0x48, 0x89, 0x6C, 0x24, 0x18, 0x48, 0x89, 0x74, 0x24, 0x20, 0x57};
inline constexpr uintptr_t EmptyUnlockInfoRva = 0x69BF580;
inline bool UnlockChecksFound = false;

// The game's own rule without the schedule: Check(Unlock), or Check(Unlock) || Check(AltUnlock)
inline bool RequirementsMet(SDK::UHuntCatalog* Catalog, SDK::FString* HuntID, SDK::FHunt_UnlockInfo* Unlock,
                            SDK::FHunt_UnlockInfo* AltUnlock, SDK::AArchonPlayerController* PC) {
    using CheckFn = bool (*)(SDK::UHuntCatalog*, SDK::FHunt_UnlockInfo*, SDK::AArchonPlayerController*, SDK::FString*);
    using EqualsFn = bool (*)(SDK::FHunt_UnlockInfo*, const void*);
    const auto Check = reinterpret_cast<CheckFn>(Hooking::At(CheckUnlockInfoRva));
    const auto Equals = reinterpret_cast<EqualsFn>(Hooking::At(UnlockInfoEqualsRva));
    if (Check(Catalog, Unlock, PC, HuntID)) return true;
    return !Equals(AltUnlock, Hooking::At(EmptyUnlockInfoRva)) && Check(Catalog, AltUnlock, PC, HuntID);
}

// Logs each distinct hunt id once (bounded), so the user's log shows which ids 1.14.7 asks about.
inline void Report(const std::string& Id, const char* Rule, bool Result) {
    static std::set<std::string> Seen;
    if (Seen.size() >= 400 || !Seen.insert(Id).second)
        return;
    char Line[256];
    sprintf_s(Line, "hunt_unlock id=%.180s rule=%s unlocked=%d\n", Id.c_str(), Rule, Result ? 1 : 0);
    Log(Line);
}

inline bool IsHuntUnlockedHook(SDK::UHuntCatalog* Catalog, SDK::FString* HuntID, SDK::FHunt_UnlockInfo* Unlock,
                               SDK::FHunt_UnlockInfo* AltUnlock, SDK::AArchonPlayerController* PC) {
    Tick();
    const std::string Id = HuntID ? HuntID->ToString() : std::string();

    bool IsTrialRow = false;
    const bool TrialRowUnlocked = IsTrialRowUnlocked(Id, PC, IsTrialRow);
    if (IsTrialRow) {
        // This week's row only, and only once the game's own requirements (Slayer's Path nodes) are met
        const bool Result = TrialRowUnlocked && (!UnlockChecksFound || (PC && PC->QuestSystem && RequirementsMet(Catalog, HuntID, Unlock, AltUnlock, PC)));
        Report(Id, "trial_week", Result);
        return Result;
    }

    // Arena (Trials) and Escalation hunts: their schedule rows expired in 2022, so the native's schedule test
    // locks them for good. They get the game's unlock requirements without that test, so the Slayer's Path
    // nodes (and quests, ranks...) still decide; the 1.4.4 DLL unlocked them outright. The native returns
    // false without a player controller or quest system, so that guard stays.
    // The Gauntlet keeps the game's rule: its backend (gauntlet-*) answers "no season running".
    if (UnlockChecksFound && PC && PC->QuestSystem && !Id.contains("Gauntlet") && (Id.contains("Arena") || Id.contains("Esca"))) {
        const bool Result = RequirementsMet(Catalog, HuntID, Unlock, AltUnlock, PC);
        Report(Id, "unscheduled", Result);
        return Result;
    }

    const bool Result = reinterpret_cast<IsHuntUnlockedFn>(OrigIsHuntUnlocked)(Catalog, HuntID, Unlock, AltUnlock, PC);
    Report(Id, "game", Result);
    return Result;
}

// Call once from InstallSharedHooks (client and server).
inline void Install() {
    // Without the two helpers, Arena and Escalation hunts keep the game's full rule (locked by their schedule)
    UnlockChecksFound = Hooking::BytesMatch(CheckUnlockInfoRva, CheckUnlockInfoPrologue)
        && Hooking::BytesMatch(UnlockInfoEqualsRva, UnlockInfoEqualsPrologue);
    if (!UnlockChecksFound) Hooking::Fail("hunt unlock checks", CheckUnlockInfoRva, "unexpected bytes in a function the DLL calls");
    Hooking::Hook("UHuntCatalog::IsHuntUnlocked", IsHuntUnlockedRva, IsHuntUnlockedPrologue, IsHuntUnlockedHook, &OrigIsHuntUnlocked);
}

}
