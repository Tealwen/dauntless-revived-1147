#pragma once

// Client helpers for 1.14.7, ported from the 1.4.4 DLL:
// - AutoPressStart: UndauntedInternalServer/AutoPressStart.h, same logic. 1.14.7 still shows
//   PressStartScreen_bps_C on Map_LoginMenu (client logs: "UI Screen does not have a valid default focusable
//   widget: [PressStartScreen_bps_C_...]") and the class still has Internal_OnDismissRequested(int32 UserIndex).
// - Console: the 1.4.4 MainThread spawned a UConsole into GameViewport->ViewportConsole (shipping builds never create
//   one) and bound it to F2. Here it is done on the game thread, from the client ProcessEvent hook, once the game
//   viewport exists, instead of from a worker thread.
// Client only. Call OnProcessEvent after every client ProcessEvent (after the original ran).

#include <windows.h>
#include <chrono>
#include <iostream>

#include "SDK.hpp"

namespace AutoPressStart1147 {

inline SDK::UObject* Screen = nullptr;
inline int32_t ScreenIndex = -1;
inline std::chrono::steady_clock::time_point DismissAt{};

inline void PressStart(SDK::UObject* Object, SDK::UFunction* Function) {
    static SDK::UFunction* Construct = nullptr;
    // Until the screen's Construct is known, compare names (cheaper than 1.4.4's GetFullName on every call).
    if (Function && (Function == Construct || (!Construct && Object && Object->Class && Function->GetName() == "Construct"
        && Object->Class->GetName() == "PressStartScreen_bps_C"))) {
        Construct = Function;
        Screen = Object;
        ScreenIndex = Object ? Object->Index : -1;
        // A moment after it appears, so the login flow behind it is ready (as for a player clicking).
        DismissAt = std::chrono::steady_clock::now() + std::chrono::milliseconds(750);
        return;
    }

    if (!Screen || std::chrono::steady_clock::now() < DismissAt)
        return;

    SDK::UObject* Target = Screen;
    Screen = nullptr;
    // The slot must still hold the same screen (it may have been closed in the meantime).
    if (SDK::UObject::GObjects->GetByIndex(ScreenIndex) != Target)
        return;

    SDK::UFunction* Dismiss = Target->Class->GetFunction("PressStartScreen_bps_C", "Internal_OnDismissRequested");
    if (!Dismiss)
        return;

    struct { int32_t UserIndex = 0; } Params;
    std::cout << "[press-start] dismissed" << std::endl;
    Target->ProcessEvent(Dismiss, &Params);
}

// F2 opens the console (the ini key, Tilde, is awkward on AZERTY keyboards). Retried until the viewport exists;
// a viewport replaced later (e.g. after a full reload) gets a new console too.
inline void EnsureConsole() {
    static ULONGLONG NextTry = 0;
    if (GetTickCount64() < NextTry) return;
    NextTry = GetTickCount64() + 1000;

    SDK::UEngine* Engine = SDK::UEngine::GetEngine();
    SDK::UGameViewportClient* Viewport = Engine ? Engine->GameViewport : nullptr;
    if (!Viewport || Viewport->ViewportConsole) return;

    SDK::UClass* ConsoleClass = Engine->ConsoleClass.Get();
    if (!ConsoleClass) ConsoleClass = SDK::UConsole::StaticClass();
    if (!ConsoleClass) return;

    if (auto* Settings = SDK::UInputSettings::GetDefaultObj(); Settings && Settings->ConsoleKeys.Num() > 0)
        Settings->ConsoleKeys[0].KeyName = SDK::UKismetStringLibrary::Conv_StringToName(SDK::FString(L"F2"));

    SDK::UObject* Console = SDK::UGameplayStatics::SpawnObject(ConsoleClass, Viewport);
    if (!Console) { std::cout << "[console] SpawnObject failed" << std::endl; return; }
    Viewport->ViewportConsole = static_cast<SDK::UConsole*>(Console);
    std::cout << "[console] spawned " << Console->GetFullName() << " (F2)" << std::endl;
}

inline void OnProcessEvent(SDK::UObject* Object, SDK::UFunction* Function) {
    PressStart(Object, Function);
    EnsureConsole();
}

}
