#pragma once

// Seasonal event schedule on the 1.14.7 game server: keeps lore objects (and anything else gated by
// UTuningDataStatics::IsScheduledItemActive) alive on the server while an event runs.
// Evidence: PORT-1.14.7/19-lore-objects-event-vendor.md.
//
// lore_object_bp (and lore_object_robust_bp, its child) runs, in BeginPlay:
//     if (EventId != None && !IsScheduledItemActive(self, EventId, UtcNow())) K2_DestroyActor();
// The native (0x1DF96D0) looks the id up in UArchonGameInstance::TuningDataProvider (+0x7F0)
// ->SeasonalEventSchedule (+0x48, TArray<FScheduleData>, matched on the row's Name text) and is true only for
// StartTime <= now < EndTime; an id that is not in the array is false. That array is filled from
// GET /game_tuning/seasonal_event_schedule (UTuningDataProvider query 0x1E0CC50), which only clients ask for
// (metagame.log: "gs=0" only), and in any case after the levels' BeginPlay. So on the server every
// event-gated lore object destroys itself at load: the Unseen recruits of ramsgate_01_design (EventId
// EVENT_DARKHARVEST) and the five lore_object_bp of city_01_event_dark_harvest (EventId Dark_Harvest_Wreckage,
// _Icicle, _Stump, _Stream, _Trees). On a client the same K2_DestroyActor is refused (a replicated level actor
// is not ROLE_Authority there), and our replication loop does not send startup-actor destruction, so the
// client keeps them, shows them, and sends ServerStartInteraction with a stably named path the server can no
// longer find: "UPackageMapClient::InternalLoadObject: Unable to resolve default guid from client".
//
// Fix: detour the native and answer true for the ids of the running events, before the map loads (the hook is
// installed at DLL start, LoadMap runs BeginPlay later). Ids:
//   DR_SEASONAL_EVENTS, else SEASONAL_EVENTS (the metagame's variable, so one setting serves both), comma
//   separated; an entry ending in '*' is a prefix. When neither is set and DR_FEATURES turns
//   city_event_dark_harvest_bpff on, the Dark Harvest ids are used:
//   EVENT_DARKHARVEST,DarkHarvest,Dark_Harvest_*. EVENT_DARKHARVEST or DarkHarvest in a list implies Dark_Harvest_*.
// "-" (DR_SEASONAL_EVENTS=-) turns the override off. Each id forced on is logged once:
//   [schedule] forced on: <id>

#include <windows.h>
#include <cstdint>
#include <cstring>
#include <initializer_list>
#include <iostream>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

#include "Hooking.h"
#include "SDK.hpp"

