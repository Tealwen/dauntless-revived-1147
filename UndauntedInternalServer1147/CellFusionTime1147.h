#pragma once
// Middleman (Research Lab) cell fusion time for 1.14.7: port of UndauntedInternalServer/CellFusionTime.h (1.4.4).
// 1.14.7 still has the same table and row: DataTable /Game/Gameplay/cell_exchange_table (GObjects dump:
// "DataTable cell_exchange_table.cell_exchange_table") with rows FCellExchangeTableData {Ingredients 0x08,
// Result 0x18, TimeRequired 0x20 (FTimespan), ResultExcludesIngredients 0x28, CurrencyItemID 0x30,
// CurrencyQuantity 0x40}. A started fusion is still a TOKEN_CELL_EXCHANGE stack item whose itemData carries
// SlotID / EndTime / ResultCell / ExchangeID (strings at 0x5486D8C.. used by 0x1B774C0..0x1B7D1B0), so the end
// time still comes from TimeRequired. No address is needed: the table is found by name through GObjects.
// Set every recipe to FusionHours, in the client (what the Research Lab shows) and the game servers.
// Call Tick() from a game-thread tick on both sides (server: UGameEngine::Tick hook; client: ProcessEvent hook).
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <iostream>
#include <string>

#include "NativeDiagnostics.h"
#include "SDK.hpp"

namespace CellFusionTime {

constexpr int64_t FusionHours = 1;
constexpr int64_t TicksPerHour = 36000000000LL; // FTimespan ticks are 100 ns

inline SDK::UDataTable* Table = nullptr;
inline int32_t TableIndex = -1;
inline std::chrono::steady_clock::time_point NextCheck{};

inline int64_t& Ticks(SDK::FTimespan& Time) {
    return *reinterpret_cast<int64_t*>(&Time);
}

inline SDK::UDataTable* FindTable() {
    SDK::UClass* TableClass = SDK::UDataTable::StaticClass();
    for (int I = 0; I < SDK::UObject::GObjects->Num(); ++I) {
        SDK::UObject* Object = SDK::UObject::GObjects->GetByIndex(I);
        if (!Object || !Object->IsA(TableClass) || Object->IsDefaultObject())
            continue;
        if (Object->GetName() == "cell_exchange_table")
            return static_cast<SDK::UDataTable*>(Object);
    }
    return nullptr;
}

// True when the table has rows (every recipe now has the wanted time).
inline bool Patch(SDK::UDataTable* DataTable) {
    auto& Map = DataTable->RowMap;
    int Rows = 0, Changed = 0;

    for (int I = 0; I < Map.NumAllocated(); ++I) {
        if (!Map.IsValidIndex(I) || !Map[I].Value())
            continue;
        auto* Row = reinterpret_cast<SDK::FCellExchangeTableData*>(Map[I].Value());
        ++Rows;
        if (Ticks(Row->TimeRequired) != FusionHours * TicksPerHour) {
            Ticks(Row->TimeRequired) = FusionHours * TicksPerHour;
            ++Changed;
        }
    }

    if (Changed > 0) {
        char Line[96] = {};
        const int Size = sprintf_s(Line, "cell_fusion_time recipes=%d changed=%d hours=%lld\n", Rows, Changed, static_cast<long long>(FusionHours));
        if (Size > 0) {
            std::cout << Line;
            DR_WriteDiagnostic(Line, static_cast<DWORD>(Size));
        }
    }
    return Rows > 0;
}

// Looks for the table every 2 s until found, then re-checks every 30 s (a reloaded table is patched again).
inline void Tick() {
    const auto Now = std::chrono::steady_clock::now();
    if (Now < NextCheck)
        return;
    NextCheck = Now + std::chrono::seconds(Table ? 30 : 2);

    // Compare by the remembered GObjects slot so a freed table is never dereferenced.
    if (!(Table && SDK::UObject::GObjects->GetByIndex(TableIndex) == Table)) {
        Table = FindTable();
        TableIndex = Table ? Table->Index : -1;
    }
    if (Table && !Patch(Table))
        Table = nullptr;
}

}
