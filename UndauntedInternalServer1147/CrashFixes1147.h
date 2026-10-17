#pragma once

// The one 1.4.4 crash fix that still applies to 1.14.7 (evidence: PORT-1.14.7/15-dll-helpers.md).
//
// "Fixup Ramsgate Crash" (1.4.4 patch at 0x1346A98 inside 0x13463D0). The function is the player character's
// input setup (it builds 10 ability-input slots named "Dodge", "Primary Attack", ... "Tertiary Shoot", then walks
// Controller->PlayerInput->ActionMappings: `mov rcx,r14 (Controller at Pawn+0x258); call getter` where the getter is
// `mov rax,[rcx+0x348] (APlayerController::PlayerInput); add rax,0x150; ret`). A remote player's controller has no
// PlayerInput on a server, so the getter returns 0x150 and `mov rsi,[rax]` faults. The patch makes the array read as
// empty. 1.14.7 has the same function at 0x18DFEA0, the same getter (0x1CA7E00, byte-identical) and the same 7 bytes
// after the call. On a dedicated server there is no local input to bind, so skipping it changes nothing else.
// Not seen crashing on 1.14.7 yet only because no client has joined a 1.14.7 Ramsgate server so far.
//
// Not ported (no equivalent crash or symptom on 1.14.7; see the doc): ServerBootCrash 0x2E4D7F0 (= UUserWidget::
// AddToViewport), EncounterableSetup 0x1658F90 (= UEncounterableComponent::InitializeForPlayer, 1.14.7 0x1CEC200),
// combat text 0x1390300 (a widget's construct override).

#include "Hooking.h"

namespace CrashFixes1147 {
    // 1.14.7 0x18E061C: mov rsi,[rax]; movsxd rax,dword [rax+8]  ->  xor esi,esi; xor eax,eax; nop x3
    inline constexpr uintptr_t PlayerInputActionMappingsRead = 0x18E061C;

    // Server only.
    inline void Apply() {
        Hooking::Patch("Ramsgate input setup (no PlayerInput on the server)", PlayerInputActionMappingsRead,
            {0x48, 0x8B, 0x30, 0x48, 0x63, 0x40, 0x08},
            {0x33, 0xF6, 0x33, 0xC0, 0x90, 0x90, 0x90});
    }
}
