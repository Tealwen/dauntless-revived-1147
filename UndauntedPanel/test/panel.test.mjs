import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { CreatePanel } from "../src/app.mjs";
import { UserStore } from "../src/auth.mjs";
import { AuditLog, RedactLine } from "../src/system.mjs";

// The handler over plain HTTP with a fake backend and monitor; the cookie's Secure flag does not matter here
const Dir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-panel-"));
const store = new UserStore(path.join(Dir, "users.json"));
const audit = new AuditLog(path.join(Dir, "audit.log"));
const Calls = [];
const backend = {
  users: async () => [{ accountId: "UID-11111111-aaaa", username: "Pepito" }],
  online: async () => [{ accountId: "UID-11111111-aaaa", username: "Pepito", map: "/Game/Maps/ramsgate/ramsgate_01_persistent", huntId: null }],
  gameservers: async () => [{ port: 8777, kind: "city", map: "/Game/Maps/ramsgate/ramsgate_01_persistent", expectedPlayers: [] }],
  status: async () => ({ name: "Test", version: "1", registration: "INVITECODE", uptimeSeconds: 5, playersOnline: 1, players: [] }),
  wallet: async (Id) => ({ accountId: Id, username: "Pepito", currencies: [], characters: [] }),
  moderation: async () => ({ username: "Pepito", ban: null, addresses: [] }),
  grant: async (Body) => { Calls.push(["grant", Body]); return { balance: 600, replayed: false }; },
  setBan: async (Body) => { Calls.push(["ban", Body]); return { ok: true }; },
  rename: async () => ({}), invites: async () => [], registration: async () => "INVITECODE", createInvite: async () => ({ code: "ABC" }), setRegistration: async () => {},
};
const monitor = { overview: async () => ({ cpu: 1, memory: { usedPercent: 2 }, disk: null, services: [], history: [], load: [0, 0, 0] }), logs: async () => ["line"],
  restart: async (Unit) => { Calls.push(["restart", Unit]); return [{ unit: "dauntless-metagame", active: "active" }]; } };
const config = { sessionHours: 12, idleMinutes: 120, services: ["dauntless-metagame"] };
let Server;
let Base;

before(async () => {
  store.add("Owner", "admin", "correct horse battery");
  store.add("Modo", "moderator", "another long pass");
  Server = http.createServer(CreatePanel({ config, store, backend, monitor, audit }));
  await new Promise((Resolve) => Server.listen(0, "127.0.0.1", Resolve));
  Base = `http://127.0.0.1:${Server.address().port}`;
});
after(() => { Server.close(); fs.rmSync(Dir, { recursive: true, force: true }); });

