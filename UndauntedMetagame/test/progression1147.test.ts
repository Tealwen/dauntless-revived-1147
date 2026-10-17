import { RemoveTestDb } from "./setup";
import "./authenv";
import { WithEnv } from "./appenv";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { type Server } from "node:http";
import { AddressInfo } from "node:net";
import { GetDb } from "../src/db";
import { SignMetagameJWTForUid } from "../src/controllers/auth";
import { ListEntitlements } from "../src/controllers/entitlements";
import { progression1147Router } from "../src/routes/progression1147";
import { MakePlayer } from "./helpers";

// routes/progression1147.ts on a private app, with a catch-all standing in for storeRouter.
let Listening: Server | undefined;
let Base = "";
let Player = "";

before(async () => {
    const App = express();
    App.use(express.json());
    App.use("/", progression1147Router);
    App.use((_req, res) => { res.status(418).send(); });
    Listening = await new Promise<Server>((Resolve) => { const S = App.listen(0, "127.0.0.1", () => Resolve(S)); });
    Listening.keepAliveTimeout = 0;
    Base = `http://127.0.0.1:${(Listening.address() as AddressInfo).port}`;
    Player = (await MakePlayer()).UserId;
});

after(async () => {
    Listening?.closeAllConnections();
    await new Promise<void>((Resolve) => Listening ? Listening.close(() => Resolve()) : Resolve());
    RemoveTestDb(() => GetDb().$client.close());
});

async function Call(Method: string, Path: string){
    const R = await fetch(Base + Path, { method: Method, headers: { authorization: `bearer ${SignMetagameJWTForUid(Player)}` } });
    const Text = await R.text();
    return { status: R.status, json: Text ? JSON.parse(Text) : undefined };
}

const With1147 = <T>(Body: () => Promise<T>) => WithEnv({ TARGET_GAME_VERSION: "1.14.7", ACTIVE_HUNT_PASS: "season43" }, Body);

describe("1.14.7 Elite Hunt Pass offer", () => {
    it("is off outside 1.14.7", async () => {
        await WithEnv({ TARGET_GAME_VERSION: undefined }, async () => {
            assert.equal((await Call("GET", "/product/skus/public?requiredTags=season43_pass")).status, 418);
        });
    });

    it("leaves other tags and skus to the store", () => With1147(async () => {
        assert.equal((await Call("GET", "/product/skus/public?requiredTags=webstore")).status, 418);
        assert.equal((await Call("GET", "/product/sku/AR_SOMETHING")).status, 418);
        assert.equal((await Call("POST", "/notification/id_currency_platinum?token=nope")).status, 418);
    }));

    it("lists the free offer, sells it once, then reads as owned", () => With1147(async () => {
        const Listed = await Call("GET", "/product/skus/public?requiredTags=season43_pass");
        assert.equal(Listed.status, 200);
        assert.equal(Listed.json.length, 1);
        assert.equal(Listed.json[0].id, "season43_premium");
        assert.equal(Listed.json[0].remaining, 1);
        assert.deepEqual(Listed.json[0].prices, [{ currencyId: "id_currency_platinum", price: 0, salesPrice: 0 }]);

        const Token = await Call("GET", "/token/id_currency_platinum/season43_premium");
        assert.equal(Token.status, 200);
        assert.equal(typeof Token.json.purchaseToken, "string");

        const Path = `/notification/id_currency_platinum?token=${Token.json.purchaseToken}`;
        assert.equal((await Call("POST", Path)).status, 204);
        assert.equal((await Call("POST", Path)).status, 204); // a retried redeem
        assert.ok(ListEntitlements(Player).some((E) => E.name === "season43_premium"));

        assert.equal((await Call("GET", "/product/sku/season43_premium")).json.remaining, 0);
        assert.equal((await Call("GET", "/token/id_currency_platinum/season43_premium")).status, 409);
    }));
});
