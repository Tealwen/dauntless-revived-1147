import { RemoveTestDb } from "./setup";
import "./authenv";
import { WithEnv } from "./appenv";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import { type Server } from "node:http";
import { AddressInfo } from "node:net";
import { GetDb } from "../src/db";
import { gameserverapikeys } from "../src/db/schema";
import { SignMetagameJWTForUid } from "../src/controllers/auth";
import { TrialIdForWeek, TrialWeekAt } from "../src/controllers/trials";
import { hunts1147EarlyRouter, hunts1147Router } from "../src/routes/hunts1147";
import { trialsRouter } from "../src/routes/trials";
import { escalationRouter } from "../src/routes/escalation";
import { MakePlayer } from "./helpers";

// routes/hunts1147.ts, mounted the way app.ts mounts it (early router before trialsRouter, late
// router after escalationRouter), on a private app so this file does not depend on app.ts wiring.
const GS_KEY = crypto.randomBytes(24).toString("hex");
let Listening: Server | undefined;
let Base = "";
let Player = "";

before(async () => {
    GetDb().insert(gameserverapikeys).values({ keyHash: crypto.createHash("sha256").update(GS_KEY, "utf8").digest("hex") }).run();
    const App = express();
    App.use(express.json());
    App.use("/", hunts1147EarlyRouter);
    App.use("/", escalationRouter);
    App.use("/", trialsRouter);
    App.use("/", hunts1147Router);
    App.use((_req, res) => { res.status(404).send(); });
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

async function Post(Path: string, Body: unknown, Gs = false){
    const Headers: Record<string, string> = { "content-type": "application/json" };
    if(Gs) Headers["x-undaunted-gameserver-apikey"] = GS_KEY;
    else Headers["authorization"] = `bearer ${SignMetagameJWTForUid(Player)}`;
    const R = await fetch(Base + Path, { method: "POST", headers: Headers, body: JSON.stringify(Body) });
    const Text = await R.text();
    return { status: R.status, json: Text ? JSON.parse(Text) : undefined };
}

const With1147 = <T>(Body: () => Promise<T>) => WithEnv({ TARGET_GAME_VERSION: "1.14.7" }, Body);

describe("1.14.7 Trials leaderboards", () => {
    it("answers a query for this week's row exactly like the 1.4.4 controller", async () => {
        const Body = { difficulty: 1, page: 0, page_size: 10, trial_id: TrialIdForWeek(1, TrialWeekAt()), target_platforms: [] };
        const Old = await Post("/trials/leaderboards/all", Body);
        const New = await With1147(() => Post("/trials/leaderboards/all", Body));
        assert.equal(Old.status, 200);
        assert.deepEqual(New, Old);
    });

    it("sends an empty board for this week instead of 400 for an expired trial_id", async () => {
        const Body = { difficulty: 1, page: 0, page_size: 10, trial_id: "Arena_MatchmakerHunt_Elite_999", target_platforms: [] };
        assert.equal((await Post("/trials/leaderboards/all", Body)).status, 400);

        const All = await With1147(() => Post("/trials/leaderboards/all", Body));
        assert.equal(All.status, 200);
        assert.equal(All.json.payload.trial_id, TrialIdForWeek(1, TrialWeekAt()));
        assert.deepEqual(All.json.payload.world.solo.all.entries, []);
        assert.deepEqual(All.json.payload.world.group.entries, []);

        const Solo = await With1147(() => Post("/trials/leaderboards/solo", { ...Body, trial_id: "" }));
        assert.equal(Solo.status, 200);
        assert.deepEqual(Solo.json.payload.entries, []);
        assert.equal(typeof Solo.json.payload.time_to_refresh, "number");

        const Mine = await With1147(() => Post("/trials/leaderboards/solo/individual", { ...Body, phx_account_id: Player }));
        assert.deepEqual(Mine.json, { code: null, message: "OK", payload: {} });
    });

    it("leaves game-server submissions to the 1.4.4 route", async () => {
        const Reply = await With1147(() => Post("/trials/leaderboards/all", { completion_time: 1, trial_id: "x" }));
        assert.equal(Reply.status, 403); // a player token may not submit
    });
});

describe("1.14.7 Escalation save in stub mode", () => {
    it("returns the stub record instead of 404", async () => {
        const Path = `/escalation/ESC_SEASON_1/${Player}`;
        assert.equal((await Post(Path, {}, true)).status, 404);
        const Reply = await With1147(() => Post(Path, { escalation_level: 3 }, true));
        assert.equal(Reply.status, 200);
        assert.equal(Reply.json.payload.escalation_level, 99999);
    });
});
