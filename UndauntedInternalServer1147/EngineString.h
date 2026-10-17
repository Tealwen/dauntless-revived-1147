#pragma once

// Dumper-7's FString(const wchar_t*) only points at the caller's buffer. Strings handed to the
// engine (out-parameters it will later resize or free) must live in the engine's own heap,
// so they are allocated here with the engine's FMemory::Realloc.

#include <cstdint>
#include <cwchar>
#include <cstring>

#include "Addresses1147.h"
#include "Hooking.h"
#include "SDK.hpp"

namespace EngineString {
    struct Layout { wchar_t* Data; int32_t Num; int32_t Max; };

    inline void* Realloc(void* Block, uint64_t Size) {
        return reinterpret_cast<void*(*)(void*, uint64_t, uint32_t)>(Hooking::Base + Addr::FMemoryRealloc)(Block, Size, 0);
    }

    // Replaces the contents of an engine-owned FString.
    inline void Assign(SDK::FString* Target, const wchar_t* Text) {
        auto* S = reinterpret_cast<Layout*>(Target);
        const int32_t Num = static_cast<int32_t>(wcslen(Text) + 1);
        if (S->Max < Num || !S->Data) {
            S->Data = static_cast<wchar_t*>(Realloc(S->Data, Num * sizeof(wchar_t)));
            S->Max = Num;
        }
        std::memcpy(S->Data, Text, Num * sizeof(wchar_t));
        S->Num = Num;
    }
}
