import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger";
import { Gameservers, CleanupServer, IsGameserverAlive, StopExpiredHunt } from "./gameservers";
import { NativeOccupancy } from './nativeoccupancy';
import { HuntLifetimeFromEnv } from './huntlifetime';
const Lifetime=HuntLifetimeFromEnv();

/**
 * TODO:
 * This watchdog is SUPER basic rn, only releases resources, the server itself handles cleaning itself up
 */

export async function RunWatchdog(){
    // Every minute: debug, not info (it was 211 of the 216 lines of a day's deploy.log)
    logger.debug(`Running Gameserver Watchdog!`);
    void PruneNativeFaultLogs();
    Lifetime.prune(new Set(Gameservers.map(server=>server.id)));

    for(const Gameserver of Gameservers){
        if(!IsGameserverAlive(Gameserver)){
            logger.info(`Cleaning up Gameserver on port ${Gameserver.port}`);

            // A restart of Ramsgate or the Dojo that fails is logged; it must not end the deploy server
            CleanupServer(Gameserver).catch((error) => logger.error(`Could not restart the game server on port ${Gameserver.port}: ${error instanceof Error ? error.message : String(error)}`));
        }
        else {
            const reason=Lifetime.reason(Gameserver,NativeOccupancy(Gameserver.processId,Gameserver.startTime));
            if(reason){
                try {if(StopExpiredHunt(Gameserver))logger.warn({port:Gameserver.port,reason,ageMinutes:(Date.now()-Gameserver.startTime.getTime())/60000},'Hunt lifetime limit: stopping instance');}
                catch(error){logger.error({error,port:Gameserver.port},'Could not stop expired hunt');}
            }
        }
    }
}

// The DLL's native-fault-<pid>.log files (GAMESERVER_READY_DIR) are kept for a week after their last write,
// for crash reports, then removed; they were never deleted before.
const NATIVE_FAULT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
async function PruneNativeFaultLogs(){
    const Dir = process.env.GAMESERVER_READY_DIR;
    if(!Dir) return;
    try{
        for(const Name of await readdir(Dir)){
            if(!/^native-fault-d+.log$/.test(Name)) continue;
            const File = path.join(Dir, Name);
            if(Date.now() - (await stat(File)).mtimeMs > NATIVE_FAULT_KEEP_MS) await unlink(File).catch(() => {});
        }
    }
    catch(error){
        logger.debug(`Could not prune native-fault logs: ${error instanceof Error ? error.message : String(error)}`);
    }
}
