import { RemoveTestDb } from "./setup";
import "./authenv";
import "./appenv";
import "./env1147";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GetDb } from "../src/db";
import { Call, StartApp, StopApp } from "./appclient";
import { MakePlayer } from "./helpers";
import { ChallengeSeasonWindow } from "../src/routes/compat1147";

// routes/compat1147.ts through the whole app (TARGET_GAME_VERSION=1.14.7): who may read and write the
// Slayer's Path (/pjm) and tracked objectives, and the season window the client builds its challenge
// weeks from.
let A = "";
let B = "";

before(async () => {
    await StartApp();
    A = (await MakePlayer()).UserId;
    B = (await MakePlayer()).UserId;
});

after(async () => {
    await StopApp();
    RemoveTestDb(() => GetDb().$client.close());
});

describe("Slayer's Path (/pjm)", () => {
    it("is saved by the game server only, and survives in the database", async () => {
        const Nodes = { GliderUpgrade_0: { state: 2 } };
        assert.equal((await Call("POST", `/pjm/${A}`, { as: A, body: { nodes: Nodes } })).status, 403);

        const Saved = await Call("POST", `/pjm/${A}`, { gs: true, body: { nodes: Nodes } });
        assert.equal(Saved.status, 200);
        assert.equal(Saved.json.payload.update_version, 1);

        const Own = await Call("GET", "/pjm", { as: A });
        assert.deepEqual(Own.json.payload, { nodes: Nodes, update_version: 1 });
        assert.deepEqual((await Call("GET", `/pjm/${A}`, { gs: true })).json.payload.nodes, Nodes);
    });

    it("is readable by its owner only (account and account-season-faction keys)", async () => {
        assert.equal((await Call("GET", `/pjm/${A}`, { as: B })).status, 403);
        assert.equal((await Call("GET", `/pjm/${A}-43-1`, { as: B })).status, 403);
        assert.equal((await Call("GET", `/pjm/${A}-43-1`, { as: A })).status, 200);
        assert.equal((await Call("GET", "/pjm/seasonal/43-1", { as: B })).status, 200);
    });
});

describe("tracked objectives", () => {
    it("are the owner's to read and write", async () => {
        const Body = { current_set: "quest_slayer_links", omitted_quests: [], tracked_craftables: [], tracked_quests: ["Q1"] };
        assert.equal((await Call("POST", `/progression/tracked_objectives/${A}`, { as: B, body: Body })).status, 403);
        assert.equal((await Call("POST", `/progression/tracked_objectives/${A}`, { as: A, body: Body })).status, 200);
        assert.deepEqual((await Call("GET", `/progression/tracked_objectives/${A}`, { as: A })).json.payload, Body);
        assert.equal((await Call("GET", `/progression/tracked_objectives/${A}`, { as: B })).status, 403);
    });
});

describe("challenge season", () => {
    it("is a 14-week window from a Thursday 18:00 UTC reset", () => {
        const At = Date.UTC(2026, 9, 17, 12);
        const Season = ChallengeSeasonWindow(At);
        assert.equal(Season.Start, "2026-10-15T18:00:00.000Z");
        assert.equal(Date.parse(Season.End) - Date.parse(Season.Start), 14 * 7 * 24 * 3600 * 1000);
        assert.equal(ChallengeSeasonWindow(Date.parse(Season.End)).Start, Season.End);
    });

    it("bounds the active Hunt Pass in /progression/config, so the quest menu builds 14 week headers", async () => {
        const Reply = await Call("GET", "/progression/config", { as: A });
        const Active = Reply.json.payload.paths.find((Path: any) => Path.progression_id === (process.env.ACTIVE_HUNT_PASS ?? "season09b"));
        assert.ok(Active, "the active Hunt Pass is in the config");
        const Weeks = (Date.parse(Active.end_date) - Date.parse(Active.start_date)) / (7 * 24 * 3600 * 1000);
        assert.equal(Weeks, 14);
    });
});
