#pragma once

// Chat (XMPP over WebSocket) settings for the 1.14.7 client (PORT-1.14.7/13-social.md).
//
// FOnlineSubsystemMcp reads [OnlineSubsystemMcp.XMPP] (exe RVA 0xC42320): bUseSSL (GetBool), ServerAddr
// (GetString), ServerPort (GetInt), Domain (GetString), then PingInterval, PingTimeout,
// bPrivateChatFriendsOnly. GetBool (0x25E9E00) and GetInt (0x25EAB10) both go through
// FConfigCacheIni::GetString (0x25EC130), so the existing ConfigGetString hook sees all of them.
//
// FXmppConnectionStrophe::Login (0x458F3C0): when ServerAddr starts with ws:// or wss:// the WebSocket
// URL is Printf("%s:%i", ServerAddr, ServerPort) (0x458FC2C). The cooked port is 443, so with only
// ServerAddr changed the client dialled ws://127.0.0.1:443, where nothing listens: the login never
// completed and every room join said "Not currently connected". The chat listener is CHAT_PORT (61099).
//
// The JID is (UserId, Domain, ClientResource); Domain becomes "muc.<Domain>" for rooms. The metagame
// address with its port (127.0.0.1:61000) is accepted by the chat server (realtime/xmpp.ts IsXmppDomain).
//
// DR_CHAT_ADDRESS=host:port overrides the chat endpoint (default: the metagame host, port 61099).

#include <string>
#include <windows.h>

#include "EngineString.h"

namespace Social1147 {
    inline std::wstring ChatHost;
    inline std::wstring ChatPort = L"61099";
    inline std::wstring XmppDomain;

    // Call once on the client, after Globals::MetagameAddress is known.
    inline void Init(const std::wstring& MetagameAddress) {
        XmppDomain = MetagameAddress;
        ChatHost = MetagameAddress.substr(0, MetagameAddress.find(L':'));

        wchar_t Buffer[256] = {};
        const DWORD Length = GetEnvironmentVariableW(L"DR_CHAT_ADDRESS", Buffer, 256);
        if (Length > 0 && Length < 256) {
            const std::wstring Value(Buffer);
            const auto Colon = Value.rfind(L':');
            if (Colon != std::wstring::npos && Colon > 0 && Colon + 1 < Value.size()) {
                ChatHost = Value.substr(0, Colon);
                ChatPort = Value.substr(Colon + 1);
            } else {
                ChatHost = Value;
            }
        }
    }

    // True when it answered: the caller returns true without calling the original GetString.
    inline bool XmppConfig(const wchar_t* Section, const wchar_t* Key, SDK::FString* Value) {
        if (!Section || !Key || ChatHost.empty() || !wcsstr(Section, L"OnlineSubsystemMcp.XMPP"))
            return false;

        if (!wcscmp(Key, L"ServerAddr")) { EngineString::Assign(Value, (L"ws://" + ChatHost).c_str()); return true; }
        if (!wcscmp(Key, L"ServerPort")) { EngineString::Assign(Value, ChatPort.c_str()); return true; }
        if (!wcscmp(Key, L"bUseSSL"))    { EngineString::Assign(Value, L"False"); return true; }
        if (!wcscmp(Key, L"Domain"))     { EngineString::Assign(Value, XmppDomain.c_str()); return true; }
        return false;
    }
}
