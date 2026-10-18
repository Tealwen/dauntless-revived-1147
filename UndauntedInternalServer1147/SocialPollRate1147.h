#pragma once
// Party and Slayer link polling on the 1.14.7 client: invites, accepts and party changes reach the client only through
// its own polls (the STOMP handlers only log, PORT-1.14.7/13-social.md), so the poll interval is how long a player
// waits after clicking, and why they clicked again.
//   UArchonPartyPrimary::UpdateParty (0x1C8BB40): interval = this+0xE8, replaced by 5 s (0x145038768) or 10 s
//   (0x14503876C) in some states, then "PollRate expired" when Now - this+0xE4 is above it.
//   UArchonLinkedSlayers::HeartBeatForInboundNotifications (0x1C6D6D0): the same with this+0x158 / this+0x154.
// Both now use 3 s: the field loads read the 3.0f constant at 0x145038758 (beside the 5 and the 10), and the four
// constant loads become 8-byte NOPs. The metagame's POST /party and slayer link polls have no rate limit.
// Client only. Apply() once, from Init.
#include <cstdint>
#include <vector>

#include "Hooking.h"

namespace SocialPollRate1147 {

inline constexpr uintptr_t ThreeSecondsRva = 0x5038758; // 3.0f in .rdata

// movss xmm6, dword ptr [rip+disp32] reading the 3.0f constant, for an 8-byte instruction at Rva
inline std::vector<uint8_t> LoadThreeSeconds(uintptr_t Rva) {
    const int32_t Disp = static_cast<int32_t>(ThreeSecondsRva - (Rva + 8));
    return { 0xF3, 0x0F, 0x10, 0x35, static_cast<uint8_t>(Disp), static_cast<uint8_t>(Disp >> 8),
             static_cast<uint8_t>(Disp >> 16), static_cast<uint8_t>(Disp >> 24) };
}

inline const std::vector<uint8_t> Nop8 = { 0x0F, 0x1F, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00 };

inline void Apply() {
    using Hooking::Patch;
    // Party
    Patch("party poll interval (field -> 3 s)", 0x1C8BB97, {0xF3, 0x0F, 0x10, 0xB3, 0xE8, 0x00, 0x00, 0x00}, LoadThreeSeconds(0x1C8BB97));
    Patch("party poll interval (5 s state)", 0x1C8BBED, {0xF3, 0x0F, 0x10, 0x35, 0x73, 0xCB, 0x3A, 0x03}, Nop8);
    Patch("party poll interval (10 s state)", 0x1C8BC38, {0xF3, 0x0F, 0x10, 0x35, 0x2C, 0xCB, 0x3A, 0x03}, Nop8);
    // Slayer links
    Patch("slayer link poll interval (field -> 3 s)", 0x1C6D717, {0xF3, 0x0F, 0x10, 0xB3, 0x58, 0x01, 0x00, 0x00}, LoadThreeSeconds(0x1C6D717));
    Patch("slayer link poll interval (5 s state)", 0x1C6D73D, {0xF3, 0x0F, 0x10, 0x35, 0x23, 0xB0, 0x3C, 0x03}, Nop8);
    Patch("slayer link poll interval (10 s state)", 0x1C6D783, {0xF3, 0x0F, 0x10, 0x35, 0xE1, 0xAF, 0x3C, 0x03}, Nop8);
}

}
