import "./env1147";
import { RemoveTestDb } from "./setup";
import "./authenv";
import { WithEnv } from "./appenv";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Call, StartApp, StopApp } from "./appclient";
import { GetDb } from "../src/db";
import { GetAllEscalationSeasons, GetEscalationSeason } from "../src/controllers/escalationConfig";
import { MakePlayer } from "./helpers";

before(async () => { await StartApp(); });
after(async () => {
    await StopApp();
    RemoveTestDb(() => GetDb().$client.close());
});

// 1.14.7: its own Escalation registry (vendor/escalation/seasons_1147.json), and a stub its talent menu can open
describe("1.14.7 Escalation", () => {
    it("has the six 1.14.7 seasons, Frost and Radiant included, with 25 levels each", () => {
        assert.deepEqual(GetAllEscalationSeasons().map((Season) => Season.context), ["Shock", "Blaze", "Umbral", "Terra", "Frost", "Radiant"]);
        assert.ok(GetEscalationSeason("ESC_SEASON_6")?.talents.some((Talent) => Talent.id === "ESC_TALENT_S6_TIER1_REVOLVER"));
        assert.ok(GetAllEscalationSeasons().every((Season) => Season.levels.length === 25));
    });

    it("real mode: a new player starts Shock at level 0 and can save a Radiant season", async () => {
        await WithEnv({ ESCALATION_MODE: "real" }, async () => {
            const { UserId } = await MakePlayer();
            const Read = await Call("GET", `/escalation/ESC_SEASON_1/${UserId}`, { as: UserId });
            assert.equal(Read.status, 200);
            assert.equal(Read.json.payload.escalation_level, 0);

            const Saved = await Call("POST", `/escalation/ESC_SEASON_6/${UserId}`, { gs: true, body: {
                escalation_level: 1, next_level_xp: 0, update_version: 1, unlock_progress: [],
                talents_progress: [{ talent_id: "ESC_TALENT_S6_TIER1_REVOLVER", rank: 1 }] } });
            assert.equal(Saved.status, 200);
            const After = await Call("GET", `/escalation/ESC_SEASON_6/${UserId}`, { as: UserId });
            assert.equal(After.json.payload.escalation_level, 1);
        });
    });

    it("stub mode answers the season's last level, not 99999", async () => {
        await WithEnv({ ESCALATION_MODE: "stub" }, async () => {
            const { UserId } = await MakePlayer();
            const Read = await Call("GET", `/escalation/ESC_SEASON_1/${UserId}`, { as: UserId });
            assert.equal(Read.json.payload.escalation_level, 25);
            assert.equal(Read.json.payload.next_level_xp, 0);
        });
    });
});