namespace SeasonalSchedule1147 {

// bool UTuningDataStatics::IsScheduledItemActive(UObject* WorldContext, FName Id, FDateTime CurrentServerTime)
// (exec thunk 0x24EACE0 -> call 0x1DF96D0; FName and FDateTime are 8 bytes, passed in rdx / r8).
// The first 5 bytes are `mov [rsp+10h],rbx`: no RIP-relative operand, MinHook-safe.
inline constexpr uintptr_t IsScheduledItemActiveRva = 0x1DF96D0;
inline constexpr std::initializer_list<int> IsScheduledItemActivePrologue =
    {0x48, 0x89, 0x5C, 0x24, 0x10, 0x48, 0x89, 0x74, 0x24, 0x18, 0x57, 0x48, 0x81, 0xEC, 0x80, 0x01, 0x00, 0x00};

inline std::vector<std::string> Exact, Prefixes;
inline void* OrigIsScheduledItemActive = nullptr;
using IsScheduledItemActiveFn = bool (*)(SDK::UObject*, uint64_t, int64_t);

inline std::string Env(const char* Name) {
    char Value[4096] = {};
    const DWORD Length = GetEnvironmentVariableA(Name, Value, sizeof(Value));
    return Length > 0 && Length < sizeof(Value) ? std::string(Value) : std::string();
}

inline std::string Trim(const std::string& Text) {
    const auto Begin = Text.find_first_not_of(" \t\r\n");
    if (Begin == std::string::npos) return {};
    return Text.substr(Begin, Text.find_last_not_of(" \t\r\n") - Begin + 1);
}

inline std::string Lower(std::string Text) {
    for (char& C : Text) C = static_cast<char>(std::tolower(static_cast<unsigned char>(C)));
    return Text;
}

// The ids to force on, from the environment (see the header comment).
inline std::string ConfiguredList() {
    std::string List = Env("DR_SEASONAL_EVENTS");
    if (List.empty()) List = Env("SEASONAL_EVENTS");
    if (!List.empty()) return Trim(List) == "-" ? std::string() : List;

    // Default: the Dark Harvest ids when its Ramsgate decoration is on (a "-name" entry turns a flag off)
    std::stringstream Features(Env("DR_FEATURES"));
    for (std::string Entry; std::getline(Features, Entry, ',');) {
        Entry = Lower(Trim(Entry));
        if (Entry.ends_with("city_event_dark_harvest_bpff") && !Entry.starts_with("-"))
            return "EVENT_DARKHARVEST,DarkHarvest,Dark_Harvest_*";
    }
    return {};
}

inline bool IsForced(const std::string& Id) {
    const std::string L = Lower(Id);
    for (const auto& E : Exact) if (L == E) return true;
    for (const auto& P : Prefixes) if (L.starts_with(P)) return true;
    return false;
}

// Whether an id is forced, cached per FName (game thread only): each id is converted and matched once
inline bool IsForcedCached(uint64_t RawId) {
    static std::unordered_map<uint64_t, bool> Known;
    if (auto It = Known.find(RawId); It != Known.end()) return It->second;
    SDK::FName Id;
    std::memcpy(&Id, &RawId, sizeof(Id));
    const std::string Name = Id.IsNone() ? std::string() : Id.ToString();
    const bool Forced = !Name.empty() && IsForced(Name);
    if (Forced) std::cout << "[schedule] forced on: " << Name << std::endl;
    Known.emplace(RawId, Forced);
    return Forced;
}

inline bool IsScheduledItemActiveHook(SDK::UObject* WorldContext, uint64_t RawId, int64_t NowTicks) {
    return reinterpret_cast<IsScheduledItemActiveFn>(OrigIsScheduledItemActive)(WorldContext, RawId, NowTicks)
        || IsForcedCached(RawId);
}

// Servers only: clients get their schedule from the metagame (SEASONAL_EVENTS) and cannot destroy level actors.
inline void Install() {
    static_assert(sizeof(SDK::FName) == 8, "FName must be passed in a register");
    const std::string List = ConfiguredList();
    std::stringstream Entries(List);
    for (std::string Entry; std::getline(Entries, Entry, ',');) {
        Entry = Lower(Trim(Entry));
        if (Entry.empty()) continue;
        if (Entry.ends_with("*")) Prefixes.push_back(Entry.substr(0, Entry.size() - 1));
        else Exact.push_back(Entry);
    }
    // The Dark Harvest level's own lore objects use per-object ids (Dark_Harvest_Wreckage, ...): the event id
    // alone (the metagame's usual SEASONAL_EVENTS=EVENT_DARKHARVEST,DarkHarvest) covers them too.
    for (const auto& E : std::vector<std::string>(Exact))
        if (E == "event_darkharvest" || E == "darkharvest") { Prefixes.push_back("dark_harvest_"); break; }
    if (Exact.empty() && Prefixes.empty()) return; // nothing to force: the game's own answer stands
    std::cout << "[schedule] seasonal events forced on: " << List << std::endl;
    Hooking::Hook("UTuningDataStatics::IsScheduledItemActive", IsScheduledItemActiveRva, IsScheduledItemActivePrologue,
        IsScheduledItemActiveHook, &OrigIsScheduledItemActive);
}

}
