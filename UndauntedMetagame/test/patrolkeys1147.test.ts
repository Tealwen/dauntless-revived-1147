import "./env1147";
import { RemoveTestDb } from "./setup";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { GetDb } from "../src/db";
import { inventory, onetimejobs } from "../src/db/schema";
import { GetInventoryForUserIdAndCharacterId } from "../src/controllers/inventory";
import { MakePlayer, StackQuantity } from "./helpers";

after(() => RemoveTestDb(() => GetDb().$client.close()));

const KEY = "TOKEN_DAILY_PATROL_BONUS";

function SetStacks(CharacterId: string, Stacks: Record<string, number>){
    const Value = JSON.stringify(Object.entries(Stacks).map(([catalogId, quantity]) => ({ catalogId, quantity })));
    GetDb().insert(inventory).values({ characterId: CharacterId, instancedItems: "[]", stackedItems: Value })
        .onConflictDoUpdate({ target: inventory.characterId, set: { stackedItems: Value } }).run();
}

// The next daily reset: today's refill job forgotten
function NextDay(CharacterId: string){
    GetDb().delete(onetimejobs).where(eq(onetimejobs.jobId, `patrol_keys_${CharacterId}_${new Date(Date.now() - 17 * 3600 * 1000).toISOString().slice(0, 10)}`)).run();
}

// controllers/inventory.ts on 1.14.7: patrol keys come back to 10 at each daily reset, never past 10
describe("1.14.7 daily patrol keys", () => {
    it("a new character gets 10 keys", async () => {
        const { UserId, CharacterId } = await MakePlayer();
        await GetInventoryForUserIdAndCharacterId(UserId, CharacterId);
        assert.equal(StackQuantity(CharacterId, KEY), 10);
    });

    it("spent keys come back to 10 at the next reset, once a day", async () => {
        const { UserId, CharacterId } = await MakePlayer();
        await GetInventoryForUserIdAndCharacterId(UserId, CharacterId);
        SetStacks(CharacterId, { [KEY]: 3 });

        await GetInventoryForUserIdAndCharacterId(UserId, CharacterId);
        assert.equal(StackQuantity(CharacterId, KEY), 3, "same day: no second refill");

        NextDay(CharacterId);
        await GetInventoryForUserIdAndCharacterId(UserId, CharacterId);
        assert.equal(StackQuantity(CharacterId, KEY), 10);
    });

    it("a player holding more than 10 keeps them all and gets none", async () => {
        const { UserId, CharacterId } = await MakePlayer();
        SetStacks(CharacterId, { [KEY]: 14, TOKEN_DAILY_PATROL_BONUS_PURCHASED: 2 });
        await GetInventoryForUserIdAndCharacterId(UserId, CharacterId);
        assert.equal(StackQuantity(CharacterId, KEY), 14);
        assert.equal(StackQuantity(CharacterId, "TOKEN_DAILY_PATROL_BONUS_PURCHASED"), 2);
    });
});
