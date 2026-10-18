// The panel's request handler: static interface, login, roles, CSRF and the JSON API. Plain node:http
// types, so the tests run it over HTTP and the server over HTTPS.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Lockouts, NAME_RE, ROLES, Sessions } from "./auth.mjs";
import { BackendError } from "./backend.mjs";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const COOKIE = "__Host-dr_panel";
const MAX_BODY = 16 * 1024;
const ACCOUNT_ID = /^UID-[0-9a-f-]{8,64}$/i;
const CURRENCIES = ["platinum", "rams", "aetherdust", "marks_steel", "marks_gilded", "prestige", "dark_harvest"];

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// What each role may do; a moderator sees everything but the logs and the team, and may ban and invite
const CAN = {
  view: ["admin", "moderator"],
  ban: ["admin", "moderator"],
  invite: ["admin", "moderator"],
  currency: ["admin"],
  rename: ["admin"],
  registration: ["admin"],
  logs: ["admin"],
  team: ["admin"],
};

class HttpError extends Error {
  constructor(Status, Code) {
    super(Code);
    this.status = Status;
    this.code = Code;
  }
}

function Send(res, Status, Body, Headers = {}) {
  const Data = Body === undefined ? "" : JSON.stringify(Body);
  res.writeHead(Status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...Headers });
  res.end(Data);
}

function Cookies(req) {
  return Object.fromEntries(String(req.headers.cookie ?? "").split(";").map((Part) => Part.trim().split("=")).filter((Pair) => Pair.length === 2));
}

function ReadBody(req) {
  return new Promise((Resolve, Reject) => {
    let Size = 0;
    const Chunks = [];
    req.on("data", (Chunk) => {
      Size += Chunk.length;
      if (Size > MAX_BODY) { Reject(new HttpError(413, "body_too_large")); req.destroy(); return; }
      Chunks.push(Chunk);
    });
    req.on("end", () => {
      if (Chunks.length === 0) return Resolve({});
      try {
        const Body = JSON.parse(Buffer.concat(Chunks).toString("utf8"));
        Resolve(Body !== null && typeof Body === "object" && !Array.isArray(Body) ? Body : {});
      } catch {
        Reject(new HttpError(400, "bad_json"));
      }
    });
    req.on("error", Reject);
  });
}

function AddressOf(req) {
  return req.socket?.remoteAddress ?? "?";
}

function ServeStatic(req, res) {
  const Url = new URL(req.url, "https://panel");
  const Name = Url.pathname === "/" ? "index.html" : Url.pathname.slice(1);
  if (!/^[a-z0-9_-]+\.(html|js|css|svg|png|ico)$/i.test(Name)) return false;
  const File = path.join(PUBLIC_DIR, Name);
  if (!fs.existsSync(File)) return false;
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": TYPES[path.extname(Name)] ?? "application/octet-stream", "Cache-Control": Name === "index.html" ? "no-store" : "max-age=300" });
  res.end(fs.readFileSync(File));
  return true;
}

