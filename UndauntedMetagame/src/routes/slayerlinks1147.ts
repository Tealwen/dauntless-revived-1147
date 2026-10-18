import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { PlayerTokenOnly } from "../middleware/PlayerAuth";
import { SlayerLinks } from "../features";
import { IsGame1147 } from "./compat1147";
import {
    AnswerSlayerLinkInvite1147, DeleteSlayerLinks1147, GrantSlayerLinkRewards1147, InviteToSlayerLink1147, LinkCaller, ListSlayerLinkInvites1147,
    ListSlayerLinks1147, SetSlayerLinkPrizePool1147, SlayerLinkAvailability1147, SlayerLinkReply, SlayerLinkStatus1147
} from "../controllers/slayerlinks1147";

// Slayer Links for the 1.14.7 client (TARGET_GAME_VERSION=1.14.7), mounted before routes/slayerlinks.ts:
// the nine LinkedSlayers* endpoints the 1.14.7 exe reads (the other six of DefaultGame.ini are not in the
// exe). The client sends invites, answers and the polls; the game server sends the prize pool, the
// rewards request and the removal. Shapes and rules: controllers/slayerlinks1147.ts and
// PORT-1.14.7/11-slayer-links.md. SLAYER_LINKS=0 turns these off as it does the 1.4.4 ones.
// DELETE /slayerlink/invites/{account_id} has no caller in Shipping and stays with the 1.4.4 router.

export const slayerLinks1147Router = Router();
slayerLinks1147Router.use((req, res, next) => IsGame1147() && SlayerLinks() ? next() : next("router"));

function Send(res: any, Reply: SlayerLinkReply){
    res.status(Reply.Status);
    res.json(Reply.Body);
}

function CallerOf(req: any): LinkCaller {
    const UserId = req.AuthData?.userId;

    return { IsGameserver: req.AuthData?.IsGameserver === true, UserId: typeof UserId === "string" && UserId.length > 0 ? UserId : undefined };
}

// Routes a game server may send: its key, or a player's token
function PlayerOrGameServer(req: any, res: any, next: any){
    const Caller = CallerOf(req);

    if(Caller.IsGameserver || Caller.UserId !== undefined){
        next();
        return;
    }

    res.status(403).json({ code: "403", message: "Forbidden", payload: null });
}

// The client's poll (with the DLL every 3 s): {invites, links, config}
slayerLinks1147Router.get("/slayerlink/status_good", HasUndauntedMetagameAuth, PlayerTokenOnly, (req: any, res) => {
    Send(res, SlayerLinkStatus1147(req.AuthData.userId));
});

slayerLinks1147Router.get("/slayerlink/invites", HasUndauntedMetagameAuth, PlayerTokenOnly, (req: any, res) => {
    Send(res, ListSlayerLinkInvites1147(req.AuthData.userId));
});

slayerLinks1147Router.get("/slayerlink/links", HasUndauntedMetagameAuth, PlayerTokenOnly, (req: any, res) => {
    Send(res, ListSlayerLinks1147(req.AuthData.userId));
});

// {account_id, slot, action_source: dedicated_screen|social_panel}
slayerLinks1147Router.put("/slayerlink/invite", HasUndauntedMetagameAuth, PlayerTokenOnly, (req: any, res) => {
    Send(res, InviteToSlayerLink1147(req.AuthData.userId, req.body));
});

// {account_id, action: accept|reject|cancel, slot, action_source}
slayerLinks1147Router.post("/slayerlink/invite", HasUndauntedMetagameAuth, PlayerTokenOnly, (req: any, res) => {
    Send(res, AnswerSlayerLinkInvite1147(req.AuthData.userId, req.body));
});

// {account_ids}
slayerLinks1147Router.post("/slayerlink/availability", HasUndauntedMetagameAuth, PlayerTokenOnly, (req: any, res) => {
    Send(res, SlayerLinkAvailability1147(req.AuthData.userId, req.body));
});

// Game server: {links: [{account_id, slot, prize_pool: [{catalog_id, quantity, received_for_level}]}]}
slayerLinks1147Router.put("/slayerlink/links/rewards", HasUndauntedMetagameAuth, PlayerOrGameServer, (req: any, res) => {
    Send(res, SetSlayerLinkPrizePool1147(CallerOf(req), req.body));
});

// Game server, when the player unlocks a finished link: {is_service_granting, rewards}
slayerLinks1147Router.get("/slayerlink/links/rewards/:accountId/:slot", HasUndauntedMetagameAuth, PlayerOrGameServer, (req: any, res) => {
    Send(res, GrantSlayerLinkRewards1147(CallerOf(req), req.params.accountId, req.params.slot));
});

// Game server (or player): {links: [{account_id, slot, delete_pair}]}
slayerLinks1147Router.delete("/slayerlink/links", HasUndauntedMetagameAuth, PlayerOrGameServer, (req: any, res) => {
    Send(res, DeleteSlayerLinks1147(CallerOf(req), req.body, req.query));
});
