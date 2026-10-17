#pragma once
// Diagnostic for the 1.4 s freeze when the quest menu (quest_menu_screen_bpw) opens
// (PORT-1.14.7/17-quest-menu-hitch.md). Client only, OFF unless DR_PROFILE_UI is set:
//   DR_PROFILE_UI=1      report frames longer than 500 ms
//   DR_PROFILE_UI=<ms>   report frames longer than <ms> ms (minimum 50)
// While on, it counts every ProcessEvent the client runs, per (object class, function), with inclusive and self
// time, and resets the counts at every UGameEngine::Tick. When the time between two engine ticks is longer than the
// threshold, it prints (stdout, so client.log with DR_LOG_FILE) the frame length, the time spent inside
// UGameEngine::Tick and inside ProcessEvent, how far the GObjects array grew, and the top entries by time and by
// call count. Every widget instance runs its PreConstruct/Construct events through ProcessEvent, so the
// "Construct" rows give how many widgets of each class the frame created.
// Cost when off: one int test per ProcessEvent and per engine tick.
//
// Wiring (dllmain.cpp, client branch only):
//   #include "UiHitchProfile1147.h"
//   in ProcessEventHook, around the Original(...) call:
//       const bool Profiled = UiHitchProfile::Begin(Object, Function);
//       Original<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(Object, Function, Parms);
//       if (Profiled) UiHitchProfile::End();
//   in Init(), client else-branch, after the ProcessEvent hook:
//       if (UiHitchProfile::Enabled())
//           Hooking::Hook("UGameEngine::Tick (ui profile)", Addr::GameEngineTick, Prologue::GameEngineTick,
//               UiHitchProfile::EngineTickHook, &UiHitchProfile::OrigEngineTick);
// Addr::GameEngineTick / Prologue::GameEngineTick are the existing server entries (0x3E10AB0, checked bytes);
// the client never hooked that function before, so there is no clash.

#include <windows.h>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <iostream>
#include <string>
#include <unordered_map>
#include <vector>

#include "SDK.hpp"

