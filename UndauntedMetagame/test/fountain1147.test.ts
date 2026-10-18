import { RemoveTestDb } from "./setup";
import "./authenv";
import "./env1147";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { type Server } from "node:http";
import { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { GetDb } from "../src/db";
import { storepurchases } from "../src/db/schema";
import { SignMetagameJWTForUid } from "../src/controllers/auth";
import { fountain1147Router, FOUNTAIN_ITEM, FOUNTAIN_SKU, FOUNTAIN_TAG, FountainDayStart } from "../src/routes/fountain1147";
import { storeRouter } from "../src/routes/store";
import { MakePlayer, StackQuantity } from "./helpers";

// routes/fountain1147.ts in front of routes/store.ts, as mounted in app.ts: one free coin toss a day
let Listening: Server | undefined;
let Base = "";

before(async () => {
    const App = express();
    App.use(express.json());
    App.use("/", fountain1147Router);
    App.use("/", storeRouter);
    Listening = await new Promise<Server>((Resolve) => { const S = App.listen(0, "127.0.0.1", () => Resolve(S)); });
    Listening.keepAliveTimeout = 0;
    Base = `http://127.0.0.1:${(Listening.address() as AddressInfo).port}`;
});

after(async () => {
    Listening?.closeAllConnections();
    await new Promise<void>((Resolve) => Listening ? Listening.close(() => Resolve()) : Resolve());
    RemoveTestDb(() => GetDb().$client.close());
});

async function Call(As: string, Method: string, Path: string){
    const R = await fetch(Base + Path, { method: Method, headers: { authorization: `bearer ${SignMetagameJWTForUid(As)}` } });
    const Text = await R.text();
    return { status: R.status, json: Text ? JSON.parse(Text) : undefined };
}

const List = (As: string) => Call(As, "GET", `/product/skus/public?requiredTags=${FOUNTAIN_TAG}`);

describe("1.14.7 fountain (fountain_daily_free_bundle)", () => {
    it("offers one free coin toss that grants the daily core, then nothing more until the reset", async () => {
        const A = await MakePlayer();
        const Before = await List(A.UserId);
        assert.equal(Before.status, 200);
        assert.equal(Before.json.length, 1);
        assert.equal(Before.json[0].remaining, 1);
        assert.deepEqual(Before.json[0].prices, [{ currencyId: "id_currency_platinum", price: 0, salesPrice: 0 }]);

        const Token = await Call(A.UserId, "GET", `/token/platinum/${FOUNTAIN_SKU}`);
        assert.equal(Token.status, 200);
        const Redeem = `/notification/platinum?token=${Token.json.purchaseToken}`;
        assert.equal((await Call(A.UserId, "POST", Redeem)).status, 204);
        assert.equal(StackQuantity(A.CharacterId, FOUNTAIN_ITEM), 1);

        assert.equal((await Call(A.UserId, "POST", Redeem)).status, 204, "a retry grants nothing again");
        assert.equal(StackQuantity(A.CharacterId, FOUNTAIN_ITEM), 1);
        assert.equal((await List(A.UserId)).json[0].remaining, 0);
        assert.equal((await Call(A.UserId, "GET", `/token/platinum/${FOUNTAIN_SKU}`)).status, 409);
    });

    it("is available again after the daily reset", async () => {
        const A = await MakePlayer();
        const Token = await Call(A.UserId, "GET", `/token/platinum/${FOUNTAIN_SKU}`);
        await Call(A.UserId, "POST", `/notification/platinum?token=${Token.json.purchaseToken}`);
        // Yesterday's toss
        const Yesterday = new Date(Date.parse(FountainDayStart()) - 3600 * 1000).toISOString();
        GetDb().update(storepurchases).set({ redeemedDate: Yesterday }).where(eq(storepurchases.accountId, A.UserId)).run();

        assert.equal((await List(A.UserId)).json[0].remaining, 1);
        const Again = await Call(A.UserId, "GET", `/token/platinum/${FOUNTAIN_SKU}`);
        await Call(A.UserId, "POST", `/notification/platinum?token=${Again.json.purchaseToken}`);
        assert.equal(StackQuantity(A.CharacterId, FOUNTAIN_ITEM), 2);
    });
});
