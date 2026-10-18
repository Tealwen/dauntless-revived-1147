#pragma once

// The game's feature flags (the 46 *_bpff Blueprint assets, e.g. city_event_dark_harvest_bpff, Ramsgate's
// Halloween decoration) from DR_FEATURES, on servers and clients.
//
// A flag is a config class: it is on when the user Game.ini has
//   [/Game/Features/HuntPass/city_event_dark_harvest_bpff.city_event_dark_harvest_bpff_C]
//   bEnabled=True
//   PerBranchSettings=((release, True),(mainline, True))
// The engine reads that file while it starts, after this DLL is loaded, so Apply() writes these sections into
// %LOCALAPPDATA%\Archon\Saved\Config\WindowsClient\Game.ini (inside the Wine/Proton prefix on Linux) first.
// The game server decides which Ramsgate event levels it loads; a client gets the same flags from its launcher.
//
// DR_FEATURES: comma-separated flags, by short name (city_event_dark_harvest_bpff) or asset path
// (/Game/Features/HuntPass/city_event_dark_harvest_bpff); a leading '-' writes the flag off. Sections this
// DLL wrote before and that DR_FEATURES no longer names are removed (DauntlessRevivedFeatures.txt next to
// Game.ini remembers them); a section the user wrote by hand is left alone unless DR_FEATURES names it.

