import { RemoveTestDb } from "./setup";
import "./authenv";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { type Server } from "node:http";
import { AddressInfo } from "node:net";
import { GetDb } from "../src/db";
import { inventory, inventorylog, userapikeys, users } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { HashUserAPIKey } from "../src/controllers/auth";
import { app } from "../src/app";
import { MakePlayer, StackQuantity } from "./helpers";

// The admin panel's wallet routes: GET /undaunted/api/PlayerWallet/:accountId and POST /GrantCurrency
let Listening: Server | undefined;
let Base = "";
const ADMIN = "UUK_" + "c".repeat(48);
const PLAYER = "UUK_" + "d".repeat(48);

before(async () => {
    GetDb().insert(users).values([{ userId: "UID-wallet-admin", name: "WalletAdmin", notes: 0, isAdmin: true }, { userId: "UID-wallet-player", name: "WalletPlayer", notes: 0 }]).run();
    GetDb().insert(userapikeys).values([{ userId: "UID-wallet-admin", keyHash: HashUserAPIKey(ADMIN) }, { userId: "UID-wallet-player", keyHash: HashUserAPIKey(PLAYER) }]).run();
    Listening = app.listen(0, "127.0.0.1");
    await new Promise<void>((Resolve) => Listening!.once("listening", Resolve));
    Base = `http://127.0.0.1:${(Listening.address() as AddressInfo).port}`;
});

after(async () => {
    Listening?.closeAllConnections();
    await new Promise<void>((Resolve) => Listening ? Listening.close(() => Resolve()) : Resolve());
    RemoveTestDb(() => GetDb().$client.close());
});

async function Call(Path: string, Key: string, Body?: unknown, Headers: Record<string, string> = {}){
    const R = await fetch(Base + Path, { method: Body === undefined ? "GET" : "POST", headers: { "x-undaunted-user-api-key": Key, "content-type": "application/json", ...Headers }, body: Body === undefined ? undefined : JSON.stringify(Body) });
    const Text = await R.text();
    return { status: R.status, json: Text ? JSON.parse(Text) : undefined };
}

function Credit(CharacterId: string, Stacks: Record<string, number>){
    const Value = JSON.stringify(Object.entries(Stacks).map(([catalogId, quantity]) => ({ catalogId, quantity })));
    GetDb().insert(inventory).values({ characterId: CharacterId, instancedItems: "[]", stackedItems: Value })
        .onConflictDoUpdate({ target: inventory.characterId, set: { stackedItems: Value } }).run();
}

describe("admin wallet", () => {
    it("reads a player's currencies", async () => {
        const A = await MakePlayer();
        Credit(A.CharacterId, { CURRENCY_PLATINUM_UNIV: 120, CURRENCY_NOTES: 40 });
        const R = await Call(`/undaunted/api/PlayerWallet/${A.UserId}`, ADMIN);
        assert.equal(R.status, 200);
        assert.equal(R.json.characters.length, 1);
        assert.equal(R.json.characters[0].balances.platinum, 120);
        assert.equal(R.json.characters[0].balances.rams, 40);
        assert.equal(R.json.characters[0].balances.aetherdust, 0);
        assert.equal((await Call("/undaunted/api/PlayerWallet/UID-nobody", ADMIN)).status, 404);
    });

    it("gives and takes back, never below 0, once per grant id", async () => {
        const A = await MakePlayer();
        const Give = { accountId: A.UserId, currency: "platinum", amount: 500, grantId: "panel-test-give-0001", reason: "cadeau" };
        const R = await Call("/undaunted/api/GrantCurrency", ADMIN, Give);
        assert.equal(R.status, 200);
        assert.deepEqual([R.json.balance, R.json.replayed], [500, false]);
        assert.equal(StackQuantity(A.CharacterId, "CURRENCY_PLATINUM_UNIV"), 500);

        const Again = await Call("/undaunted/api/GrantCurrency", ADMIN, Give);
        assert.deepEqual([Again.status, Again.json.replayed], [200, true]);
        assert.equal(StackQuantity(A.CharacterId, "CURRENCY_PLATINUM_UNIV"), 500, "the same grant id pays once");

        assert.equal((await Call("/undaunted/api/GrantCurrency", ADMIN, { ...Give, amount: 50 })).status, 409, "a reused grant id with another amount");

        const Take = await Call("/undaunted/api/GrantCurrency", ADMIN, { accountId: A.UserId, currency: "platinum", amount: -200, grantId: "panel-test-take-0001" });
        assert.deepEqual([Take.status, Take.json.balance], [200, 300]);

        const TooMuch = await Call("/undaunted/api/GrantCurrency", ADMIN, { accountId: A.UserId, currency: "platinum", amount: -301, grantId: "panel-test-take-0002" });
        assert.deepEqual([TooMuch.status, TooMuch.json.error], [409, "insufficient_balance"]);
        assert.equal(StackQuantity(A.CharacterId, "CURRENCY_PLATINUM_UNIV"), 300, "a refused removal changes nothing");

        const Logged = GetDb().select().from(inventorylog).where(eq(inventorylog.characterId, A.CharacterId)).all();
        assert.ok(Logged.some((Row) => Row.caller === "admin" && Row.quantityChange === 500 && String(Row.source).includes("cadeau")));
    });

    it("refuses bad input, a player key and a proxied request", async () => {
        const A = await MakePlayer();
        const Body = { accountId: A.UserId, currency: "platinum", amount: 10, grantId: "panel-test-refuse-01" };
        for(const Bad of [{ ...Body, currency: "gold" }, { ...Body, amount: 0 }, { ...Body, amount: 1.5 }, { ...Body, amount: 2_000_000 }, { ...Body, grantId: "short" }]){
            assert.equal((await Call("/undaunted/api/GrantCurrency", ADMIN, Bad)).status, 400, JSON.stringify(Bad));
        }
        assert.equal((await Call("/undaunted/api/GrantCurrency", PLAYER, Body)).status, 403);
        assert.equal((await Call("/undaunted/api/GrantCurrency", ADMIN, Body, { "x-forwarded-for": "203.0.113.9" })).status, 403, "admin keys are loopback only");
        assert.equal(StackQuantity(A.CharacterId, "CURRENCY_PLATINUM_UNIV"), 0);
    });
});
