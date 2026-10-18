#pragma once

// Which HTTP requests of a game server carry its credentials (x-undaunted-gameserver-apikey and the
// connected-player headers). Before, every request did, whatever its host: a URL Endpoints1147.h does not
// redirect (telemetry, a CDN, a hardcoded host) would have received the server's API key.
//
// The request's URL is read from FCurlHttpRequest itself: its GetURL (vtable slot 0, 0x2284890) is
// `lea rdx, [rcx+70h]; call FString copy`, so the URL is the FString at +0x70. Those bytes are checked at
// start-up; if they differ, the URL is unknown and every request keeps the headers (the old behaviour),
// so a game server never loses its access to the metagame.

#include <cwctype>
#include <iostream>
#include <string>
#include <string_view>

#include "Hooking.h"
#include "UnrealContainers.hpp"

namespace MetagameRequests {
    inline constexpr uintptr_t CurlGetURL = 0x2284890;
    inline constexpr uintptr_t RequestURLOffset = 0x70;
    inline constexpr std::initializer_list<int> CurlGetURLBytes = {0x40, 0x53, 0x48, 0x83, 0xEC, 0x20, 0x48, 0x8B, 0xDA, 0x48, 0x8D, 0x51, 0x70};

    inline bool UrlReadable = false;

    // "http://host:port/path?x" -> "host:port"
    inline std::wstring_view HostOf(std::wstring_view Url) {
        const auto Scheme = Url.find(L"://");
        if (Scheme == std::wstring_view::npos) return {};
        Url.remove_prefix(Scheme + 3);
        const auto End = Url.find_first_of(L"/?#");
        return End == std::wstring_view::npos ? Url : Url.substr(0, End);
    }

    inline bool EqualsNoCase(std::wstring_view A, std::wstring_view B) {
        if (A.size() != B.size()) return false;
        for (size_t i = 0; i < A.size(); ++i)
            if (std::towlower(A[i]) != std::towlower(B[i])) return false;
        return true;
    }

    inline bool StartsWithNoCase(std::wstring_view Text, std::wstring_view Prefix) {
        return Text.size() >= Prefix.size() && EqualsNoCase(Text.substr(0, Prefix.size()), Prefix);
    }

    // The metagame address the endpoints point at, or this machine (the deploy server, a local metagame
    // reached under another spelling)
    inline bool IsTrustedHost(std::wstring_view Host, std::wstring_view Metagame) {
        if (Host.empty()) return false;
        if (EqualsNoCase(Host, Metagame)) return true;
        for (std::wstring_view Local : {L"127.0.0.1", L"localhost", L"[::1]"})
            if (EqualsNoCase(Host, Local) || (StartsWithNoCase(Host, Local) && Host.size() > Local.size() && Host[Local.size()] == L':'))
                return true;
        return false;
    }

    // Once, on the server, before the ProcessRequest hook is installed
    inline void Init() {
        UrlReadable = Hooking::BytesMatch(CurlGetURL, CurlGetURLBytes);
        if (!UrlReadable)
            std::cout << "[hook] FCurlHttpRequest::GetURL bytes differ: server credentials go with every request" << std::endl;
    }

    // Whether this request (an FCurlHttpRequest*) may carry the server's credentials
    inline bool MayCarryCredentials(void* Request, std::wstring_view Metagame) {
        if (!UrlReadable || !Request) return true;
        const auto* Url = reinterpret_cast<const UC::FString*>(static_cast<uint8_t*>(Request) + RequestURLOffset);
        const wchar_t* Text = Url->CStr();
        if (!Text || Url->Num() <= 0) return true; // no URL yet: the engine refuses to send it anyway
        const std::wstring_view Host = HostOf(std::wstring_view(Text, wcsnlen(Text, static_cast<size_t>(Url->Num()))));
        if (IsTrustedHost(Host, Metagame)) return true;
        static std::wstring LastRefused;
        if (LastRefused != Host) {
            LastRefused.assign(Host);
            std::cout << "Server credentials not sent to " << std::string(LastRefused.begin(), LastRefused.end()) << std::endl;
        }
        return false;
    }
}
