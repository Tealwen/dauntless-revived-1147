import "./env1147";
import { RemoveTestDb } from "./setup";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GetDb } from "../src/db";
import { GetBountyReply, SetBounties } from "../src/controllers/bounties";
import { bounties } from "../src/db/schema";
import { MakePlayer } from "./helpers";

after(() => RemoveTestDb(() => GetDb().$client.close()));

const Bounty = (Id: string, Slot: number, Version: number, Claimed = false) => ({bounty_id: Id, premium_bounty: false, slot_index: Slot, objectives: [{objective_id: `${Id}_OBJ`, progress: 1}], drafted_timestamp: "2026-10-17T14:31:05.123Z", update_version: Version, claimed: Claimed});
const Ids = (UserId: string) => GetBountyReply(UserId).payload.bounties.map((B: any) => B.bounty_id);

// controllers/bounties.ts on 1.14.7: a claimed board bounty leaves the board, a claimed challenge stays
describe("1.14.7 claimed bounties", () => {
    it("a board bounty sent back as claimed is removed, so its slot can be drafted again", async () => {
        const {UserId} = await MakePlayer();
        SetBounties(UserId, {bounties: [Bounty("Bounty_Bronze_KillAxePike", 0, 0), Bounty("Bounty_Silver_X", 1, 0)]}, "gameserver");

        assert.equal(SetBounties(UserId, {bounties: [Bounty("Bounty_Bronze_KillAxePike", 0, 1, true)]}, "gameserver").Status, 200);
        assert.deepEqual(Ids(UserId), ["Bounty_Silver_X"]);

        SetBounties(UserId, {bounties: [Bounty("Bounty_Bronze_HuntsSwordTwo", 0, 0)]}, "gameserver");
        assert.deepEqual(Ids(UserId), ["Bounty_Bronze_HuntsSwordTwo", "Bounty_Silver_X"]);
    });

    it("a claimed challenge is kept, claimed", async () => {
        const {UserId} = await MakePlayer();
        const Weekly = "43_11_3_Challenge_Season_Wounds_1Fight-season43-10";
        SetBounties(UserId, {bounties: [Bounty(Weekly, 2, 1, true)]}, "gameserver");

        assert.deepEqual(GetBountyReply(UserId).payload.bounties.map((B: any) => [B.bounty_id, B.claimed]), [[Weekly, true]]);
    });

    it("a claimed board bounty stored before the fix is no longer sent", async () => {
        const {UserId} = await MakePlayer();
        GetDb().insert(bounties).values({accountId: UserId, bountyId: "Bounty_Gold_Old", slotIndex: 3, updateVersion: 2,
            data: JSON.stringify(Bounty("Bounty_Gold_Old", 3, 2, true)), updatedDate: new Date().toISOString()}).run();

        assert.deepEqual(Ids(UserId), []);
    });
});
