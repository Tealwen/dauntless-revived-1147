import { RemoveTestDb } from "./setup";
import "./matchmakingenv";
import "./env1147";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { CheckAndUpdateQueueStatus, HandlePlayerMatchmaking, ResetMatchmakingForTests } from "../src/controllers/matchmaking";
import { MatchmakingRoster } from "../src/controllers/matchmakingroster";
import { GetDb } from "../src/db";
import { users } from "../src/db/schema";
import { AcceptPartyInvite, InviteToParty, PollParty, ResetPartiesForTests, SetPartyClockForTests } from "../src/controllers/party";

after(() => RemoveTestDb(() => GetDb().$client.close()));

// controllers/matchmaking.ts on 1.14.7: a classic hunt (ShatteredIsles_Island<X>) already running with room
// takes the next players asking for it, up to 4, for 30 minutes; any other hunt still gets a server per queue.
const CLASSIC = "ShatteredIsles_IslandA";
let Now = 1_000_000;
let Launches: any[] = [];
let Alive = new Set<string>();
const OriginalFetch = globalThis.fetch;

beforeEach(() => {
    ResetMatchmakingForTests();
    Now = 1_000_000;
    Launches = [];
    Alive = new Set();
    SetPartyClockForTests(() => Now);
    globalThis.fetch = (async (url: any, init: any) => {
        if (String(url).endsWith("/gameservers")) {
            return new Response(JSON.stringify({ complete: true, servers: [...Alive].map((id) => ({ id })) }), { status: 200, headers: { "content-type": "application/json" } });
        }
        Launches.push(JSON.parse(init.body));
        const sessionId = `00000000-0000-4000-8000-${String(Launches.length).padStart(12, "0")}`;
        Alive.add(sessionId);
        return new Response(JSON.stringify({ host: "127.0.0.1", port: 39000 + Launches.length, sessionId }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = OriginalFetch;
    SetPartyClockForTests();
    ResetMatchmakingForTests();
});

// A player queues alone and, 6 s later, their poll gets the server
async function StartHunt(Player: string, Hunt = CLASSIC){
    assert.equal(await HandlePlayerMatchmaking("SHARED", "", Hunt, Player), true);
    Now += 6000;
    const Entry = await CheckAndUpdateQueueStatus(Player);
    assert.equal(Entry?.Ready, true);
    return Entry!;
}

async function Join(Player: string, Hunt = CLASSIC){
    assert.equal(await HandlePlayerMatchmaking("SHARED", "", Hunt, Player), true);
    return (await CheckAndUpdateQueueStatus(Player))!;
}

describe("1.14.7 classic hunts joined in progress", () => {
    it("sends the next players to the running hunt, without starting another server", async () => {
        const First = await StartHunt("UID-a");
        Now += 60_000;
        const Second = await Join("UID-b");
        assert.equal(Second.Ready, true);
        assert.equal(`${Second.Host}:${Second.Port}`, `${First.Host}:${First.Port}`);
        assert.equal(Second.SessionId, First.SessionId);
        assert.equal(Launches.length, 1);

        // The hunt server's expected-player answer now includes the player who joined
        const Expected = MatchmakingRoster.reconcileExpected(["UID-a"], { sessionId: First.SessionId });
        assert.deepEqual(Expected.sort(), ["UID-a", "UID-b"]);
    });

    it("fills up to 4 players, then starts a new server", async () => {
        const First = await StartHunt("UID-a");
        for (const Player of ["UID-b", "UID-c", "UID-d"]) assert.equal((await Join(Player)).Port, First.Port);
        assert.equal(Launches.length, 1);

        const Fifth = await StartHunt("UID-e");
        assert.notEqual(Fifth.Port, First.Port);
        assert.equal(Launches.length, 2);
    });

    it("a seat comes back when a player has left the server", async () => {
        const First = await StartHunt("UID-a");
        for (const Player of ["UID-b", "UID-c", "UID-d"]) await Join(Player);
        // Everyone arrived, then UID-d left: the game server's snapshot no longer lists them
        MatchmakingRoster.reconcileExpected(["UID-a"], { sessionId: First.SessionId, connectedPlayerIds: ["UID-a", "UID-b", "UID-c", "UID-d"] });
        Now += 60_000;
        MatchmakingRoster.reconcileExpected(["UID-a"], { sessionId: First.SessionId, connectedPlayerIds: ["UID-a", "UID-b", "UID-c"] });
        Now += 60_000;
        MatchmakingRoster.reconcileExpected(["UID-a"], { sessionId: First.SessionId, connectedPlayerIds: ["UID-a", "UID-b", "UID-c"] });

        assert.equal((await Join("UID-e")).Port, First.Port);
        assert.equal(Launches.length, 1);
    });

    it("is not joined after 30 minutes, nor once its server has exited", async () => {
        const First = await StartHunt("UID-a");
        Now += 31 * 60_000;
        assert.notEqual((await StartHunt("UID-b")).Port, First.Port);

        const Second = Launches.length;
        Alive.clear();
        Now += 60_000;
        await StartHunt("UID-c");
        assert.equal(Launches.length, Second + 1);
    });

    it("a party joins when there is a seat for every member, and gets its own server otherwise", async () => {
        for (const UserId of ["UID-p1", "UID-p2", "UID-p3", "UID-q1", "UID-q2", "UID-q3"])
            GetDb().insert(users).values({ userId: UserId, name: UserId.slice(4), notes: 0 }).onConflictDoNothing().run();
        ResetPartiesForTests();
        const Form = async (Leader: string, ...Members: string[]) => {
            const Party = await PollParty(Leader) as any;
            for (const Member of Members) {
                await PollParty(Member);
                assert.equal(InviteToParty(Leader, Member, Party.partyId).Status, 200);
                assert.equal((await AcceptPartyInvite(Member, Party.partyId)).Status, 200);
            }
        };

        const First = await StartHunt("UID-a");
        await Join("UID-b");
        // Two seats left: a party of two fits
        await Form("UID-p1", "UID-p2");
        assert.equal(await HandlePlayerMatchmaking("SHARED", "", CLASSIC, "UID-p1"), true);
        assert.equal((await CheckAndUpdateQueueStatus("UID-p2"))?.Port, First.Port);
        assert.equal(Launches.length, 1);

        // Full now: a party of three gets a new server with all of its members expected
        await Form("UID-q1", "UID-q2", "UID-q3");
        assert.equal(await HandlePlayerMatchmaking("SHARED", "", CLASSIC, "UID-q1"), true);
        await new Promise((Resolve) => setTimeout(Resolve, 20));
        assert.equal(Launches.length, 2);
        assert.deepEqual([...Launches[1].ExpectedPlayers].sort(), ["UID-q1", "UID-q2", "UID-q3"]);
        ResetPartiesForTests();
    });

    it("leaves other hunts and other regions alone", async () => {
        await StartHunt("UID-a", "CR19_PlayerHunt_Escalation_Thunderbird_Easy");
        await StartHunt("UID-b", "CR19_PlayerHunt_Escalation_Thunderbird_Easy");
        assert.equal(Launches.length, 2);

        await StartHunt("UID-c", "ShatteredIsles_IslandB");
        await StartHunt("UID-d", CLASSIC);
        assert.equal(Launches.length, 4, "another island is another hunt");
    });
});