export function CreatePanel({ config, store, backend, monitor, audit, now = () => Date.now() }) {
  const sessions = new Sessions(config, now);
  const lockouts = new Lockouts(now);

  function SessionOf(req) {
    return sessions.get(Cookies(req)[COOKIE]);
  }

  function Require(Session, Ability) {
    if (!Session) throw new HttpError(401, "not_logged_in");
    if (!CAN[Ability].includes(Session.role)) throw new HttpError(403, "forbidden");
  }

  function Account(Id) {
    if (!ACCOUNT_ID.test(String(Id ?? ""))) throw new HttpError(400, "bad_account");
    return String(Id);
  }

  async function Dashboard() {
    const [System, Online, Servers, Status] = await Promise.all([
      monitor.overview(),
      backend.online().catch(() => []),
      backend.gameservers(),
      backend.status().catch(() => null),
    ]);
    const Names = new Map((await backend.users().catch(() => [])).map((User) => [User.accountId, User.username]));
    return {
      system: System,
      players: Online,
      servers: Servers.map((Server) => ({ ...Server, expectedPlayers: (Server.expectedPlayers ?? []).map((Id) => ({ accountId: Id, username: Names.get(Id) ?? Id })) })),
      game: Status ? { name: Status.name, version: Status.version, registration: Status.registration, uptimeSeconds: Status.uptimeSeconds, playersOnline: Status.playersOnline, where: Status.players } : null,
    };
  }

  const Routes = {
    "GET /api/me": async (req, Session) => {
      if (!Session) throw new HttpError(401, "not_logged_in");
      return { name: Session.name, role: Session.role, csrf: Session.csrf, can: Object.keys(CAN).filter((Ability) => CAN[Ability].includes(Session.role)) };
    },

    "POST /api/login": async (req, _Session, Body, res) => {
      const Name = String(Body.name ?? "").slice(0, 64);
      const Address = AddressOf(req);
      if (lockouts.locked(Name, Address)) throw new HttpError(429, "locked");
      const User = store.verify(Name, Body.password);
      if (!User) {
        lockouts.fail(Name, Address);
        audit.write(Name || "?", "login_failed", { address: Address });
        throw new HttpError(401, "bad_login");
      }
      lockouts.clear(Name);
      const Session = sessions.create(User);
      audit.write(User.name, "login", { address: Address });
      res.setHeader("Set-Cookie", `${COOKIE}=${Session.id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${config.sessionHours * 3600}`);
      return { name: User.name, role: User.role, csrf: Session.csrf };
    },

    "POST /api/logout": async (req, Session, _Body, res) => {
      if (Session) sessions.destroy(Session.id);
      res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
      return { ok: true };
    },

    "GET /api/dashboard": async (req, Session) => { Require(Session, "view"); return Dashboard(); },

    "GET /api/players": async (req, Session) => {
      Require(Session, "view");
      const Query = new URL(req.url, "https://panel").searchParams.get("q")?.trim().toLowerCase() ?? "";
      const [Users, Online] = await Promise.all([backend.users(), backend.online().catch(() => [])]);
      const OnlineIds = new Map(Online.map((Player) => [Player.accountId, Player]));
      return Users
        .filter((User) => !Query || User.username.toLowerCase().includes(Query) || User.accountId.toLowerCase().includes(Query))
        .map((User) => ({ ...User, online: OnlineIds.has(User.accountId), huntId: OnlineIds.get(User.accountId)?.huntId ?? null }))
        .sort((A, B) => Number(B.online) - Number(A.online) || A.username.localeCompare(B.username));
    },

    "GET /api/player": async (req, Session) => {
      Require(Session, "view");
      const Id = Account(new URL(req.url, "https://panel").searchParams.get("id"));
      const [Wallet, Moderation, Online] = await Promise.all([backend.wallet(Id), backend.moderation(Id).catch(() => null), backend.online().catch(() => [])]);
      return { wallet: Wallet, moderation: Moderation, online: Online.find((Player) => Player.accountId === Id) ?? null };
    },

    "POST /api/player/currency": async (req, Session, Body) => {
      Require(Session, "currency");
      const Id = Account(Body.accountId);
      if (!CURRENCIES.includes(Body.currency)) throw new HttpError(400, "bad_currency");
      const Amount = Number(Body.amount);
      if (!Number.isSafeInteger(Amount) || Amount === 0 || Math.abs(Amount) > 1_000_000) throw new HttpError(400, "bad_amount");
      const Reason = String(Body.reason ?? "").trim().slice(0, 120);
      // One click, one grant: the interface sends its own id, so a double submit pays once
      const GrantId = /^[A-Za-z0-9_-]{12,64}$/.test(String(Body.requestId ?? "")) ? `panel-${Body.requestId}` : `panel-${crypto.randomUUID()}`;
      const Result = await backend.grant({ accountId: Id, currency: Body.currency, amount: Amount, grantId: GrantId, reason: Reason, actor: Session.name });
      audit.write(Session.name, Amount > 0 ? "currency_give" : "currency_take", { accountId: Id, currency: Body.currency, amount: Amount, balance: Result.balance, replayed: Result.replayed, reason: Reason });
      return Result;
    },

    "POST /api/player/ban": async (req, Session, Body) => {
      Require(Session, "ban");
      const Id = Account(Body.accountId);
      const Reason = String(Body.reason ?? "").trim().slice(0, 300);
      if (!Reason) throw new HttpError(400, "reason_required");
      const Active = Body.active === true;
      const Address = Active && typeof Body.address === "string" && Body.address.trim() ? Body.address.trim() : undefined;
      const Result = await backend.setBan({ accountId: Id, reason: Reason, active: Active, ...(Address ? { address: Address } : {}) });
      audit.write(Session.name, Active ? "ban" : "unban", { accountId: Id, reason: Reason, ...(Address ? { address: Address } : {}) });
      return Result;
    },

    "POST /api/player/rename": async (req, Session, Body) => {
      Require(Session, "rename");
      const Id = Account(Body.accountId);
      const Result = await backend.rename(Id, String(Body.username ?? "").trim());
      audit.write(Session.name, "rename", { accountId: Id, from: Result?.OldUsername, to: Result?.Username });
      return Result;
    },

    "GET /api/invites": async (req, Session) => {
      Require(Session, "invite");
      const [Codes, Mode] = await Promise.all([backend.invites(), backend.registration().catch(() => null)]);
      return { registration: Mode, codes: Codes };
    },

    "POST /api/invites": async (req, Session, Body) => {
      Require(Session, "invite");
      const Uses = Number(Body.uses ?? 1);
      if (!Number.isSafeInteger(Uses) || Uses < 1 || Uses > 100) throw new HttpError(400, "bad_uses");
      const Name = String(Body.name ?? "").trim().slice(0, 60);
      const Result = await backend.createInvite(Uses, Name || undefined);
      audit.write(Session.name, "invite_create", { uses: Uses, name: Name });
      return Result;
    },

    "POST /api/registration": async (req, Session, Body) => {
      Require(Session, "registration");
      if (!["OPEN", "INVITECODE", "NONE"].includes(Body.mode)) throw new HttpError(400, "bad_mode");
      await backend.setRegistration(Body.mode);
      audit.write(Session.name, "registration", { mode: Body.mode });
      return { registration: Body.mode };
    },

    "GET /api/logs": async (req, Session) => {
      Require(Session, "logs");
      const Params = new URL(req.url, "https://panel").searchParams;
      try {
        return { service: Params.get("service"), lines: await monitor.logs(String(Params.get("service")), Params.get("lines"), Params.get("q")) };
      } catch (error) {
        if (error.message === "unknown_service") throw new HttpError(400, "unknown_service");
        throw error;
      }
    },

    "GET /api/services": async (req, Session) => { Require(Session, "view"); return config.services; },

    "GET /api/audit": async (req, Session) => { Require(Session, "view"); return audit.read(300); },

    "GET /api/team": async (req, Session) => { Require(Session, "team"); return store.list(); },

    "POST /api/team": async (req, Session, Body) => {
      Require(Session, "team");
      try { store.add(String(Body.name ?? ""), String(Body.role ?? ""), Body.password); }
      catch (error) { throw new HttpError(400, error.message); }
      audit.write(Session.name, "team_add", { name: Body.name, role: Body.role });
      return store.list();
    },

    "POST /api/team/role": async (req, Session, Body) => {
      Require(Session, "team");
      if (!NAME_RE.test(String(Body.name ?? "")) || !ROLES.includes(Body.role)) throw new HttpError(400, "bad_request");
      try { store.setRole(Body.name, Body.role); } catch (error) { throw new HttpError(400, error.message); }
      sessions.endFor(Body.name);
      audit.write(Session.name, "team_role", { name: Body.name, role: Body.role });
      return store.list();
    },

    "POST /api/team/remove": async (req, Session, Body) => {
      Require(Session, "team");
      if (String(Body.name ?? "").toLowerCase() === Session.name.toLowerCase()) throw new HttpError(400, "tu ne peux pas supprimer ton propre compte");
      try { store.remove(String(Body.name ?? "")); } catch (error) { throw new HttpError(400, error.message); }
      sessions.endFor(Body.name);
      audit.write(Session.name, "team_remove", { name: Body.name });
      return store.list();
    },

    "POST /api/password": async (req, Session, Body) => {
      Require(Session, "view");
      if (!store.verify(Session.name, Body.current)) throw new HttpError(401, "bad_password");
      try { store.setPassword(Session.name, Body.password); } catch (error) { throw new HttpError(400, error.message); }
      audit.write(Session.name, "password_change");
      return { ok: true };
    },
  };

  return async function Handle(req, res) {
    try {
      const Url = new URL(req.url, "https://panel");
      if (!Url.pathname.startsWith("/api/")) {
        if ((req.method === "GET" || req.method === "HEAD") && ServeStatic(req, res)) return;
        res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
        res.end("introuvable");
        return;
      }
      const Route = Routes[`${req.method} ${Url.pathname}`];
      if (!Route) throw new HttpError(404, "not_found");
      const Session = SessionOf(req);
      let Body = {};
      if (req.method === "POST") {
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "json_required");
        // Every change but the login carries the session's CSRF token
        if (Url.pathname !== "/api/login") {
          if (!Session) throw new HttpError(401, "not_logged_in");
          const Token = String(req.headers["x-csrf-token"] ?? "");
          if (Token.length !== Session.csrf.length || !crypto.timingSafeEqual(Buffer.from(Token), Buffer.from(Session.csrf))) throw new HttpError(403, "bad_csrf");
        }
        Body = await ReadBody(req);
      }
      Send(res, 200, await Route(req, Session, Body, res));
    } catch (error) {
      if (error instanceof HttpError || error instanceof BackendError) {
        Send(res, error.status, { error: error.code });
        return;
      }
      console.error(`panel: ${req.method} ${req.url}: ${error?.stack ?? error}`);
      Send(res, 500, { error: "internal_error" });
    }
  };
}
