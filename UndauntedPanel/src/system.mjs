// Machine and service figures for the dashboard, the services' logs, and the panel's own action history.
// Read only: systemctl show and journalctl run with fixed arguments (no shell), and only for the
// configured units.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function Run(Command, Args, Limit = 4 * 1024 * 1024) {
  return new Promise((Resolve) => {
    execFile(Command, Args, { timeout: 8000, maxBuffer: Limit, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } }, (error, stdout) => {
      Resolve(error ? "" : String(stdout));
    });
  });
}

function CpuTimes() {
  try {
    const Line = fs.readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
    const Idle = Line[3] + (Line[4] ?? 0);
    return { idle: Idle, total: Line.reduce((A, B) => A + B, 0) };
  } catch {
    return undefined;
  }
}

export class SystemMonitor {
  constructor(Services) {
    this.services = Services;
    this.history = [];
    this.last = CpuTimes();
    this.cpu = 0;
  }

  // Every 10 s: CPU since the last sample and memory, 90 samples (15 min)
  sample() {
    const Now = CpuTimes();
    if (Now && this.last && Now.total > this.last.total) {
      this.cpu = Math.round(1000 * (1 - (Now.idle - this.last.idle) / (Now.total - this.last.total))) / 10;
    }
    this.last = Now;
    const Memory = this.memory();
    this.history.push({ at: Date.now(), cpu: this.cpu, mem: Memory.usedPercent });
    if (this.history.length > 90) this.history.shift();
  }

  memory() {
    let Total = os.totalmem();
    let Available = os.freemem();
    try {
      const Info = fs.readFileSync("/proc/meminfo", "utf8");
      const Get = (Name) => Number((new RegExp(`^${Name}:\\s+(\\d+)`, "m").exec(Info) ?? [])[1]) * 1024;
      Total = Get("MemTotal") || Total;
      Available = Get("MemAvailable") || Available;
    } catch {}
    return { total: Total, used: Total - Available, usedPercent: Math.round(1000 * (Total - Available) / Total) / 10 };
  }

  async disk() {
    try {
      const Stats = await fs.promises.statfs("/");
      const Total = Stats.blocks * Stats.bsize;
      const Free = Stats.bavail * Stats.bsize;
      return { total: Total, used: Total - Free, usedPercent: Math.round(1000 * (Total - Free) / Total) / 10 };
    } catch {
      return null;
    }
  }

  async serviceStates() {
    const Out = await Run("systemctl", ["show", "--no-pager", "-p", "Id,ActiveState,SubState,MemoryCurrent,ActiveEnterTimestamp,NRestarts", ...this.services]);
    return Out.split("\n\n").filter((Block) => Block.trim()).map((Block) => {
      const Fields = Object.fromEntries(Block.split("\n").filter(Boolean).map((Line) => [Line.slice(0, Line.indexOf("=")), Line.slice(Line.indexOf("=") + 1)]));
      const Memory = Number(Fields.MemoryCurrent);
      const Since = Date.parse(Fields.ActiveEnterTimestamp ?? "");
      return {
        unit: Fields.Id?.replace(/\.service$/, "") ?? "?",
        active: Fields.ActiveState ?? "unknown",
        sub: Fields.SubState ?? "",
        memory: Number.isFinite(Memory) && Memory < 2 ** 62 ? Memory : null,
        since: Number.isFinite(Since) ? new Date(Since).toISOString() : null,
        restarts: Number(Fields.NRestarts) || 0,
      };
    });
  }

  async overview() {
    return {
      hostname: os.hostname(),
      uptimeSeconds: Math.round(os.uptime()),
      load: os.loadavg().map((Value) => Math.round(Value * 100) / 100),
      cores: os.cpus().length,
      cpu: this.cpu,
      memory: this.memory(),
      disk: await this.disk(),
      services: await this.serviceStates(),
      history: this.history,
    };
  }

  // The last lines of one configured unit, keys and tokens masked; a filter keeps matching lines only
  async logs(Unit, Lines, Filter) {
    if (!this.services.includes(Unit)) throw new Error("unknown_service");
    const Count = Math.min(Math.max(Number.parseInt(Lines, 10) || 200, 1), 1000);
    const Out = await Run("journalctl", ["-u", `${Unit}.service`, "-n", String(Filter ? 5000 : Count), "--no-pager", "-o", "short-iso"], 16 * 1024 * 1024);
    let Rows = Out.split("\n").filter(Boolean).map(RedactLine);
    if (Filter) {
      const Needle = String(Filter).toLowerCase().slice(0, 100);
      Rows = Rows.filter((Line) => Line.toLowerCase().includes(Needle)).slice(-Count);
    }
    return Rows;
  }
}

export function RedactLine(Line) {
  return Line
    .replace(/\bUUK_[A-Za-z0-9_-]{8,}/g, "UUK_***")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, "$1***")
    .replace(/\b(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "eyJ***")
    .replace(/((?:KEY|SECRET|TOKEN|PASSWORD|PRIVKEY)[A-Z0-9_]*["']?\s*[=:]\s*["']?)[^\s"',}]+/gi, "$1***");
}

// One JSON line per panel action: who, what, when
export class AuditLog {
  constructor(File) {
    this.file = File;
  }

  write(Actor, Action, Details = {}) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), actor: Actor, action: Action, ...Details }) + "\n", { mode: 0o600 });
  }

  read(Limit = 300) {
    try {
      return fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).slice(-Limit).map((Line) => {
        try { return JSON.parse(Line); } catch { return null; }
      }).filter(Boolean).reverse();
    } catch {
      return [];
    }
  }
}
