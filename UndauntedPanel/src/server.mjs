#!/usr/bin/env node
// Panel Slayer: the owner's admin panel for a Dauntless Revived 1.14.7 server, over HTTPS only.
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { CreatePanel } from "./app.mjs";
import { UserStore } from "./auth.mjs";
import { Backend } from "./backend.mjs";
import { LoadConfig } from "./config.mjs";
import { AuditLog, SystemMonitor } from "./system.mjs";

const config = LoadConfig();
const store = new UserStore(path.join(config.dataDir, "users.json"));
if (store.list().length === 0) {
  console.error("panel: no panel account yet; create one with: node UndauntedPanel/bin/panel-user.mjs add <name> admin");
}
const monitor = new SystemMonitor(config.services);
monitor.sample();
setInterval(() => monitor.sample(), 10_000).unref();

const handler = CreatePanel({ config, store, backend: new Backend(config), monitor, audit: new AuditLog(path.join(config.dataDir, "audit.log")) });
const server = https.createServer({ cert: fs.readFileSync(config.certFile), key: fs.readFileSync(config.keyFile), minVersion: "TLSv1.2" }, handler);
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.listen(config.port, config.bind, () => console.log(`panel: listening on https://${config.bind}:${config.port}`));

// A renewed certificate (the certbot hook restarts the service, or sends SIGHUP)
process.on("SIGHUP", () => {
  try {
    server.setSecureContext({ cert: fs.readFileSync(config.certFile), key: fs.readFileSync(config.keyFile) });
    console.log("panel: certificate reloaded");
  } catch (error) {
    console.error(`panel: certificate reload failed: ${error.message}`);
  }
});
for (const Signal of ["SIGTERM", "SIGINT"]) process.on(Signal, () => server.close(() => process.exit(0)));
