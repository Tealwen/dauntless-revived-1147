import { RemoveTestDb } from "./setup";
import "./authenv";
import "./env1147";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { type Server } from "node:http";
import { AddressInfo } from "node:net";
import { GetDb } from "../src/db";
import { inventory } from "../src/db/schema";
import { SignMetagameJWTForUid } from "../src/controllers/auth";
import { darkHarvest1147Router } from "../src/routes/darkharvest1147";
import { stores1147Router } from "../src/routes/stores1147";
import { storeRouter } from "../src/routes/store";
import { MakePlayer, StackQuantity } from "./helpers";

// routes/darkharvest1147.ts in front of the other store routers, as mounted in app.ts: the Dark Harvest event
// store (tags seasonal_event / rumour_store, currency id_currency_event_darkharvest) end to end.
let Listening: Server | undefined;
let Base = "";

before(async () => {
    const App = express();
    App.use(express.json());
    App.use("/", darkHarvest1147Router);
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
    for(const Key of ["DARK_HARVEST_STORE", "DARK_HARVEST_STORE_FREE", "DARK_HARVEST_STORE_GROUPS", "DARK_HARVEST_RUMOURS"]) delete process.env[Key];
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

async function Buy(As: string, Sku: string, Currency = "id_currency_event_darkharvest"){
    const Token = await Call(As, "GET", `/token/${Currency}/${Sku}`);
    assert.equal(Token.status, 200, JSON.stringify(Token.json));
    const Path = `/notification/${Currency}?token=${Token.json.purchaseToken}`;
    assert.equal((await Call(As, "POST", Path)).status, 204);
    return Path;
}

const Currency = "CURRENCY_EVENT_DARKHARVEST";

describe("1.14.7 Dark Harvest event store (seasonal_event)", () => {
    it("lists every group in the 1.14.7 shape, priced in the event currency", async () => {
        const A = await MakePlayer();
        const Listed = await Call(A.UserId, "GET", "/product/skus/public?requiredTags=seasonal_event");
        assert.equal(Listed.status, 200);
        assert.ok(Listed.json.length >= 60, String(Listed.json.length));
        for(const Offer of Listed.json){
            assert.ok(Offer.id.startsWith("darkharvest_"));
            assert.equal(Offer.tags[0], "seasonal_event");
            assert.deepEqual(Offer.prices.map((P: any) => P.currencyId), ["id_currency_event_darkharvest"]);
            assert.ok(Number.isInteger(Offer.prices[0].price) && Number.isInteger(Offer.remaining) && Number.isInteger(Offer.maxAllowed));
        }
        const Rumours = await Call(A.UserId, "GET", "/product/skus/public?requiredTags=rumour_store");
        assert.equal(Rumours.json.length, 12);
        assert.ok(Rumours.json.every((Offer: any) => Offer.tags.includes("rumour_store")));
    });

    it("is off with DARK_HARVEST_STORE=0 and keeps only the chosen groups", async () => {
        const A = await MakePlayer();
        process.env.DARK_HARVEST_STORE = "0";
        assert.deepEqual((await Call(A.UserId, "GET", "/product/skus/public?requiredTags=seasonal_event")).json, []);
        delete process.env.DARK_HARVEST_STORE;
        process.env.DARK_HARVEST_STORE_GROUPS = "event";
        const Listed = (await Call(A.UserId, "GET", "/product/skus/public?requiredTags=seasonal_event")).json;
        assert.ok(Listed.length > 0 && Listed.every((Offer: any) => !Offer.tags.includes("rumour_store")));
        assert.equal((await Call(A.UserId, "GET", "/product/sku/darkharvest_wp_ac_unseen_00")).status, 404);
    });

    it("takes the currency once, grants the item, then reads as owned", async () => {
        const A = await MakePlayer();
        const Sku = "darkharvest_ar_pumpkin_helm";
        const Price = (await Call(A.UserId, "GET", `/product/sku/${Sku}`)).json.prices[0].price;
        Credit(A.CharacterId, { [Currency]: Price + 3 });

        const Path = await Buy(A.UserId, Sku);
        assert.equal((await Call(A.UserId, "POST", Path)).status, 204); // a retried redeem grants nothing again
        assert.equal(StackQuantity(A.CharacterId, Currency), 3);
        assert.equal(StackQuantity(A.CharacterId, "AR_PUMPKIN_HELM"), 1);
        assert.equal((await Call(A.UserId, "GET", `/product/sku/${Sku}`)).json.remaining, 0);
        assert.equal((await Call(A.UserId, "GET", `/token/id_currency_event_darkharvest/${Sku}`)).status, 409);
    });

    it("sells a rumour as the Unseen item, or as the quest token with DARK_HARVEST_RUMOURS=token", async () => {
        const A = await MakePlayer();
        Credit(A.CharacterId, { [Currency]: 1000 });
        await Buy(A.UserId, "darkharvest_wp_ac_unseen_00");
        assert.equal(StackQuantity(A.CharacterId, "WP_AC_UNSEEN_00"), 1);

        process.env.DARK_HARVEST_RUMOURS = "token";
        await Buy(A.UserId, "darkharvest_wp_cb_unseen_00");
        assert.equal(StackQuantity(A.CharacterId, "TOKEN_RUMOUR_WP_CB_UNSEEN_00"), 1);
        assert.equal(StackQuantity(A.CharacterId, "WP_CB_UNSEEN_00"), 0);
        assert.equal((await Call(A.UserId, "GET", "/product/sku/darkharvest_wp_cb_unseen_00")).json.remaining, 0);
    });

    it("rolls one result of a drop table and skips owned rumours", async () => {
        const A = await MakePlayer();
        process.env.DARK_HARVEST_STORE_FREE = "1";
        Credit(A.CharacterId, { [Currency]: 0 });
        for(let I = 0; I < 7; ++I) await Buy(A.UserId, "darkharvest_rumour");
        const Tokens = ["EB", "GA", "IH", "CB", "MS", "AC", "DP"].map((W) => StackQuantity(A.CharacterId, `TOKEN_RUMOUR_WP_${W}_UNSEEN_00`));
        assert.deepEqual(Tokens, [1, 1, 1, 1, 1, 1, 1]); // ignoreOwned: seven rolls, seven different rumours
        assert.equal((await Call(A.UserId, "GET", "/product/sku/darkharvest_rumour")).json.remaining, 0);
        assert.equal((await Call(A.UserId, "GET", "/token/id_currency_event_darkharvest/darkharvest_rumour")).status, 409);

        await Buy(A.UserId, "darkharvest_pumpkin_gift");
        const Toys = ["TY_FIREWORK_DH2020", "TY_THROWN_DH2020", "TY_XFORM_DH2020", "TY_GIFT_GREATPUMPKIN"].filter((Id) => StackQuantity(A.CharacterId, Id) > 0);
        assert.equal(Toys.length, 1);
    });

    it("refuses another currency, too little currency, and leaves other tags to the next router", async () => {
        const A = await MakePlayer();
        Credit(A.CharacterId, { [Currency]: 1 });
        assert.equal((await Call(A.UserId, "GET", "/token/id_currency_event_darkharvest/darkharvest_ar_pumpkin_helm")).status, 409);
        assert.equal((await Call(A.UserId, "GET", "/token/platinum/darkharvest_ar_pumpkin_helm")).status, 400);
        const Other = await Call(A.UserId, "GET", "/product/skus/public?requiredTags=season_store");
        assert.ok(Other.json.length > 100 && Other.json.every((Offer: any) => Offer.id.startsWith("rewardcache_")));
    });
});
