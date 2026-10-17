#pragma once
// Port of UndauntedInternalServer/VendorTabs.h (1.4.4) to 1.14.7, same logic.
// The vendor screen (UCraftingScreen, /Game/UI/Crafting/CraftingScreen_bps) has a Craft / Purchase tab bar
// (ChargeButtonTabs, with the bumper hints either side) that the client may leave collapsed, so only the bumpers
// switch tabs. Show the bar and its hints whenever the vendor offers at least two tabs.
// 1.14.7 members (SDK/Archon_classes.hpp): UCraftingScreen::ChargeButtonTabsContainer 0x528, ChargeButtonTabs 0x530
// (UCraftingCategoryTabWidget : UArchonTabs); UArchonTabs::PreviousButtonHint 0x3A8, NextButtonHint 0x3B0,
// CollapseButtonHintsForMK 0x3B8, CachedVisibleTabsCount 0x3EC. Accessed through the SDK, so no address is needed.
// Client only. Call OnProcessEvent(Object) after every client ProcessEvent.
#include <chrono>

#include "SDK.hpp"

namespace VendorTabs {

inline SDK::UCraftingScreen* Screen = nullptr;
inline int32_t ScreenIndex = -1;
inline std::chrono::steady_clock::time_point NextCheck{};

// UWidget::SetVisibility through ProcessEvent (UMG_functions.cpp is not compiled into this DLL).
inline void Show(SDK::UWidget* Widget) {
    if (!Widget || Widget->Visibility == SDK::ESlateVisibility::SelfHitTestInvisible)
        return;
    static SDK::UFunction* SetVisibility = nullptr;
    if (!SetVisibility)
        SetVisibility = Widget->Class->GetFunction("Widget", "SetVisibility");
    if (!SetVisibility)
        return;
    struct { SDK::ESlateVisibility InVisibility; } Params{ SDK::ESlateVisibility::SelfHitTestInvisible };
    Widget->ProcessEvent(SetVisibility, &Params);
}

inline void OnProcessEvent(SDK::UObject* Object) {
    if (Object && Object != Screen && Object->Class && Object->IsA(SDK::UCraftingScreen::StaticClass()) && !Object->IsDefaultObject()) {
        Screen = static_cast<SDK::UCraftingScreen*>(Object);
        ScreenIndex = Object->Index;
    }

    const auto Now = std::chrono::steady_clock::now();
    if (!Screen || Now < NextCheck)
        return;
    NextCheck = Now + std::chrono::milliseconds(250);

    // The slot must still hold the same screen (it may have been destroyed in the meantime).
    if (SDK::UObject::GObjects->GetByIndex(ScreenIndex) != Screen) {
        Screen = nullptr;
        return;
    }

    auto* Tabs = Screen->ChargeButtonTabs;
    if (!Screen->ChargeButtonTabsContainer || !Tabs || Tabs->CachedVisibleTabsCount < 2)
        return;

    Show(Screen->ChargeButtonTabsContainer);
    Tabs->CollapseButtonHintsForMK = false;
    Show(Tabs->PreviousButtonHint);
    Show(Tabs->NextButtonHint);
}

}
