#pragma once
// Middleman (Research Lab) weekly cells on 1.14.7: their Aetherdust price showed -1 and could not be bought.
// UExchangeVendorCellOffers::SetCellStoreOffers (BlueprintCallable, so it runs through ProcessEvent) turns each
// FOnlineStorePhoenixOffer into an FCellOfferViewModel: PlatPrice / DustPrice start at -1 and are filled from the
// offer's price table, matched by FName against "id_currency_platinum" and "CURRENCY_CELLDUST". The Platinum price is
// found; the Aetherdust one never is, whatever currencyId the metagame sends (id_currency_celldust is mapped to
// CURRENCY_CELLDUST elsewhere but not stored under that name; CURRENCY_CELLDUST itself is dropped by the parser).
// After the native ran, each cell still at DustPrice < 0 gets the Aetherdust price of its offer: FOnlineStorePhoenixOffer
// DustPrice (+0x60) when set, else the GetPriceDetails entry whose CurrencyId names celldust; DustCurrencyId is set to
// CURRENCY_CELLDUST, the code the offering grid buys with. Each SKU is logged once ([middleman] ...).
// Client only: Install() detours the native (it is not reached through ProcessEvent).
#include <algorithm>
#include <cctype>
#include <cstring>
#include <iostream>
#include <set>
#include <string>
#include <vector>

#include "Hooking.h"
#include "SDK.hpp"

namespace MiddlemanDustPrice {

// GetPriceDetails parameter block, as in SDK/OnlineSubsystemPhoenix_parameters.hpp (not built here)
struct GetPriceDetailsParms {
    SDK::FOnlineStorePhoenixOffer StoreOffer;                         // 0x0000 (0x0230)
    SDK::TArray<SDK::FOnlineStorePhoenixPriceDetails> ReturnValue;    // 0x0230 (0x0010)
};
static_assert(sizeof(GetPriceDetailsParms) == 0x240, "GetPriceDetails parameters");

inline std::string Lower(std::string Text) {
    for (char& C : Text) C = static_cast<char>(std::tolower(static_cast<unsigned char>(C)));
    return Text;
}

// UStoreOfferBlueprintLibrary::GetPriceDetails through ProcessEvent on its CDO. The offer is passed by reference
// (a bitwise copy in the parameter block, never destroyed here); the returned array is read and left to the engine.
inline int DustFromPriceDetails(const SDK::FOnlineStorePhoenixOffer& Offer) {
    static SDK::UFunction* GetPriceDetails = nullptr;
    SDK::UClass* Library = SDK::UStoreOfferBlueprintLibrary::StaticClass();
    if (!Library) return -1;
    if (!GetPriceDetails) GetPriceDetails = Library->GetFunction("StoreOfferBlueprintLibrary", "GetPriceDetails");
    SDK::UObject* Cdo = Library->ClassDefaultObject;
    if (!GetPriceDetails || !Cdo) return -1;

    alignas(16) uint8_t Parms[sizeof(GetPriceDetailsParms)] = {};
    std::memcpy(Parms, &Offer, sizeof(SDK::FOnlineStorePhoenixOffer));
    auto* Typed = reinterpret_cast<GetPriceDetailsParms*>(Parms);
    const auto Flags = GetPriceDetails->FunctionFlags;
    GetPriceDetails->FunctionFlags |= 0x400; // FUNC_Native
    Cdo->ProcessEvent(GetPriceDetails, Parms);
    GetPriceDetails->FunctionFlags = Flags;

    for (int I = 0; I < Typed->ReturnValue.Num(); ++I) {
        const auto& Detail = Typed->ReturnValue[I];
        if (Lower(Detail.CurrencyId.ToString()).find("celldust") != std::string::npos && Detail.Price >= 0)
            return Detail.Price;
    }
    return -1;
}

inline void Fix(SDK::UExchangeVendorCellOffers* Widget, const SDK::TArray<SDK::FOnlineStorePhoenixOffer>& Offers) {
    static std::set<std::string> Logged;
    static const SDK::FName DustCurrency = SDK::UKismetStringLibrary::Conv_StringToName(SDK::FString(L"CURRENCY_CELLDUST"));
    for (int I = 0; I < Widget->CellOffers.Num(); ++I) {
        auto& Cell = Widget->CellOffers[I];
        if (Cell.DustPrice >= 0) continue;
        const std::string Sku = Cell.SkuId.ToString();
        int Price = -1;
        const char* From = "nothing";
        for (int J = 0; J < Offers.Num(); ++J) {
            const auto& Offer = Offers[J];
            if (Offer.SkuId.ToString() != Sku) continue;
            if (Offer.DustPrice > 0) { Price = Offer.DustPrice; From = "DustPrice"; }
            else if ((Price = DustFromPriceDetails(Offer)) >= 0) From = "GetPriceDetails";
            break;
        }
        if (Price >= 0) {
            Cell.DustPrice = Price;
            Cell.DustCurrencyId = DustCurrency;
        }
        if (Logged.size() < 64 && Logged.insert(Sku).second)
            std::cout << "[middleman] " << Sku << ": Aetherdust " << Price << " from " << From << std::endl;
    }
}

// UExchangeVendorCellOffers::SetCellStoreOffers native body (exec thunk 0x23B1A70 -> call 0x1EEFAA0, its only caller).
// The widget Blueprint calls it from its bytecode, which never goes through ProcessEvent, so it is detoured.
// void f(UExchangeVendorCellOffers* this, const TArray<FOnlineStorePhoenixOffer>& InStoreOffers)
inline constexpr uintptr_t SetCellStoreOffersRva = 0x1EEFAA0;
inline constexpr std::initializer_list<int> SetCellStoreOffersPrologue =
    {0x48, 0x89, 0x5C, 0x24, 0x08, 0x48, 0x89, 0x6C, 0x24, 0x10, 0x48, 0x89, 0x74, 0x24, 0x18, 0x48};
inline void* OrigSetCellStoreOffers = nullptr;

inline void SetCellStoreOffersHook(SDK::UExchangeVendorCellOffers* Widget, const SDK::TArray<SDK::FOnlineStorePhoenixOffer>* Offers) {
    reinterpret_cast<void (*)(SDK::UExchangeVendorCellOffers*, const SDK::TArray<SDK::FOnlineStorePhoenixOffer>*)>(OrigSetCellStoreOffers)(Widget, Offers);
    if (Widget && Offers) Fix(Widget, *Offers);
}

// Client only, from Init
inline void Install() {
    Hooking::Hook("UExchangeVendorCellOffers::SetCellStoreOffers", SetCellStoreOffersRva, SetCellStoreOffersPrologue,
        SetCellStoreOffersHook, &OrigSetCellStoreOffers);
}

}
