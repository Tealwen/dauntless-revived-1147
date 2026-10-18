import { RemoveTestDb } from "./setup";
import "./authenv";
import { WithEnv } from "./appenv";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Call, StartApp, StopApp } from "./appclient";
import { GetDb } from "../src/db";
import { users } from "../src/db/schema";
import { AcceptPartyInvite, InviteToParty, LeaveParty, PollParty } from "../src/controllers/party";
import {
    CLAIM_GRACE_MS, DrawPrizePool, INVITE_EXPIRY_HOURS, LINK_DURATION_HOURS, POOL_WAIT_MS, SetSlayerLink1147ClockForTests, SetSlayerLink1147RandomForTests
} from "../src/controllers/slayerlinks1147";

// Slayer Links with the 1.14.7 client (routes/slayerlinks1147.ts): the client's invites and polls, the game
// server's prize pool, rewards and removal, and the link charging on Hunt Pass XP earned in a party
// (PORT-1.14.7/11-slayer-links.md). The progression config is the 1.14.7 folder, with the
// Linked_Slayer_Slot_1..3 tracks (4 levels of 36 XP).

const HOUR = 60 * 60 * 1000;
let Counter = 0;
let Now = Date.UTC(2026, 9, 18, 12);

before(async () => {
    await StartApp();
});

after(async () => {
    await StopApp();
    RemoveTestDb(() => GetDb().$client.close());
});

afterEach(() => {
    SetSlayerLink1147ClockForTests();
    SetSlayerLink1147RandomForTests();
});

const With1147 = <T>(Body: () => Promise<T>) => WithEnv({
    TARGET_GAME_VERSION: "1.14.7",
    ACTIVE_HUNT_PASS: "season43",
    PROGRESSION_CONFIG_DIR: path.resolve("src/vendor/progression-1147")
}, async () => {
    Now += 400 * 24 * HOUR;
    SetSlayerLink1147ClockForTests(() => Now);
    return await Body();
});

function Player(Name: string){
    const UserId = `UID-l1147-${++Counter}-${Name}`;

    GetDb().insert(users).values({ userId: UserId, name: `${Name}${Counter}`, notes: 0, isAdmin: false }).run();
    return UserId;
}

async function Befriend(A: string, B: string){
    assert.equal((await Call("POST", `/friends/api/public/friends/${A}/${B}`, { as: A })).status, 204);
    assert.equal((await Call("POST", `/friends/api/public/friends/${B}/${A}`, { as: B })).status, 204);
}

async function Party(A: string, B: string){
    const PartyA = (await PollParty(A) as any).partyId;

    assert.equal(InviteToParty(A, B, PartyA).Status, 200);
    assert.equal((await AcceptPartyInvite(B, PartyA)).Status, 200);
}

const Invite = (From: string, To: string, Slot: number) => Call("PUT", "/slayerlink/invite", { as: From, body: { account_id: To, slot: Slot, action_source: "social_panel" } });
const Answer = (By: string, Other: string, Action: string, Slot = 1) => Call("POST", "/slayerlink/invite", { as: By, body: { account_id: Other, action: Action, slot: Slot, action_source: "dedicated_screen" } });
const Status = async (Of: string) => {
    const Reply = await Call("GET", "/slayerlink/status_good", { as: Of });
    assert.equal(Reply.status, 200, Reply.text);
    return Reply.json.payload;
};
const HuntPassXp = (Of: string, Amount: number) => Call("POST", `/progression/${Of}/season43/${Amount}`, { gs: true });
const LinkTrack = async (Of: string, Slot: number) =>
    ((await Call("GET", `/progression/${Of}`, { as: Of })).json.payload as any[]).find((Track) => Track.progression_id === `Linked_Slayer_Slot_${Slot}`);

async function Linked(A: string, B: string, SlotA = 1, SlotB = 1){
    await Befriend(A, B);
    assert.equal((await Invite(A, B, SlotA)).status, 200);
    assert.equal((await Answer(B, A, "accept", SlotB)).status, 200);
}

