import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { RefuseForeignPlayer } from "../middleware/RealProgressionOnly";
import { logger } from "../logger";
import { GetActiveHuntPass } from "../controllers/progressionconfig";
import { IsRealProgressionAccount } from "../controllers/progressionmode";
import { GetSelectedHuntPass } from "../controllers/realprogression";
import { GetBountyReply } from "../controllers/bounties";

// The Dauntless 1.14.7 client (TARGET_GAME_VERSION=1.14.7). Sources for the shapes:
// PORT-1.14.7/06-backend-1.14.7-contract.md (another 1.14.7 server's traffic, protocol facts only)
// and our static reading of the 2.1.1 client (docs/findings/backend-contract.md).
// A 404 on any player-data route fails a loader and sends the player back to the menu.
export const IsGame1147 = () => process.env.TARGET_GAME_VERSION === "1.14.7";

const Wrapped = (payload: unknown) => ({ code: null, message: "OK", payload });

// ---- Mounted BEFORE the 1.4.4 routers: same URL, different 1.14.7 shape ----
export const compat1147EarlyRouter = Router();
compat1147EarlyRouter.use((req, res, next) => IsGame1147() ? next() : next("router"));

// Hunt Pass: an object, and only season43..season50 are enabled rows in the 1.14.7 client
// (1.4.4 takes a bare string and season09b).
compat1147EarlyRouter.get("/huntpass/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
    let HuntPass = GetActiveHuntPass();
    if(IsRealProgressionAccount(req.params.userId)){
        if(RefuseForeignPlayer(req, res)){
            return;
        }
        const Selected = GetSelectedHuntPass(req.params.userId);
        if(/^season(4[3-9]|50)$/.test(Selected)) HuntPass = Selected;
    }
    res.json(Wrapped({ huntpass_id: HuntPass, season: HuntPass }));
});

// Bounties: the stored board plus the daily and weekly drafts and a season window around now.
const EMPTY_DRAFT = { current_draft_choices: [], previous_draft_selections: [], bronze_count: 0, silver_count: 0, gold_count: 0 };
compat1147EarlyRouter.get("/bounty/:userId", HasUndauntedMetagameAuth, (req: any, res, next) => {
    if(req.params.userId === "game-data") return next();
    const Board: any = IsRealProgressionAccount(req.params.userId) && !RefuseForeignPlayerQuiet(req)
        ? GetBountyReply(req.params.userId).payload
        : { bounties: [], draft_data: EMPTY_DRAFT };
    res.json(Wrapped({
        season_start_date: "2020-08-23T00:00:00.000Z",
        season_end_date: "2099-01-01T00:00:00.000Z",
        bounties: Board.bounties ?? [],
        draft_data: Board.draft_data ?? EMPTY_DRAFT,
        draft_data_daily: Board.draft_data_daily ?? EMPTY_DRAFT,
        draft_data_weekly: Board.draft_data_weekly ?? EMPTY_DRAFT
    }));
});

function RefuseForeignPlayerQuiet(req: any){
    return !req.AuthData?.IsGameserver && req.AuthData?.userId !== req.params.userId;
}

// Game-tuning blobs 1.14.7 reads (1.4.4 reads /bounty/game-data instead).
const GRANT_WINDOW = { on_claim_grant_item_event_id: "", on_claim_grant_item_start_date: "2026-01-01T00:00:00.000Z", on_claim_grant_item_end_date: "2099-12-31T00:00:00.000Z" };
const TUNING: Record<string, unknown> = {
    island_content_config: { DisallowedIslandContentAssets: [] },
    bounty_game_data: {
        bounty_data: [], item_grant_data: [
            { on_claim_grant_item_id: "TOKEN_BOUNTY_DRAFT_PREMIUM", on_claim_grant_item_amount: 1, ...GRANT_WINDOW },
            { on_claim_grant_item_id: "CURRENCY_PRESTIGE", on_claim_grant_item_amount: 5, ...GRANT_WINDOW }],
        bounty_token_id: "TOKEN_BOUNTY_DRAFT", premium_bounty_token_id: "TOKEN_BOUNTY_DRAFT_PREMIUM",
        bounty_token_grant_hour: 0, bronze_count: 9, silver_count: 3, gold_count: 1, history_length: 10,
        max_slots: 4, num_draft_options: 3, num_spicy_options: 1, num_tokens_hp_start: 4, num_tokens_per_day: 0,
        new_season_reset_bounties: false, token_rollover_warning_days: 1000
    },
    bounty_game_data_daily: {
        automatic_claim: true, automatic_draft: true, delete_claimed_bounties: false, bounty_data: [], item_grant_data: [],
        bounty_token_id: "TOKEN_DAILY_CHALLENGE_DRAFT", premium_bounty_token_id: "TOKEN_DAILY_CHALLENGE_DRAFT_PREMIUM",
        bounty_token_grant_hour: 0, bronze_count: 1, silver_count: 0, gold_count: 0, history_length: 10,
        max_slots: 1, num_draft_options: 3, num_spicy_options: 1, num_tokens_hp_start: 1, num_tokens_per_day: 0,
        new_season_reset_bounties: true, token_rollover_warning_days: 1000
    },
    bounty_game_data_weekly: {
        automatic_claim: true, automatic_draft: true, delete_claimed_bounties: false, bounty_data: [], item_grant_data: [],
        bounty_token_id: "TOKEN_WEEKLY_CHALLENGE_DRAFT", premium_bounty_token_id: "TOKEN_WEEKLY_CHALLENGE_DRAFT_PREMIUM",
        bounty_token_grant_hour: 0, bronze_count: 0, silver_count: 0, gold_count: 0, history_length: 8,
        max_slots: 4, num_draft_options: 3, num_spicy_options: 1, num_tokens_hp_start: 4, num_tokens_per_day: 0,
        new_season_reset_bounties: true, token_rollover_warning_days: 1000
    }
};
compat1147EarlyRouter.get("/game_tuning/:blobId", (req: any, res, next) => {
    const Blob = TUNING[req.params.blobId];
    if(Blob === undefined) return next();
    res.json(Wrapped(Blob));
});

