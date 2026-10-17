// winmm.dll proxy for the Dauntless 1.14.7 client. The game imports winmm.dll, so a copy of this
// file next to Dauntless-Win64-Shipping.exe is loaded before the engine starts. It forwards every
// export to the system winmm.dll and loads UndauntedInternalServer.dll from the same folder.
// Removing both files restores the unmodified game.
//
// Why winmm and not dxgi (Undaunted's choice on 1.4.4): on 1.14.7, system DLLs bound to a dxgi
// proxy call it during start-up, and the system dxgi.dll cannot be loaded from there.

#include <windows.h>
#include <string>

#include "exports.h"

extern "C" void* ProxyProcs[ProxyExportCount];

// DR_TRACE_FILE: start-up diagnostics, written with plain Win32 calls.
static void Trace(const char* Text) {
    wchar_t Path[MAX_PATH] = {};
    const DWORD Length = GetEnvironmentVariableW(L"DR_TRACE_FILE", Path, MAX_PATH);
    if (!Length || Length >= MAX_PATH) return;
    HANDLE File = CreateFileW(Path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, 0, nullptr);
    if (File == INVALID_HANDLE_VALUE) return;
    DWORD Written = 0;
    WriteFile(File, Text, static_cast<DWORD>(strlen(Text)), &Written, nullptr);
    WriteFile(File, "\r\n", 2, &Written, nullptr);
    CloseHandle(File);
}

// Called from DllMain and by the export stubs (exports.asm) when a slot is still empty.
extern "C" void EnsureSystemDll() {
    static HMODULE Real = nullptr;
    if (Real) return;
    wchar_t Path[MAX_PATH] = {};
    const UINT Length = GetSystemDirectoryW(Path, MAX_PATH);
    if (!Length || Length > MAX_PATH - 16) return;
    wcscat_s(Path, L"\\winmm.dll");
    Real = LoadLibraryW(Path);
    if (!Real) {
        char Line[96];
        wsprintfA(Line, "proxy: cannot load the system winmm.dll (error %lu)", GetLastError());
        Trace(Line);
        return;
    }
    for (int i = 0; i < ProxyExportCount; ++i) {
        const auto& E = ProxyExports[i];
        ProxyProcs[i] = reinterpret_cast<void*>(GetProcAddress(Real, E.Name ? E.Name : MAKEINTRESOURCEA(E.Ordinal)));
    }
}

static void LoadRevived(HMODULE Self) {
    // DR_NO_REVIVED=1 starts the game without the Revived DLL (troubleshooting).
    char Skip[2] = {};
    if (GetEnvironmentVariableA("DR_NO_REVIVED", Skip, sizeof(Skip)) == 1 && Skip[0] == '1') return;

    wchar_t Path[MAX_PATH] = {};
    const DWORD Length = GetModuleFileNameW(Self, Path, MAX_PATH);
    if (!Length || Length >= MAX_PATH) return;
    std::wstring Dll(Path, Length);
    Dll = Dll.substr(0, Dll.find_last_of(L"\\/") + 1) + L"UndauntedInternalServer.dll";
    if (!LoadLibraryW(Dll.c_str()))
        MessageBoxW(nullptr, (L"Could not load " + Dll).c_str(), L"Dauntless Revived", MB_ICONERROR);
}

BOOL APIENTRY DllMain(HMODULE Module, DWORD Reason, LPVOID)
{
    if (Reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(Module);
        Trace("proxy: attach");
        EnsureSystemDll();
        LoadRevived(Module);
        Trace("proxy: done");
    }
    return TRUE;
}