describe("Slayer Links (1.14.7)", () => {
    it("the invite shows on both sides with the 1.14.7 strings and a 48 h expiry; accepting makes the link", () => With1147(async () => {
        const A = Player("Ann"), B = Player("Ben");

        await Befriend(A, B);
        assert.equal((await Invite(A, B, 2)).status, 200);

        const Sent = await Status(A), Got = await Status(B);

        assert.deepEqual(Sent.config, { link_duration_hours: LINK_DURATION_HOURS, invite_expiry_hours: INVITE_EXPIRY_HOURS });
        assert.equal(INVITE_EXPIRY_HOURS, 48);
        assert.equal(Sent.invites[0].direction, "sent");
        assert.equal(Got.invites[0].direction, "received");
        assert.equal(Got.invites[0].status, "pending");
        assert.equal(Got.invites[0].account_id, A);
        assert.equal(Got.invites[0].slot, 2);
        assert.equal(Got.invites[0].expires, new Date(Now + 48 * HOUR).toISOString());

        assert.equal((await Answer(B, A, "accept", 3)).status, 200);

        const LinkA = (await Status(A)).links[0], LinkB = (await Status(B)).links[0];

        assert.equal(LinkA.linked_account_id, B);
        assert.equal(LinkA.slot, 2);
        assert.equal(LinkB.slot, 3);
        assert.equal(LinkA.ends, new Date(Now + 168 * HOUR).toISOString());
        assert.deepEqual((await Status(B)).invites, []);

        const Links = (await Call("GET", "/slayerlink/links", { as: A })).json.payload.links;
        assert.equal(Links[0].account_id, B);
        assert.deepEqual(Links[0].prize_pool, [], "no pool yet: the game server sends it");
    }));

    it("reject and cancel end the invite on both sides", () => With1147(async () => {
        const A = Player("Cat"), B = Player("Dan");

        await Befriend(A, B);
        assert.equal((await Invite(A, B, 1)).status, 200);
        assert.equal((await Answer(B, A, "reject")).status, 200);
        assert.deepEqual((await Status(A)).invites, []);

        assert.equal((await Invite(A, B, 1)).status, 200);
        assert.equal((await Answer(A, B, "cancel")).status, 200);
        assert.deepEqual((await Status(B)).invites, []);
        assert.deepEqual((await Status(B)).links, []);
    }));

    it("the game server's prize pool is kept, shared, and only the first one", () => With1147(async () => {
        const A = Player("Eve"), B = Player("Fay");
        await Linked(A, B, 1, 2);

        const Pool = [
            { catalog_id: "CURRENCY_NOTES", quantity: 2000, received_for_level: 1 },
            { catalog_id: "AC_HEAD_CROWN", quantity: 1, received_for_level: -1 }
        ];

        assert.equal((await Call("PUT", "/slayerlink/links/rewards", { gs: true, body: { links: [{ account_id: A, slot: 1, prize_pool: Pool }] } })).status, 200);
        assert.equal((await Call("PUT", "/slayerlink/links/rewards", { gs: true, body: { links: [{ account_id: B, slot: 2, prize_pool: [Pool[1]] }] } })).status, 200);

        assert.deepEqual((await Status(A)).links[0].prize_pool, Pool);
        assert.deepEqual((await Status(B)).links[0].prize_pool, Pool);
    }));

    it("a link with no pool from a game server gets one drawn: 12 prizes, levels 1 to 4 once each", () => With1147(async () => {
        const A = Player("Gil"), B = Player("Hal");
        await Linked(A, B);

        Now += POOL_WAIT_MS;

        const Pool = (await Status(A)).links[0].prize_pool;

        assert.equal(Pool.length, 12);
        assert.deepEqual(Pool.map((Prize: any) => Prize.received_for_level).filter((Level: number) => Level > 0).sort(), [1, 2, 3, 4]);
        assert.deepEqual((await Status(B)).links[0].prize_pool, Pool);

        // The draw follows the cooked table: 5 + 4 + 2 + 1
        SetSlayerLink1147RandomForTests(() => 0);
        assert.equal(DrawPrizePool().length, 12);
    }));

    it("Hunt Pass XP charges the link only while the two are in one party", () => With1147(async () => {
        const A = Player("Ida"), B = Player("Jon");
        await Linked(A, B, 1, 3);

        assert.equal((await HuntPassXp(A, 12)).status, 200);
        assert.equal((await LinkTrack(A, 1)).progress, 0, "not partied");

        await Party(A, B);
        assert.equal((await HuntPassXp(A, 12)).status, 200);
        assert.equal((await HuntPassXp(B, 40)).status, 200);
        assert.equal((await LinkTrack(A, 1)).progress, 12);
        assert.equal((await LinkTrack(B, 3)).progress, 40);

        LeaveParty(B);
    }));

    it("after the week the game server gets the prizes of the level reached, once; the slot frees", () => With1147(async () => {
        const A = Player("Kim"), B = Player("Lee");
        await Linked(A, B, 1, 1);

        const Pool = [1, 2, 3, 4, -1].map((Level, Index) => ({ catalog_id: `CURRENCY_NOTES`, quantity: 1000 * (Index + 1), received_for_level: Level }));
        await Call("PUT", "/slayerlink/links/rewards", { gs: true, body: { links: [{ account_id: A, slot: 1, prize_pool: Pool }] } });

        await Party(A, B);
        await HuntPassXp(A, 36 * 2 + 5);  // level 2

        assert.equal((await Call("GET", `/slayerlink/links/rewards/${A}/1`, { gs: true })).status, 409, "still running");

        Now += 168 * HOUR + 1;

        const Got = await Call("GET", `/slayerlink/links/rewards/${A}/1`, { gs: true });
        assert.equal(Got.status, 200, Got.text);
        assert.deepEqual(Got.json.payload, { is_service_granting: false, rewards: [Pool[0], Pool[1]] });

        const Again = await Call("GET", `/slayerlink/links/rewards/${A}/1`, { gs: true });
        assert.deepEqual(Again.json.payload.rewards, [], "handed out once");

        const ForB = await Call("GET", `/slayerlink/links/rewards/${B}/1`, { gs: true });
        assert.deepEqual(ForB.json.payload.rewards, [], "B earned nothing");

        // Shown for the summary screen, then gone; the slot takes a new link at once ("Link Again")
        assert.equal((await Status(A)).links.length, 1);
        assert.equal((await Invite(A, B, 1)).status, 200);
        Now += CLAIM_GRACE_MS;
        assert.equal((await Status(A)).links.length, 0);
        LeaveParty(B);
    }));

    it("a running link is cancelled for both unless charged; a finished one leaves one side", () => With1147(async () => {
        const A = Player("Mia"), B = Player("Ned"), C = Player("Oli");
        await Linked(A, B, 1, 1);

        assert.equal((await Call("DELETE", "/slayerlink/links", { gs: true, body: { links: [{ account_id: A, slot: 1, delete_pair: true }] } })).status, 200);
        assert.deepEqual((await Status(A)).links, []);
        assert.deepEqual((await Status(B)).links, []);

        await Linked(A, C, 2, 2);
        await Party(A, C);
        await HuntPassXp(C, 10);
        assert.equal((await Call("DELETE", "/slayerlink/links", { gs: true, body: { links: [{ account_id: C, slot: 2, delete_pair: true }] } })).status, 409);

        Now += 168 * HOUR + 1;
        assert.equal((await Call("DELETE", "/slayerlink/links", { as: A, body: { links: [{ account_id: C, slot: 2, delete_pair: false }] } })).status, 200);
        assert.deepEqual((await Status(A)).links, []);
        assert.equal((await Status(C)).links.length, 1, "C can still unlock its rewards");
        LeaveParty(C);
    }));

    it("accepting on the last free slot declines the other invites", () => With1147(async () => {
        const A = Player("Pam"), B = Player("Quinn"), C = Player("Rae"), D = Player("Sam"), E = Player("Tia");

        await Linked(B, A, 1, 1);
        await Linked(C, A, 1, 2);
        await Befriend(D, A);
        await Befriend(E, A);
        assert.equal((await Invite(D, A, 1)).status, 200);
        assert.equal((await Invite(E, A, 1)).status, 200);
        assert.equal((await Status(A)).invites.length, 2);

        assert.equal((await Answer(A, D, "accept", 3)).status, 200);
        assert.deepEqual((await Status(A)).invites, []);
        assert.deepEqual((await Status(E)).invites, []);
    }));

    it("a player cannot take another player's rewards; strangers and the 1.4.4 server are untouched", async () => {
        await With1147(async () => {
            const A = Player("Uma"), B = Player("Vic"), C = Player("Wes");
            await Linked(A, B);
            Now += 168 * HOUR + 1;

            assert.equal((await Call("GET", `/slayerlink/links/rewards/${A}/1`, { as: B })).status, 403);
            assert.equal((await Call("GET", `/slayerlink/links/rewards/${A}/1`, { as: C })).status, 404);
            assert.equal((await Call("GET", `/slayerlink/links/rewards/${A}/1`, { as: A })).status, 200);
        });

        await WithEnv({ TARGET_GAME_VERSION: undefined }, async () => {
            const A = Player("Xan");
            assert.equal((await Call("GET", `/slayerlink/links/rewards/${A}/1`, { gs: true })).status, 404, "1.4.4 never answered it");
        });
    });
});
