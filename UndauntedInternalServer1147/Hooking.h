#pragma once

// Every address in Addresses1147.h belongs to one exact build. These helpers refuse to touch
// memory whose bytes are not the ones recorded for that build, so a wrong address fails loudly
// instead of corrupting the game.

#include <windows.h>
#include <cstdint>
#include <cstring>
#include <initializer_list>
#include <iostream>
#include <vector>

#include "MinHook/MinHook.h"

namespace Hooking {
    inline uintptr_t Base = 0;
    inline int Failures = 0;

    inline void* At(uintptr_t Rva) { return reinterpret_cast<void*>(Base + Rva); }

    template <typename List>
    inline bool BytesMatch(uintptr_t Rva, const List& Expected) {
        auto* Code = static_cast<const uint8_t*>(At(Rva));
        size_t i = 0;
        for (int Byte : Expected) {
            if (Byte >= 0 && Code[i] != static_cast<uint8_t>(Byte)) return false; // -1 = wildcard
            ++i;
        }
        return true;
    }

    inline void Fail(const char* Name, uintptr_t Rva, const char* Why) {
        ++Failures;
        std::cout << "[hook] FAILED " << Name << " @ 0x" << std::hex << Rva << std::dec << ": " << Why << std::endl;
    }

    // Detours the function at Rva after checking its first bytes.
    template <typename T>
    bool Hook(const char* Name, uintptr_t Rva, std::initializer_list<int> Prologue, T* Detour, void** Original) {
        if (!Rva) { Fail(Name, Rva, "address not known for this build"); return false; }
        if (Prologue.size() == 0) { Fail(Name, Rva, "no prologue recorded, refusing to hook blind"); return false; }
        if (!BytesMatch(Rva, Prologue)) { Fail(Name, Rva, "unexpected prologue bytes"); return false; }
        if (MH_CreateHook(At(Rva), reinterpret_cast<void*>(Detour), Original) != MH_OK) { Fail(Name, Rva, "MH_CreateHook"); return false; }
        if (MH_EnableHook(At(Rva)) != MH_OK) { Fail(Name, Rva, "MH_EnableHook"); return false; }
        std::cout << "[hook] " << Name << std::endl;
        return true;
    }

    // Overwrites code at Rva, but only if it still holds Expected.
    inline bool Patch(const char* Name, uintptr_t Rva, const std::vector<int>& Expected, const std::vector<uint8_t>& Replacement) {
        if (!BytesMatch(Rva, Expected)) { Fail(Name, Rva, "unexpected bytes"); return false; }
        DWORD Old = 0;
        if (!VirtualProtect(At(Rva), Replacement.size(), PAGE_EXECUTE_READWRITE, &Old)) { Fail(Name, Rva, "VirtualProtect"); return false; }
        std::memcpy(At(Rva), Replacement.data(), Replacement.size());
        VirtualProtect(At(Rva), Replacement.size(), Old, &Old);
        FlushInstructionCache(GetCurrentProcess(), At(Rva), Replacement.size());
        std::cout << "[patch] " << Name << std::endl;
        return true;
    }

    // The loaded exe must be the 1.14.7 build the addresses were taken from.
    inline bool IsExpectedBuild(uint32_t SizeOfImage, uint32_t CheckSum) {
        auto* Dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(Base);
        auto* Nt = reinterpret_cast<const IMAGE_NT_HEADERS64*>(Base + Dos->e_lfanew);
        return Nt->OptionalHeader.SizeOfImage == SizeOfImage && Nt->OptionalHeader.CheckSum == CheckSum;
    }
}
