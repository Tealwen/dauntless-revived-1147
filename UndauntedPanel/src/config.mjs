// Panel settings, from the environment (/etc/dauntless-revived/panel.env on a Linux server).
import path from "node:path";

function Int(Env, Name, Default, Min, Max) {
  const Raw = Env[Name];
  if (Raw === undefined || Raw === "") return Default;
  const Value = Number(Raw);
  if (!Number.isInteger(Value) || Value < Min || Value > Max) throw new Error(`${Name} must be a whole number from ${Min} to ${Max}`);
  return Value;
}

function Loopback(Env, Name, Default) {
  const Raw = Env[Name] ?? Default;
  const Url = new URL(Raw);
  if (Url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(Url.hostname)) throw new Error(`${Name} must be an http:// loopback URL`);
  return Url.origin;
}

export function LoadConfig(Env = process.env) {
  const DataDir = path.resolve(Env.PANEL_DATA_DIR ?? "/var/lib/dauntless-revived/panel");
  return {
    bind: Env.PANEL_BIND ?? "0.0.0.0",
    port: Int(Env, "PANEL_PORT", 8450, 1, 65535),
    certFile: path.resolve(Env.PANEL_CERT ?? path.join(DataDir, "..", "tls", "panel-cert.pem")),
    keyFile: path.resolve(Env.PANEL_KEY ?? path.join(DataDir, "..", "tls", "panel-key.pem")),
    dataDir: DataDir,
    adminKeyFile: path.resolve(Env.PANEL_ADMIN_KEY_FILE ?? path.join(DataDir, "admin.key")),
    metagame: Loopback(Env, "PANEL_METAGAME_URL", "http://127.0.0.1:61000"),
    deploy: Loopback(Env, "PANEL_DEPLOY_URL", "http://127.0.0.1:61001"),
    // The units the dashboard shows and whose logs an admin can read; the panel never starts or stops them
    services: (Env.PANEL_SERVICES ?? "dauntless-metagame,dauntless-deploy,dauntless-gateway,dauntless-content,dauntless-allowlist,dauntless-invite")
      .split(",").map((Unit) => Unit.trim()).filter((Unit) => /^[a-z0-9@._-]+$/.test(Unit)),
    sessionHours: Int(Env, "PANEL_SESSION_HOURS", 12, 1, 72),
    idleMinutes: Int(Env, "PANEL_IDLE_MINUTES", 120, 5, 1440),
  };
}