async function Request(Method, Url, { body, cookie, csrf } = {}) {
  const Headers = {};
  if (body !== undefined) Headers["content-type"] = "application/json";
  if (cookie) Headers.cookie = cookie;
  if (csrf) Headers["x-csrf-token"] = csrf;
  const R = await fetch(Base + Url, { method: Method, headers: Headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const Text = await R.text();
  let Json; try { Json = JSON.parse(Text); } catch {}
  return { status: R.status, json: Json, text: Text, headers: R.headers };
}

async function Login(Name, Password) {
  const R = await Request("POST", "/api/login", { body: { name: Name, password: Password } });
  assert.equal(R.status, 200, JSON.stringify(R.json));
  return { cookie: R.headers.get("set-cookie").split(";")[0], csrf: R.json.csrf };
}

describe("panel", () => {
  it("stores accounts with scrypt in a 600 file", () => {
    const Raw = fs.readFileSync(path.join(Dir, "users.json"), "utf8");
    assert.ok(!Raw.includes("correct horse"));
    assert.equal(fs.statSync(path.join(Dir, "users.json")).mode & 0o777, 0o600);
    assert.throws(() => store.add("Short", "admin", "123"), /10/);
  });

  it("serves the interface with security headers and refuses other paths", async () => {
    const R = await Request("GET", "/");
    assert.equal(R.status, 200);
    assert.match(R.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(R.headers.get("x-frame-options"), "DENY");
    assert.equal((await Request("GET", "/../src/app.mjs")).status, 404);
    assert.equal((await Request("GET", "/%2e%2e/package.json")).status, 404);
    assert.equal((await Request("GET", "/api/dashboard")).status, 401);
  });

  it("logs in, refuses a bad password and locks a name after 5 failures", async () => {
    assert.equal((await Request("POST", "/api/login", { body: { name: "Owner", password: "nope" } })).status, 401);
    const S = await Login("Owner", "correct horse battery");
    assert.match(S.cookie, /^__Host-dr_panel=/);
    assert.equal((await Request("GET", "/api/me", { cookie: S.cookie })).json.role, "admin");
    for (let I = 0; I < 5; I++) await Request("POST", "/api/login", { body: { name: "Modo", password: "wrong wrong wrong" } });
    assert.equal((await Request("POST", "/api/login", { body: { name: "Modo", password: "another long pass" } })).status, 429);
  });

  it("requires the CSRF token on every change", async () => {
    const S = await Login("Owner", "correct horse battery");
    const Body = { accountId: "UID-11111111-aaaa", currency: "platinum", amount: 100, requestId: "abcdefghijkl1234" };
    assert.equal((await Request("POST", "/api/player/currency", { cookie: S.cookie, body: Body })).status, 403);
    assert.equal((await Request("POST", "/api/player/currency", { cookie: S.cookie, csrf: "x".repeat(S.csrf.length), body: Body })).status, 403);
    const R = await Request("POST", "/api/player/currency", { cookie: S.cookie, csrf: S.csrf, body: Body });
    assert.equal(R.status, 200);
    const [, Grant] = Calls.find(([Kind]) => Kind === "grant");
    assert.deepEqual([Grant.amount, Grant.actor, Grant.grantId], [100, "Owner", "panel-abcdefghijkl1234"]);
    assert.ok(audit.read().some((Row) => Row.action === "currency_give" && Row.actor === "Owner"));
  });

  it("gives a moderator bans and invites, not currencies, logs or the team", async () => {
    store.add("Modo2", "moderator", "yet another pass");
    const S = await Login("Modo2", "yet another pass");
    const Post = (Url, Body) => Request("POST", Url, { cookie: S.cookie, csrf: S.csrf, body: Body });
    assert.equal((await Post("/api/player/currency", { accountId: "UID-11111111-aaaa", currency: "platinum", amount: 1 })).status, 403);
    assert.equal((await Request("GET", "/api/logs?service=dauntless-metagame", { cookie: S.cookie })).status, 403);
    assert.equal((await Request("GET", "/api/team", { cookie: S.cookie })).status, 403);
    assert.equal((await Post("/api/player/ban", { accountId: "UID-11111111-aaaa", active: true, reason: "" })).status, 400);
    assert.equal((await Post("/api/player/ban", { accountId: "UID-11111111-aaaa", active: true, reason: "triche" })).status, 200);
    assert.equal((await Post("/api/invites", { uses: 2 })).status, 200);
    assert.equal((await Request("GET", "/api/dashboard", { cookie: S.cookie })).status, 200);
  });

  it("checks account ids and amounts before calling the game", async () => {
    const S = await Login("Owner", "correct horse battery");
    const Post = (Body) => Request("POST", "/api/player/currency", { cookie: S.cookie, csrf: S.csrf, body: Body });
    assert.equal((await Post({ accountId: "../../x", currency: "platinum", amount: 1 })).status, 400);
    assert.equal((await Post({ accountId: "UID-11111111-aaaa", currency: "gold", amount: 1 })).status, 400);
    assert.equal((await Post({ accountId: "UID-11111111-aaaa", currency: "platinum", amount: 5_000_000 })).status, 400);
  });

  it("lets an admin restart one service or all, and nobody else", async () => {
    const Admin = await Login("Owner", "correct horse battery");
    const Post = (S, Body) => Request("POST", "/api/services/restart", { cookie: S.cookie, csrf: S.csrf, body: Body });
    assert.equal((await Post(Admin, { service: "dauntless-metagame" })).status, 200);
    assert.equal((await Post(Admin, { service: "all" })).status, 200);
    assert.equal((await Post(Admin, { service: "ssh" })).status, 400, "only the configured units");
    assert.deepEqual(Calls.filter(([Kind]) => Kind === "restart").map(([, Unit]) => Unit), ["dauntless-metagame", "all"]);
    store.add("Modo3", "moderator", "moderator pass 3");
    const Modo = await Login("Modo3", "moderator pass 3");
    assert.equal((await Post(Modo, { service: "dauntless-metagame" })).status, 403);
    assert.ok(audit.read().some((Row) => Row.action === "restart" && Row.service === "all"));
  });

  it("masks keys and tokens in log lines", () => {
    const Line = RedactLine('key UUK_abcdefghijklmnop Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig GATEWAY_SECRET=topsecret {"apiKey":"zzz"}');
    assert.ok(!/abcdefghijklmnop|topsecret|eyJzdWIi|zzz/.test(Line), Line);
  });
});

describe("SystemMonitor.restart", () => {
  it("restarts one unit without its dependents, or all units in one call, and refuses others", async () => {
    const { SystemMonitor } = await import("../src/system.mjs");
    const Monitor = new SystemMonitor(["dauntless-metagame", "dauntless-deploy"]);
    Monitor.serviceStates = async () => [{ unit: "dauntless-metagame", active: "active" }, { unit: "dauntless-deploy", active: "active" }];
    const Runs = [];
    const Runner = async (Command, Args) => { Runs.push([Command, ...Args].join(" ")); };
    await Monitor.restart("dauntless-metagame", Runner);
    await Monitor.restart("all", Runner);
    await assert.rejects(Monitor.restart("ssh", Runner), /unknown_service/);
    assert.deepEqual(Runs, ["systemctl restart --job-mode=ignore-dependencies dauntless-metagame.service", "systemctl restart dauntless-metagame.service dauntless-deploy.service"]);
  });
});
