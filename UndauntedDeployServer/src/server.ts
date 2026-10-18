import { app } from "./app";
import { IsPersistentWorldLivenessOn, StartupAndReportFailure, StopAllGameservers } from "./controllers/gameservers";
import { RunWatchdog } from "./controllers/watchdog";
import { logger } from "./logger";

if(process.env.SERVER_ROLE === "database-only") throw new Error("Deploy service disabled on database-only node");
const PORT = Number(process.env.PORT);
// The deploy server has no authentication at all -- anyone who can reach it
// can spawn game processes on this machine. It must never listen beyond
// loopback; only the metagame on the same host talks to it.
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";

app.listen(PORT, BIND_HOST, (err?: Error) => {
  if (err) {
    logger.fatal(`Could not listen on ${BIND_HOST}:${PORT}: ${err.message}`);
    process.exit(1);
  }

  // A failed start is reported, not an unhandled rejection (from github.com/Harmonicrain/Undaunted 895f7c7)
  void StartupAndReportFailure();

  setInterval(RunWatchdog, 60 * 1000);

  logger.info(`Dauntless Revived deploy server on port ${PORT}`);
  logger.info(`Ramsgate and Dojo liveness check before handing them out: ${IsPersistentWorldLivenessOn() ? "on" : "off (PERSISTENT_WORLD_LIVENESS=0)"}`);
  logger.info(`Clear Skies, Slayer.`);
});

// The game servers it started stop with it (a forced kill, e.g. Stop-Process -Force, runs none of this:
// PORT-1.14.7/stack/restart-deploy.ps1 stops the leftover -server processes itself)
for(const Signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const){
  process.once(Signal, () => {
    logger.info(`${Signal}: stopped ${StopAllGameservers()} game server(s), exiting`);
    process.exit(0);
  });
}