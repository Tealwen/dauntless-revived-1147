import { RemoveTestDb } from "./setup";
import "./authenv";
import { WithEnv } from "./appenv";
import "./env1147";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { GetDb } from "../src/db";
import { trackedobjectives1147 } from "../src/db/schema";
import { Call, StartApp, StopApp } from "./appclient";
import { MakePlayer } from "./helpers";

// routes/compat1147.ts fixes of the October 2026 audit (PORT-1.14.7/20-optimisation-globale.md): tracked
// objectives in the database and bounded, seasonal journeys writable, 1.14.7-only routes off in 1.4.4 mode,
// and the cached /progression/config reply.
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

describe("tracked objectives storage", () => {
    it("are kept in the database, under the account id only", async () => {
        const Body = { current_set: "quest_slayer_links", omitted_quests: [], tracked_craftables: ["C1"], tracked_quests: [] };
        assert.equal((await Call("POST", `/progression/tracked_objectives/${A}`, { as: A, body: Body })).status, 200);
        const Row = GetDb().select().from(trackedobjectives1147).where(eq(trackedobjectives1147.accountId, A)).get();
        assert.deepEqual(JSON.parse(Row!.body), Body);
        // An account-suffixed key used to add a new entry each time
        assert.equal((await Call("POST", `/progression/tracked_objectives/${A}-x`, { as: A, body: Body })).status, 403);
    });

    it("refuse a body that is not an object, or is too large", async () => {
        assert.equal((await Call("POST", `/progression/tracked_objectives/${A}`, { as: A, body: [1, 2] })).status, 400);
        const Big = { tracked_quests: ["Q".repeat(20 * 1024)] };
        assert.equal((await Call("POST", `/progression/tracked_objectives/${A}`, { as: A, body: Big })).status, 413);
    });
});

describe("seasonal Slayer's Path", () => {
    it("is saved by the game server and read back by any player", async () => {
        const Nodes = { Faction_0: { state: 1 } };
        assert.equal((await Call("POST", "/pjm/seasonal/43-2", { as: A, body: { nodes: Nodes } })).status, 403);
        assert.equal((await Call("POST", "/pjm/seasonal/43-2", { gs: true, body: { nodes: Nodes } })).status, 200);
        assert.deepEqual((await Call("GET", "/pjm/seasonal/43-2", { as: B })).json.payload.nodes, Nodes);
    });
});

describe("1.4.4 mode", () => {
    it("answers none of the 1.14.7-only routes", async () => {
        await WithEnv({ TARGET_GAME_VERSION: undefined }, async () => {
            assert.equal((await Call("GET", "/isbanned", { as: A })).status, 404);
            assert.equal((await Call("GET", "/survey/config", { as: A })).status, 404);
            assert.equal((await Call("POST", `/pjm/${A}`, { gs: true, body: { nodes: {} } })).status, 404);
        });
    });
});

describe("/progression/config", () => {
    it("gives the same reply twice (cached)", async () => {
        const First = await Call("GET", "/progression/config", { as: A });
        const Second = await Call("GET", "/progression/config", { as: A });
        assert.equal(First.status, 200);
        assert.equal(First.text, Second.text);
    });

    it("level_access answers without a token", async () => {
        assert.equal((await Call("GET", "/progression/level_access/")).status, 200);
    });
});
