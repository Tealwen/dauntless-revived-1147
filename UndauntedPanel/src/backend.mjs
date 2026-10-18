// The game services, on loopback only: the metagame's admin API (with the panel's own admin account key)
// and the deploy server's game server list. The panel holds no database access of its own.
import fs from "node:fs";

export class BackendError extends Error {
  constructor(Status, Code) {
    super(Code);
    this.status = Status;
    this.code = Code;
  }
}

export class Backend {
  constructor({ metagame, deploy, adminKeyFile }, Fetch = globalThis.fetch) {
    this.metagame = metagame;
    this.deploy = deploy;
    this.keyFile = adminKeyFile;
    this.fetch = Fetch;
    this.usersCache = undefined;
  }

  key() {
    const Key = fs.readFileSync(this.keyFile, "utf8").trim();
    if (!/^UUK_[A-Za-z0-9_-]{16,}$/.test(Key)) throw new BackendError(500, "panel_admin_key_invalid");
    return Key;
  }

  async call(Method, Path, Body) {
    let Reply;
    try {
      Reply = await this.fetch(this.metagame + Path, {
        method: Method,
        headers: { "x-undaunted-user-api-key": this.key(), ...(Body === undefined ? {} : { "content-type": "application/json" }) },
        body: Body === undefined ? undefined : JSON.stringify(Body),
        signal: AbortSignal.timeout(8000),
      });
    } catch (error) {
      if (error instanceof BackendError) throw error;
      throw new BackendError(502, "metagame_unreachable");
    }
    const Text = await Reply.text();
    let Json;
    try { Json = Text ? JSON.parse(Text) : undefined; } catch { Json = undefined; }
    if (!Reply.ok) throw new BackendError(Reply.status, (Json && (Json.error ?? Json.code)) || `metagame_${Reply.status}`);
    return Json;
  }

  async users() {
    if (this.usersCache && Date.now() - this.usersCache.at < 30000) return this.usersCache.users;
    const Users = ((await this.call("GET", "/undaunted/api/GetAllUsers"))?.Users ?? []).map((User) => ({ accountId: User.UserId, username: User.Username }));
    this.usersCache = { at: Date.now(), users: Users };
    return Users;
  }

  forgetUsers() {
    this.usersCache = undefined;
  }

  async online() {
    const Rows = (await this.call("GET", "/undaunted/api/PrivateOnlineStats")) ?? [];
    const Names = new Map((await this.users()).map((User) => [User.accountId, User.username]));
    return (Array.isArray(Rows) ? Rows : []).map((Row) => ({
      accountId: Row.UserId,
      username: Names.get(Row.UserId) ?? Row.UserId,
      map: typeof Row.Map === "string" ? Row.Map : null,
      huntId: typeof Row.HuntId === "string" ? Row.HuntId : null,
      enteredHuntAt: Row.EnteredHuntAt ?? null,
    }));
  }

  status() {
    return this.call("GET", "/undaunted/api/ServerStatus");
  }

  wallet(AccountId) {
    return this.call("GET", `/undaunted/api/PlayerWallet/${encodeURIComponent(AccountId)}`);
  }

  grant(Body) {
    return this.call("POST", "/undaunted/api/GrantCurrency", Body);
  }

  moderation(AccountId) {
    return this.call("GET", `/undaunted/api/Moderation/${encodeURIComponent(AccountId)}`);
  }

  setBan(Body) {
    return this.call("POST", "/undaunted/api/Moderation", Body);
  }

  async rename(AccountId, NewUsername) {
    const Result = await this.call("POST", "/undaunted/api/RenameUser", { UserId: AccountId, NewUsername });
    this.forgetUsers();
    return Result;
  }

  async invites() {
    return (await this.call("GET", "/undaunted/api/InviteCodes"))?.InviteCodes ?? [];
  }

  createInvite(Uses, Name) {
    return this.call("POST", "/undaunted/api/CreateInvite", { uses: Uses, ...(Name ? { name: Name } : {}) });
  }

  async registration() {
    return (await this.call("GET", "/undaunted/api/RegistrationStatus"))?.RegistrationMode ?? null;
  }

  setRegistration(Mode) {
    return this.call("POST", "/undaunted/api/RegistrationStatus", { RegistrationStatus: Mode });
  }

  // Running game servers (Ramsgate, Dojo, hunts) from the deploy server; [] when it does not answer
  async gameservers() {
    try {
      const Reply = await this.fetch(this.deploy + "/gameservers", { signal: AbortSignal.timeout(5000) });
      if (!Reply.ok) return [];
      const Json = await Reply.json();
      return Array.isArray(Json?.servers) ? Json.servers : [];
    } catch {
      return [];
    }
  }
}
