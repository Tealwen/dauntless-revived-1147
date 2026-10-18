// Panel accounts (users.json, scrypt hashes, never in the game database), sessions and login lockouts.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ROLES = ["admin", "moderator"];
export const NAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
export const MIN_PASSWORD = 10;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILS_NAME = 5;
const MAX_FAILS_ADDRESS = 10;

function HashPassword(Password, Salt = crypto.randomBytes(16).toString("hex")) {
  const Hash = crypto.scryptSync(Password, Salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString("hex");
  return { salt: Salt, hash: Hash };
}

function SameHash(A, B) {
  const X = Buffer.from(A, "hex");
  const Y = Buffer.from(B, "hex");
  return X.length === Y.length && crypto.timingSafeEqual(X, Y);
}

export function CheckPassword(Password) {
  if (typeof Password !== "string" || Password.length < MIN_PASSWORD || Password.length > 200) return `le mot de passe doit faire de ${MIN_PASSWORD} à 200 caractères`;
  return null;
}

export class UserStore {
  constructor(File) {
    this.file = File;
  }

  read() {
    try {
      const Data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(Data.users) ? Data.users : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  write(Users) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const Temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(Temporary, JSON.stringify({ users: Users }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(Temporary, this.file);
    fs.chmodSync(this.file, 0o600);
  }

  list() {
    return this.read().map(({ name, role, createdAt }) => ({ name, role, createdAt }));
  }

  find(Name) {
    const Lower = String(Name ?? "").toLowerCase();
    return this.read().find((User) => User.name.toLowerCase() === Lower);
  }

  add(Name, Role, Password) {
    if (!NAME_RE.test(Name ?? "")) throw new Error("nom invalide : 3 à 32 lettres, chiffres, _ . -");
    if (!ROLES.includes(Role)) throw new Error("rôle invalide");
    const Problem = CheckPassword(Password);
    if (Problem) throw new Error(Problem);
    const Users = this.read();
    if (Users.some((User) => User.name.toLowerCase() === Name.toLowerCase())) throw new Error("ce nom existe déjà");
    Users.push({ name: Name, role: Role, ...HashPassword(Password), createdAt: new Date().toISOString() });
    this.write(Users);
  }

  setPassword(Name, Password) {
    const Problem = CheckPassword(Password);
    if (Problem) throw new Error(Problem);
    const Users = this.read();
    const User = Users.find((Entry) => Entry.name.toLowerCase() === String(Name).toLowerCase());
    if (!User) throw new Error("compte inconnu");
    Object.assign(User, HashPassword(Password));
    this.write(Users);
  }

  setRole(Name, Role) {
    if (!ROLES.includes(Role)) throw new Error("rôle invalide");
    const Users = this.read();
    const User = Users.find((Entry) => Entry.name.toLowerCase() === String(Name).toLowerCase());
    if (!User) throw new Error("compte inconnu");
    if (User.role === "admin" && Role !== "admin" && Users.filter((Entry) => Entry.role === "admin").length === 1) throw new Error("il doit rester au moins un admin");
    User.role = Role;
    this.write(Users);
  }

  remove(Name) {
    const Users = this.read();
    const User = Users.find((Entry) => Entry.name.toLowerCase() === String(Name).toLowerCase());
    if (!User) throw new Error("compte inconnu");
    if (User.role === "admin" && Users.filter((Entry) => Entry.role === "admin").length === 1) throw new Error("il doit rester au moins un admin");
    this.write(Users.filter((Entry) => Entry !== User));
  }

  // The account when the password matches; a dummy hash keeps unknown names as slow as known ones
  verify(Name, Password) {
    const User = this.find(Name);
    const Salt = User?.salt ?? "0".repeat(32);
    const { hash } = HashPassword(String(Password ?? ""), Salt);
    if (!User || !SameHash(hash, User.hash)) return null;
    return { name: User.name, role: User.role };
  }
}

// Failed logins per name and per address, each locked for 15 min past its limit
export class Lockouts {
  constructor(Now = () => Date.now()) {
    this.now = Now;
    this.fails = new Map();
  }

  key(Kind, Value) {
    return `${Kind}:${String(Value).toLowerCase()}`;
  }

  count(Key) {
    const Now = this.now();
    const Times = (this.fails.get(Key) ?? []).filter((At) => Now - At < LOCK_MS);
    if (Times.length) this.fails.set(Key, Times); else this.fails.delete(Key);
    return Times;
  }

  locked(Name, Address) {
    return this.count(this.key("name", Name)).length >= MAX_FAILS_NAME || this.count(this.key("ip", Address)).length >= MAX_FAILS_ADDRESS;
  }

  fail(Name, Address) {
    for (const Key of [this.key("name", Name), this.key("ip", Address)]) this.fails.set(Key, [...this.count(Key), this.now()]);
    if (this.fails.size > 10000) this.fails.clear();
  }

  clear(Name) {
    this.fails.delete(this.key("name", Name));
  }
}

export class Sessions {
  constructor({ sessionHours, idleMinutes }, Now = () => Date.now()) {
    this.maxMs = sessionHours * 3600 * 1000;
    this.idleMs = idleMinutes * 60 * 1000;
    this.now = Now;
    this.byId = new Map();
  }

  create(User) {
    const Id = crypto.randomBytes(32).toString("base64url");
    const Now = this.now();
    this.byId.set(Id, { id: Id, name: User.name, role: User.role, csrf: crypto.randomBytes(24).toString("base64url"), createdAt: Now, seenAt: Now });
    return this.byId.get(Id);
  }

  get(Id) {
    const Session = typeof Id === "string" ? this.byId.get(Id) : undefined;
    if (!Session) return undefined;
    const Now = this.now();
    if (Now - Session.createdAt > this.maxMs || Now - Session.seenAt > this.idleMs) {
      this.byId.delete(Id);
      return undefined;
    }
    Session.seenAt = Now;
    return Session;
  }

  destroy(Id) {
    this.byId.delete(Id);
  }

  // A renamed role or a removed account ends that account's sessions at once
  endFor(Name) {
    for (const [Id, Session] of this.byId) if (Session.name.toLowerCase() === String(Name).toLowerCase()) this.byId.delete(Id);
  }
}
