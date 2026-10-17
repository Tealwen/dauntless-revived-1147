import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { logger } from "../logger";
import { EscalationMode, TrialsLeaderboards } from "../features";
import { AllLeaderboards, GroupIndividual, GroupLeaderboard, SoloIndividual, SoloLeaderboard, TrialIdForWeek, TrialsError, TrialsWindow, TrialWeekAt } from "../controllers/trials";

// Hunts for the Dauntless 1.14.7 client (TARGET_GAME_VERSION=1.14.7): Trials leaderboards and the
// Escalation save. Evidence: PORT-1.14.7/11-hunts-trials.md.
//
// The 1.14.7 Trials request body has the 1.4.4 fields (difficulty, page, page_size, trial_id,
// target_platforms: request builder 0x1944100) and the reply parser reads the same world/guild,
// solo (all, sword, hammer, axe, chainblades, pike, repeaters, strikers) and group keys
// (0xE21240, 0xE22290, 0xE23B20), so the 1.4.4 controllers (controllers/trials.ts) answer as they are.
// What changes is the client side: with an expired Trials schedule it asks with a trial_id outside
// the rotation, which the controllers refuse with 400 ("InternalQueryTopLeaderboards ... BadRequest",
// "QueryTopLeaderboardsForDiegetic ... UnknownError" in client.log). Here such a query gets an empty
// board for this week instead, and the refused trial_id is logged once.
const IsGame1147 = () => process.env.TARGET_GAME_VERSION === "1.14.7";
const Wrapped = (payload: unknown) => ({ code: null, message: "OK", payload });

function Only1147(_req: any, _res: any, next: any){
    next(IsGame1147() ? undefined : "router");
}

function TrialsQueryOn(req: any, _res: any, next: any){
    // Off, or a game server's result submission (body with completion_time): the 1.4.4 trialsRouter.
    next(TrialsLeaderboards() && req.body?.completion_time === undefined ? undefined : "route");
}

function QueryDifficulty(Body: any){
    const Value = Number(Body?.difficulty);
    return Value === 1 ? 1 : 0;
}

type Board = "all" | "solo" | "group" | "solo_individual" | "group_individual";

function EmptyBoard(Kind: Board, Body: any){
    if(Kind === "solo_individual" || Kind === "group_individual") return Wrapped({});

    const Difficulty = QueryDifficulty(Body);
    const TrialId = TrialIdForWeek(Difficulty, TrialWeekAt());
    const Page = Number.isSafeInteger(Number(Body?.page)) ? Number(Body.page) : 0;
    const PageSize = Number.isSafeInteger(Number(Body?.page_size)) ? Number(Body.page_size) : 100;

    if(Kind === "all"){
        return Wrapped({
            difficulty: Difficulty, guild: {}, page: Page, page_size: PageSize, trial_id: TrialId,
            world: {
                group: { difficulty: Difficulty, entries: [], page: Page, page_size: PageSize, trial_id: TrialId },
                solo: { all: { difficulty: Difficulty, entries: [] } }
            }
        });
    }
    return Wrapped({ difficulty: Difficulty, entries: [], page: Page, page_size: PageSize, trial_id: TrialId, ...TrialsWindow() });
}

const Refused = new Set<string>();
function Answer(Kind: Board, Work: (Body: unknown) => unknown){
    return (req: any, res: any, next: any) => {
        try{
            res.status(200).json(Work(req.body));
        }
        catch(error){
            if(!(error instanceof TrialsError) || error.Status !== 400){
                next(); // the 1.4.4 route answers (and logs) every other failure the same way as before
                return;
            }
            const Key = `${Kind}:${String(req.body?.trial_id)}:${String(req.body?.difficulty)}`;
            if(Refused.size < 200 && !Refused.has(Key)){
                Refused.add(Key);
                logger.info(`Trials ${Kind} query refused (${error.message}): trial_id=${JSON.stringify(req.body?.trial_id)} difficulty=${JSON.stringify(req.body?.difficulty)}; empty board sent (1.14.7)`);
            }
            res.status(200).json(EmptyBoard(Kind, req.body));
        }
    };
}

// ---- Mounted right after compat1147EarlyRouter, before the 1.4.4 trialsRouter ----
export const hunts1147EarlyRouter = Router();
hunts1147EarlyRouter.use(Only1147);

hunts1147EarlyRouter.post(["/trials/leaderboards", "/trials/leaderboards/all"], TrialsQueryOn, HasUndauntedMetagameAuth, Answer("all", AllLeaderboards));
hunts1147EarlyRouter.post("/trials/leaderboards/solo", TrialsQueryOn, HasUndauntedMetagameAuth, Answer("solo", SoloLeaderboard));
hunts1147EarlyRouter.post("/trials/leaderboards/solo/individual", TrialsQueryOn, HasUndauntedMetagameAuth, Answer("solo_individual", SoloIndividual));
hunts1147EarlyRouter.post("/trials/leaderboards/group", TrialsQueryOn, HasUndauntedMetagameAuth, Answer("group", GroupLeaderboard));
hunts1147EarlyRouter.post("/trials/leaderboards/group/individual", TrialsQueryOn, HasUndauntedMetagameAuth, Answer("group_individual", GroupIndividual));

// ---- Mounted after the 1.4.4 routers (next to compat1147Router) ----
export const hunts1147Router = Router();
hunts1147Router.use(Only1147);

// UpdateSeasonalEscalationEndpoint with ESCALATION_MODE=stub: 1.4.4 lets this POST fall to the
// catch-all 404; the 1.14.7 game server gets the record back (as the other 1.14.7 server answers),
// the same fake maximum GET /escalation/{season}/{account} sends. ESCALATION_MODE=real never gets
// here (escalationRouter answers).
function EscalationStubSave(_req: any, _res: any, next: any){
    next(EscalationMode() === "real" ? "route" : undefined);
}
hunts1147Router.post("/escalation/:escalationSeason/:userId", EscalationStubSave, HasUndauntedMetagameAuth, (req: any, res) => {
    logger.info(`Escalation save for season ${req.params.escalationSeason} (stubbed, 1.14.7)`);
    res.status(200).json(Wrapped({
        escalation_level: 99999,
        next_level_xp: 99999,
        talents_progress: [],
        unlock_progress: [],
        update_version: 1
    }));
});
