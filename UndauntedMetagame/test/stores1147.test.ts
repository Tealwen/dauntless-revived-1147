import { RemoveTestDb } from "./setup";
import "./authenv";
import "./env1147";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { type Server } from "node:http";
import { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { GetDb } from "../src/db";
import { entitlements, inventory } from "../src/db/schema";
import { SignMetagameJWTForUid } from "../src/controllers/auth";
import { stores1147Router } from "../src/routes/stores1147";
import { storeRouter } from "../src/routes/store";
import { MakePlayer, StackQuantity } from "./helpers";

// routes/stores1147.ts in front of routes/store.ts, as mounted in app.ts, with TARGET_GAME_VERSION=1.14.7:
// the Reward Cache (season_store), Lady Luck (ladyluckstore) and the Research Lab (weekly_cell_offering,
// exchange_vendor_slot_2/3) end to end, in the 1.14.7 offer shape and with the 1.14.7 currency path segments.
let Listening: Server | undefined;
let Base = "";

before(async () => {
    const App = express();
    App.use(express.json());
    App.use("/", stores1147Router);
    App.use("/", storeRouter);
    App.use((_req, res) => { res.status(418).send(); });
    Listening = await new Promise<Server>((Resolve) => { const S = App.listen(0, "127.0.0.1", () => Resolve(S)); });
    Listening.keepAliveTimeout = 0;
    Base = `http://127.0.0.1:${(Listening.address() as AddressInfo).port}`;
});

after(async () => {
    Listening?.closeAllConnections();
    await new Promise<void>((Resolve) => Listening ? Listening.close(() => Resolve()) : Resolve());
    RemoveTestDb(() => GetDb().$client.close());
});

beforeEach(() => {
    process.env.TARGET_GAME_VERSION = "1.14.7";
    process.env.STORE = "off";
    process.env.TRIALS_STORE = "1";
    process.env.MIDDLEMAN_STORE = "1";
    delete process.env.REWARD_CACHE_STORE;
    delete process.env.REWARD_CACHE_FREE;
});

async function Call(As: string, Method: string, Path: string){
    const R = await fetch(Base + Path, { method: Method, headers: { authorization: `bearer ${SignMetagameJWTForUid(As)}` } });
    const Text = await R.text();
    return { status: R.status, json: Text ? JSON.parse(Text) : undefined };
}

function Credit(CharacterId: string, Stacks: Record<string, number>){
    const Value = JSON.stringify(Object.entries(Stacks).map(([catalogId, quantity]) => ({ catalogId, quantity })));
    GetDb().insert(inventory).values({ characterId: CharacterId, instancedItems: "[]", stackedItems: Value })
        .onConflictDoUpdate({ target: inventory.characterId, set: { stackedItems: Value } }).run();
}

function Instanced(CharacterId: string){
    const Row = GetDb().select().from(inventory).where(eq(inventory.characterId, CharacterId)).get();
    return JSON.parse(Row?.instancedItems ?? "[]") as any[];
}

// Every listed offer must be one the 1.14.7 parser keeps: a non-empty prices[] of {currencyId, price, salesPrice}
function Assert1147Shape(Offer: any){
    assert.ok(Array.isArray(Offer.prices) && Offer.prices.length > 0, Offer.id);
    for(const Price of Offer.prices){
        assert.equal(typeof Price.currencyId, "string");
        assert.ok(Number.isInteger(Price.price) && Number.isInteger(Price.salesPrice), Offer.id);
    }
    for(const Field of ["platinumPrice", "cellDustPrice", "steelMarksPrice", "gildedMarksPrice", "event01Price", "prestigePrice"]){
        assert.ok(!(Field in Offer), `${Offer.id} still has ${Field}`);
    }
    assert.ok(Number.isInteger(Offer.remaining) && Number.isInteger(Offer.maxAllowed) && Number.isInteger(Offer.displayPriority));
}

async function Buy(As: string, Currency: string, Sku: string){
    const Token = await Call(As, "GET", `/token/${Currency}/${Sku}`);
    assert.equal(Token.status, 200, JSON.stringify(Token.json));
    const Path = `/notification/${Currency}?token=${Token.json.purchaseToken}`;
    assert.equal((await Call(As, "POST", Path)).status, 204);
    return Path;
}

describe("1.14.7 Reward Cache (season_store)", () => {
    it("is off outside 1.14.7 and with REWARD_CACHE_STORE=0 (the store stub answers [])", async () => {
        const A = await MakePlayer();
        process.env.TARGET_GAME_VERSION = "1.4.4";
        assert.notEqual((await Call(A.UserId, "GET", "/product/skus/public?requiredTags=season_store")).json?.length > 0, true);
        process.env.TARGET_GAME_VERSION = "1.14.7";
        process.env.REWARD_CACHE_STORE = "0";
        const Off = await Call(A.UserId, "GET", "/product/skus/public?requiredTags=season_store");
        assert.equal(Off.status, 200);
        assert.deepEqual(Off.json, []);
    });

    it("lists Cache Coin offers in the seasonal store tabs", async () => {
        const A = await MakePlayer();
        const Listed = await Call(A.UserId, "GET", "/product/skus/public?requiredTags=season_store");

        assert.equal(Listed.status, 200);
        assert.ok(Listed.json.length > 100);
        for(const Offer of Listed.json){
            Assert1147Shape(Offer);
            assert.equal(Offer.tags[0], "season_store");
            assert.deepEqual(Offer.prices.map((P: any) => P.currencyId), ["id_currency_seasonal_coin"]);
            assert.ok(Offer.id.startsWith("rewardcache_"));
        }
        const Tabs = new Set(Listed.json.map((Offer: any) => Offer.tags[1]));
        for(const Tab of ["season_store_event", "tab_season_armour", "tab_season_weapon", "tab_season_style", "tab_season_limited", "season_store_general"]){
            assert.ok(Tabs.has(Tab), Tab);
        }
    });

    it("takes the coins once, grants the item, then reads as owned", async () => {
        const A = await MakePlayer();
        const Sku = "rewardcache_single_armour_monk_chest";
        const Offer = (await Call(A.UserId, "GET", `/product/sku/${Sku}`)).json;
        const Price = Offer.prices[0].price;
        Credit(A.CharacterId, { CURRENCY_SEASONAL_COIN: Price + 7 });

        const Path = await Buy(A.UserId, "id_currency_seasonal_coin", Sku);
        assert.equal((await Call(A.UserId, "POST", Path)).status, 204); // a retried redeem grants nothing again

        assert.equal(StackQuantity(A.CharacterId, "CURRENCY_SEASONAL_COIN"), 7);
        const Held = StackQuantity(A.CharacterId, "AR_HP07A_MONK_CHEST") + Instanced(A.CharacterId).filter((I) => I.catalogId === "AR_HP07A_MONK_CHEST").length;
        assert.equal(Held, 1);
        assert.equal((await Call(A.UserId, "GET", `/product/sku/${Sku}`)).json.remaining, 0);
        assert.equal((await Call(A.UserId, "GET", `/token/id_currency_seasonal_coin/${Sku}`)).status, 409);
    });

    it("refuses a purchase without enough coins or in another currency", async () => {
        const A = await MakePlayer();
        const Sku = "rewardcache_single_armour_monk_chest";
        Credit(A.CharacterId, { CURRENCY_SEASONAL_COIN: 1 });
        assert.equal((await Call(A.UserId, "GET", `/token/id_currency_seasonal_coin/${Sku}`)).status, 409);
        assert.equal((await Call(A.UserId, "GET", `/token/platinum/${Sku}`)).status, 400);

        process.env.REWARD_CACHE_FREE = "1";
        await Buy(A.UserId, "id_currency_seasonal_coin", Sku);
        assert.equal(StackQuantity(A.CharacterId, "CURRENCY_SEASONAL_COIN"), 1);
    });
});

describe("1.14.7 Lady Luck and Research Lab through routes/store.ts", () => {
    it("lists Lady Luck in the 1.14.7 shape and sells for Steel Marks on the markssteel path", async () => {
        const A = await MakePlayer();
        const Listed = await Call(A.UserId, "GET", "/product/skus/public?requiredTags=ladyluckstore");

        assert.equal(Listed.status, 200);
        assert.equal(Listed.json.length, 58);
        Listed.json.forEach(Assert1147Shape);
        const Cell = Listed.json.find((Offer: any) => Offer.id === "trials_cell_discipline_e");
        assert.deepEqual(Cell.prices, [{ currencyId: "id_currency_marks_steel", price: 150, salesPrice: 0 }]);

        Credit(A.CharacterId, { CURRENCY_MARKS_STEEL: 150 });
        await Buy(A.UserId, "markssteel", "trials_cell_discipline_e");
        assert.equal(StackQuantity(A.CharacterId, "CURRENCY_MARKS_STEEL"), 0);
        assert.equal(StackQuantity(A.CharacterId, "CELL_TRIALS_05_E"), 1);
    });

    it("lists the weekly cells for Aetherdust and sells one on the celldust path", async () => {
        const A = await MakePlayer();
        const Listed = await Call(A.UserId, "GET", "/product/skus/public?requiredTags=weekly_cell_offering");

        assert.equal(Listed.status, 200);
        assert.equal(Listed.json.length, 3);
        Listed.json.forEach(Assert1147Shape);
        const Offer = Listed.json[0];
        assert.equal(Offer.prices[0].currencyId, "id_currency_celldust");

        Credit(A.CharacterId, { CURRENCY_CELLDUST: Offer.prices[0].price });
        await Buy(A.UserId, "celldust", Offer.id);
        assert.equal(StackQuantity(A.CharacterId, "CURRENCY_CELLDUST"), 0);
        assert.equal(StackQuantity(A.CharacterId, Offer.items[0].catalogId), 1);
    });

    it("sells the second fusion slot (entitlement exchange_slot_2) on the platinum path", async () => {
        const A = await MakePlayer();
        const Listed = await Call(A.UserId, "GET", "/product/skus/public?requiredTags=exchange_vendor_slot_2");

        assert.equal(Listed.status, 200);
        assert.equal(Listed.json.length, 1);
        Assert1147Shape(Listed.json[0]);
        assert.deepEqual(Listed.json[0].prices, [{ currencyId: "id_currency_platinum", price: 0, salesPrice: 0 }]);

        await Buy(A.UserId, "platinum", Listed.json[0].id);
        const Rows = GetDb().select().from(entitlements).where(eq(entitlements.accountId, A.UserId)).all();
        assert.ok(Rows.some((Row) => Row.name === "exchange_slot_2"));
    });
});