#include <windows.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace FeatureFlags1147 {
    // The flag assets in the 1.14.7 paks (a short name resolves to one of these)
    inline const char* const KnownPaths[] = {
        "/Game/Features/City_Hidden_Level_On_bpff",
        "/Game/Features/Development/HG_danger_bpff",
        "/Game/Features/Development/enable_testquests_bpff",
        "/Game/Features/Development/montage_telemetry_enabled_bpff",
        "/Game/Features/Development/status_effect_changes_bpff",
        "/Game/Features/Development/test_safezones_bpff",
        "/Game/Features/Development/vendors_come_close_bpff",
        "/Game/Features/HuntPass/chainblades_followup_bpff",
        "/Game/Features/HuntPass/city_event_SaintsBond_bpff",
        "/Game/Features/HuntPass/city_event_Springtide_bpff",
        "/Game/Features/HuntPass/city_event_dark_harvest_bpff",
        "/Game/Features/HuntPass/city_event_stall_bpff",
        "/Game/Features/HuntPass/city_linnea_bpff",
        "/Game/Features/HuntPass/enable_city_event_frostfall_bpff",
        "/Game/Features/HuntPass/hunt_pass_s03_bpff",
        "/Game/Features/HuntPass/hunt_pass_s04_bpff",
        "/Game/Features/HuntPass/hunt_pass_s08b_saints_bond_bpff",
        "/Game/Features/base_interaction_component_bpff",
        "/Game/Features/behemoth_amber_bpff",
        "/Game/Features/debug_helm_settings_bpff",
        "/Game/Features/enable_CR2019_bpff",
        "/Game/Features/enable_player_animation_on_server_bpff",
        "/Game/Features/enable_tutorial_v2_bpff",
        "/Game/Features/follow_camera_bpff",
        "/Game/Features/frostwolf_behemoth_bpff",
        "/Game/Features/frozen_mashout_bpff",
        "/Game/Features/glitter_weapons_bpff",
        "/Game/Features/ih_default_weapon_part_q_bpff",
        "/Game/Features/jreilly_nonsense_bpff",
        "/Game/Features/new_health_scaling_bpff",
        "/Game/Features/new_island_feature_bpff",
        "/Game/Features/new_potion_drink_bpff",
        "/Game/Features/new_wound_bpff",
        "/Game/Features/outofcombat_movespeed_bpff",
        "/Game/Features/party_member_markers_bpff",
        "/Game/Features/player_camera_v2_bpff",
        "/Game/Features/preserve_chatmode_between_hunts_bpff",
        "/Game/Features/skip_cinematic_feature_bpff",
        "/Game/Features/startle_stagger_disabled_bpff",
        "/Game/Features/threat_2020_bpff",
        "/Game/Features/travel_mode_bpff",
        "/Game/Features/tutorial_cinematics_enabled_bpff",
        "/Game/Pretzel/pretzel_bpff",
        "/Game/gamemodes/escalation/escalation_heroics_bpff",
        "/Game/gamemodes/escalation/escalation_season_5_frost_bpff",
        "/Game/gamemodes/escalation/escalation_season_6_radiant_bpff",
    };

    inline std::string Trim(const std::string& Text) {
        const auto Begin = Text.find_first_not_of(" \t\r\n");
        if (Begin == std::string::npos) return {};
        return Text.substr(Begin, Text.find_last_not_of(" \t\r\n") - Begin + 1);
    }

    inline bool EqualsNoCase(const std::string& A, const std::string& B) {
        return A.size() == B.size() && std::equal(A.begin(), A.end(), B.begin(), [](char X, char Y) { return std::tolower((unsigned char)X) == std::tolower((unsigned char)Y); });
    }

    // "/Game/.../name_bpff" or "name_bpff" -> "[/Game/.../name_bpff.name_bpff_C]", or "" if unknown
    inline std::string SectionFor(const std::string& Entry) {
        std::string Path;
        if (Entry.starts_with("/")) {
            if (Entry.find_first_not_of("/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_") != std::string::npos) return {};
            Path = Entry;
        } else {
            for (const char* Known : KnownPaths) {
                const std::string K(Known);
                if (EqualsNoCase(K.substr(K.rfind('/') + 1), Entry)) Path = K;
            }
        }
        if (Path.empty()) return {};
        const std::string Name = Path.substr(Path.rfind('/') + 1);
        return "[" + Path + "." + Name + "_C]";
    }

    inline std::vector<std::string> ReadLines(const std::filesystem::path& File) {
        std::vector<std::string> Lines;
        std::ifstream In(File);
        for (std::string Line; std::getline(In, Line);) {
            if (!Line.empty() && Line.back() == '\r') Line.pop_back();
            Lines.push_back(Line);
        }
        return Lines;
    }

    // Replaces File with Text through a temporary file, so an engine (Ramsgate, a hunt, the client) reading it
    // at the same moment never sees it half written; an unchanged file is not touched at all.
    inline void WriteIfChanged(const std::filesystem::path& File, const std::string& Text) {
        {
            std::ifstream Current(File, std::ios::binary);
            if (Current) {
                const std::string Old((std::istreambuf_iterator<char>(Current)), std::istreambuf_iterator<char>());
                if (Old == Text) return;
            }
        }
        const std::filesystem::path Temporary(File.wstring() + L"." + std::to_wstring(GetCurrentProcessId()) + L".tmp");
        {
            std::ofstream Out(Temporary, std::ios::binary | std::ios::trunc);
            Out << Text;
            if (!Out) return;
        }
        if (!MoveFileExW(Temporary.c_str(), File.c_str(), MOVEFILE_REPLACE_EXISTING)) {
            std::error_code Ignored;
            std::filesystem::remove(Temporary, Ignored);
        }
    }

    // AmServer: game servers share the client's Game.ini (same %LOCALAPPDATA%). One started without DR_FEATURES
    // leaves the file as it is instead of removing the flags the client (or another server) wrote.
    inline void Apply(bool AmServer = false) {
        char Value[4096] = {};
        const DWORD Length = GetEnvironmentVariableA("DR_FEATURES", Value, sizeof(Value));
        const std::string Wanted = Length > 0 && Length < sizeof(Value) ? Value : "";
        if (AmServer && Wanted.empty()) return;

        char LocalAppData[MAX_PATH] = {};
        const DWORD DirLength = GetEnvironmentVariableA("LOCALAPPDATA", LocalAppData, MAX_PATH);
        if (DirLength == 0 || DirLength >= MAX_PATH) return;
        const std::filesystem::path Dir = std::filesystem::path(LocalAppData) / "Archon" / "Saved" / "Config" / "WindowsClient";
        const std::filesystem::path GameIni = Dir / "Game.ini";
        const std::filesystem::path StateFile = Dir / "DauntlessRevivedFeatures.txt";

        // Sections wanted now ("[...]" -> on/off), and those this DLL wrote last time
        std::vector<std::pair<std::string, bool>> Sections;
        std::stringstream List(Wanted);
        for (std::string Entry; std::getline(List, Entry, ',');) {
            Entry = Trim(Entry);
            if (Entry.empty()) continue;
            const bool On = Entry[0] != '-';
            const std::string Section = SectionFor(On ? Entry : Trim(Entry.substr(1)));
            if (Section.empty()) {
                std::cout << "[features] unknown flag ignored: " << Entry << std::endl;
                continue;
            }
            Sections.emplace_back(Section, On);
        }
        std::set<std::string> Managed;
        for (const auto& Line : ReadLines(StateFile))
            if (!Trim(Line).empty()) Managed.insert(Trim(Line));
        for (const auto& [Section, On] : Sections) Managed.insert(Section);
        if (Managed.empty()) return; // nothing asked, nothing written before: leave Game.ini alone

        // Game.ini without the managed sections (each section runs to the next "[")
        std::vector<std::string> Out;
        bool Skipping = false;
        for (const auto& Line : ReadLines(GameIni)) {
            const std::string Trimmed = Trim(Line);
            if (Trimmed.starts_with("[")) Skipping = Managed.contains(Trimmed);
            if (!Skipping) Out.push_back(Line);
        }
        while (!Out.empty() && Trim(Out.back()).empty()) Out.pop_back();

        for (const auto& [Section, On] : Sections) {
            if (!Out.empty()) Out.push_back("");
            Out.push_back(Section);
            Out.push_back(std::string("bEnabled=") + (On ? "True" : "False"));
            Out.push_back(std::string("PerBranchSettings=((release, ") + (On ? "True" : "False") + "),(mainline, " + (On ? "True" : "False") + "))");
        }

        std::error_code Error;
        std::filesystem::create_directories(Dir, Error);
        std::string IniText;
        for (const auto& Line : Out) IniText += Line + "\r\n";
        WriteIfChanged(GameIni, IniText);
        std::string StateText;
        for (const auto& [Section, On] : Sections) StateText += Section + "\n";
        WriteIfChanged(StateFile, StateText);
        std::cout << "[features] " << Sections.size() << " flag(s) written to Game.ini"
                  << (Wanted.empty() ? " (DR_FEATURES unset: previous flags removed)" : (": " + Wanted)) << std::endl;
    }
}