namespace UiHitchProfile {

inline const int ThresholdMs = [] {
    wchar_t Value[16] = {};
    const DWORD Length = GetEnvironmentVariableW(L"DR_PROFILE_UI", Value, 16);
    if (Length == 0 || Length >= 16) return 0;
    const int Ms = _wtoi(Value);
    if (Ms <= 0) return 0;
    return Ms == 1 ? 500 : (Ms < 50 ? 50 : Ms);
}();
inline bool Enabled() { return ThresholdMs > 0; }

struct FKey {
    SDK::UClass* Class;
    SDK::UFunction* Function;
    bool operator==(const FKey& Other) const { return Class == Other.Class && Function == Other.Function; }
};
struct FKeyHash {
    size_t operator()(const FKey& Key) const {
        return reinterpret_cast<uintptr_t>(Key.Class) * 0x9E3779B97F4A7C15ull ^ reinterpret_cast<uintptr_t>(Key.Function);
    }
};
struct FStat {
    uint32_t Calls = 0;
    int64_t Inclusive = 0;
    int64_t Self = 0;
    int32_t ClassIndex = -1;
    int32_t FunctionIndex = -1;
};
struct FScope { FKey Key; int64_t Start; int64_t Children; };

inline std::unordered_map<FKey, FStat, FKeyHash> Stats;
inline std::vector<FScope> Stack;
inline DWORD GameThread = 0;
inline int64_t FrameStart = 0;
inline int64_t EngineTime = 0;   // inside UGameEngine::Tick this frame
inline int64_t EventTime = 0;    // inside outermost ProcessEvent calls this frame
inline uint64_t EventCalls = 0;
inline int32_t ObjectsAtStart = 0;
inline void* OrigEngineTick = nullptr;

inline int64_t Now() { LARGE_INTEGER Counter; QueryPerformanceCounter(&Counter); return Counter.QuadPart; }
inline const int64_t Frequency = [] { LARGE_INTEGER F; QueryPerformanceFrequency(&F); return F.QuadPart; }();
inline double Ms(int64_t Ticks) { return static_cast<double>(Ticks) * 1000.0 / static_cast<double>(Frequency); }

// Call before the original ProcessEvent. True when End() must be called after it.
inline bool Begin(SDK::UObject* Object, SDK::UFunction* Function) {
    if (!Enabled() || !GameThread || GetCurrentThreadId() != GameThread || Stack.size() > 512)
        return false;
    Stack.push_back({ { Object ? Object->Class : nullptr, Function }, Now(), 0 });
    return true;
}

inline void End() {
    if (Stack.empty())
        return;
    const FScope Scope = Stack.back();
    Stack.pop_back();
    const int64_t Elapsed = Now() - Scope.Start;
    FStat& Stat = Stats[Scope.Key];
    if (Stat.Calls == 0) {
        Stat.ClassIndex = Scope.Key.Class ? Scope.Key.Class->Index : -1;
        Stat.FunctionIndex = Scope.Key.Function ? Scope.Key.Function->Index : -1;
    }
    ++Stat.Calls;
    Stat.Inclusive += Elapsed;
    Stat.Self += Elapsed - Scope.Children;
    if (!Stack.empty())
        Stack.back().Children += Elapsed;
    else {
        EventTime += Elapsed;
        ++EventCalls;
    }
}

// Names are read only if the GObjects slot still holds the same object (a class could be gone by now).
inline std::string NameOf(SDK::UObject* Object, int32_t Index) {
    if (!Object || Index < 0 || SDK::UObject::GObjects->GetByIndex(Index) != Object)
        return Object ? "<gone>" : "<null>";
    return Object->GetName();
}

inline void PrintTop(const char* Title, std::vector<std::pair<FKey, FStat>>& Rows, bool ByCalls, size_t Count) {
    std::sort(Rows.begin(), Rows.end(), [ByCalls](const auto& A, const auto& B) {
        return ByCalls ? A.second.Calls > B.second.Calls : A.second.Inclusive > B.second.Inclusive;
    });
    std::cout << "[ui-hitch]   top by " << Title << ":\n";
    for (size_t I = 0; I < Rows.size() && I < Count; ++I) {
        const auto& [Key, Stat] = Rows[I];
        char Line[512] = {};
        sprintf_s(Line, "[ui-hitch]     %6u calls  incl %8.1f ms  self %8.1f ms  %s::%s\n", Stat.Calls, Ms(Stat.Inclusive),
            Ms(Stat.Self), NameOf(Key.Class, Stat.ClassIndex).c_str(), NameOf(Key.Function, Stat.FunctionIndex).c_str());
        std::cout << Line;
    }
}

inline void Report(int64_t Frame) {
    const int32_t ObjectsNow = SDK::UObject::GObjects->Num();
    char Line[256] = {};
    sprintf_s(Line, "[ui-hitch] frame %.1f ms: engine tick %.1f ms, outside it %.1f ms; ProcessEvent %.1f ms in %llu outer calls; "
        "%zu distinct events; GObjects %d -> %d\n", Ms(Frame), Ms(EngineTime), Ms(Frame - EngineTime), Ms(EventTime),
        static_cast<unsigned long long>(EventCalls), Stats.size(), ObjectsAtStart, ObjectsNow);
    std::cout << Line;
    std::vector<std::pair<FKey, FStat>> Rows(Stats.begin(), Stats.end());
    PrintTop("inclusive time", Rows, false, 30);
    std::sort(Rows.begin(), Rows.end(), [](const auto& A, const auto& B) { return A.second.Self > B.second.Self; });
    std::cout << "[ui-hitch]   top by self time:\n";
    for (size_t I = 0; I < Rows.size() && I < 20; ++I) {
        const auto& [Key, Stat] = Rows[I];
        sprintf_s(Line, "[ui-hitch]     %6u calls  self %8.1f ms  %s::%s\n", Stat.Calls, Ms(Stat.Self),
            NameOf(Key.Class, Stat.ClassIndex).c_str(), NameOf(Key.Function, Stat.FunctionIndex).c_str());
        std::cout << Line;
    }
    PrintTop("call count", Rows, true, 40);
    std::cout.flush();
}

inline void EngineTickHook(SDK::UGameEngine* Engine, float DeltaTime, bool bIdleMode) {
    GameThread = GetCurrentThreadId();
    const int64_t Start = Now();
    if (FrameStart && Stack.empty()) {
        const int64_t Frame = Start - FrameStart;
        if (Ms(Frame) >= ThresholdMs)
            Report(Frame);
        Stats.clear();
        EngineTime = EventTime = 0;
        EventCalls = 0;
    }
    if (Stack.empty()) {
        FrameStart = Start;
        ObjectsAtStart = SDK::UObject::GObjects->Num();
    }
    reinterpret_cast<void(*)(SDK::UGameEngine*, float, bool)>(OrigEngineTick)(Engine, DeltaTime, bIdleMode);
    EngineTime += Now() - Start;
}

}