// /progression/... routes 1.14.7 adds next to the 1.4.4 /progression/:userId/:progressionId, which
// would read them as an account id: tracked objectives (client), the Gauntlet level access and
// Gauntlet progression with an empty season (game server).
const TrackedObjectives = new Map<string, unknown>();
compat1147EarlyRouter.get("/progression/tracked_objectives/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
    res.json(Wrapped(TrackedObjectives.get(req.params.userId)
        ?? { current_set: "quest_slayer_links", omitted_quests: [], tracked_craftables: [], tracked_quests: [] }));
});
compat1147EarlyRouter.post("/progression/tracked_objectives/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
    if(req.body && typeof req.body === "object") TrackedObjectives.set(req.params.userId, req.body);
    res.json(Wrapped(null));
});
compat1147EarlyRouter.get(/^\/progression\/level_access(\/.*)?$/, HasUndauntedMetagameAuth, (req: any, res) => {
    res.json(Wrapped(0));
});
compat1147EarlyRouter.get(/^\/progression\/\/[^/]+$/, HasUndauntedMetagameAuth, (req: any, res) => {
    res.json(Wrapped({ personal_progression: 0, guild_progression: 0 }));
});

// ---- Mounted AFTER the 1.4.4 routers: routes 1.4.4 never asks for ----
export const compat1147Router = Router();

// IsBannedEndpoint: a 404 fails the login ("LoginOperation Failed - NotFound"). Flat, field `isBanned`.
compat1147Router.get("/isbanned", HasUndauntedMetagameAuth, (req: any, res) => {
    res.json({ accountId: req.AuthData.userId, isBanned: false });
});

// PlayerDataMigration*Endpoint: a 404 ends the login with "Player Data Migration Failed!" ("Your data
// failed to update"). The reply's Serialize (1.14.7 0x1C02C90) reads two booleans; finished and not
// failed lets the player through. Trigger is flat, status wrapped.
const MigrationDone = { migration_finished: true, migration_failed: false };
compat1147Router.post("/migration/trigger", HasUndauntedMetagameAuth, (req: any, res) => { res.json(MigrationDone); });
compat1147Router.all("/migration/status", HasUndauntedMetagameAuth, (req: any, res) => { res.json(Wrapped(MigrationDone)); });

// Player journey (/pjm): `nodes` is an object keyed by node id. Kept in memory for now, so the
// journey restarts empty after a metagame restart.
type Journey = { nodes: Record<string, unknown>, update_version: number };
const Journeys = new Map<string, Journey>();
const JourneyOf = (Key: string): Journey => Journeys.get(Key) ?? { nodes: {}, update_version: 0 };

// GET /pjm (client: the bearer's account), /pjm/{accountid} (game server),
// /pjm/{accountid}-{season}-{faction} and /pjm/seasonal/{season}-{faction} (factions).
compat1147Router.get(["/pjm", "/pjm/seasonal/:key", "/pjm/:key"], HasUndauntedMetagameAuth, (req: any, res) => {
    const Key = req.params.key ?? req.AuthData.userId ?? "";
    res.json(Wrapped(JourneyOf(Key)));
});
compat1147Router.post("/pjm/:key", HasUndauntedMetagameAuth, (req: any, res) => {
    const Key = req.params.key;
    const Nodes = req.body && typeof req.body.nodes === "object" && !Array.isArray(req.body.nodes) ? req.body.nodes : {};
    const Next = { nodes: Nodes, update_version: JourneyOf(Key).update_version + 1 };
    Journeys.set(Key, Next);
    logger.info(`Player journey ${Key} saved (${Object.keys(Nodes).length} node(s))`);
    res.json(Wrapped(Next));
});

// Weapon trackers: none.
compat1147Router.get("/weapon_tracker/:accountId/:itemId", HasUndauntedMetagameAuth, (req: any, res) => {
    res.json(Wrapped({ TrackersInfo: [] }));
});

// Gauntlet with no season running (the game server asks with an empty season id).
compat1147Router.get("/config", HasUndauntedMetagameAuth, (req: any, res) => {
    res.json(Wrapped({ gauntlet_id: "", start_at: "2024-01-01T00:00:00.000Z", end_at: "2024-01-02T00:00:00.000Z",
        each_level_rewards: [], milestone_rewards: [] }));
});
compat1147Router.get(/^\/rewards\/personal\/[^/]*\/[^/]+$/, HasUndauntedMetagameAuth, (req: any, res) => { res.json(Wrapped({})); });
compat1147Router.get(/^\/rewards\/guild\/[^/]*\/[^/]+$/, HasUndauntedMetagameAuth, (req: any, res) => { res.json(Wrapped(0)); });
compat1147Router.get(/^\/leaderboard\/get_leaderboard\/[^/]*$/, HasUndauntedMetagameAuth, (req: any, res) => { res.json(Wrapped([])); });

// Mailbox survey triggers: none.
compat1147Router.get("/survey/config", HasUndauntedMetagameAuth, (req: any, res) => {
    res.json(Wrapped({ Triggers: [] }));
});
