import crypto from "node:crypto";
import { and, asc, count, eq, gt, inArray, lte, or } from "drizzle-orm";
import { GetDb } from "../db";
import { progresstracks, slayerlinkinvites, slayerlinks, slayerlinkstate1147, users } from "../db/schema";
import { logger } from "../logger";
import type { Tx } from "./savehistory";
import { IsAccountIdShape } from "./login";
import { AreFriendsInTx, IsBlockedEitherWayInTx } from "./friends";
import { GetPartyOf } from "./party";
import { GetActiveHuntPass } from "./progressionconfig";
import { ComputeEarnedRanks, GetProgressionPath, INT32_MAX } from "./progressionrank";
import { AddProgressionGrantListener, GetGrantCap } from "./realprogression";
import { SlayerLinks } from "../features";
import { PublishToPlayer } from "../realtime/stompbus1147";
import RewardTables from "../vendor/slayer_link_rewards_1147.json";

// Slayer Links on the 1.14.7 client (TARGET_GAME_VERSION=1.14.7; routes/slayerlinks1147.ts). The 1.4.4
// rules (controllers/slayerlinks.ts: friends only, 3 slots numbered 1..3, one pending invite per pair, the
// invite rate limit) plus what 1.14.7 added. Evidence: PORT-1.14.7/11-slayer-links.md.
//
// - Invites run out after 48 h (the 1.14.7 texts say so; status_good's config tells the client).
// - The link "charges" while the two hunt together: each Hunt Pass XP grant the game server sends for a
//   player (POST /progression/:uid/<pass>/:amount) adds the same amount to that player's
//   Linked_Slayer_Slot_<slot> track when the linked partner is in the player's party. The client reads the
//   link's level from that progression track (UArchonLinkedSlayers::UpdateSlotProgression, exe 0x1C8BEA0);
//   nothing in the exe grants it, so the backend did. The tracks are in the progression config
//   (vendor/progression-1147/Linked_Slayer_Slot_N.json): 4 levels.
// - Prize pool: the game server draws 12 prizes from linked_slayer_rewards when a slot is activated and
//   sends them in PUT /slayerlink/links/rewards; each has received_for_level 1..4 (the level that wins it)
//   or -1 (shown, not won). The first pool a link gets is kept and both players share it. A link with no
//   pool POOL_WAIT_MS after the accept (no game server: the player was not in Ramsgate) gets one drawn
//   here the same way.
// - After the week the link is complete (the client compares `ends` with the server time). The player's
//   "unlock" makes the game server ask GET /slayerlink/links/rewards/{account_id}/{slot}: the prizes of the
//   levels that player reached, once (is_service_granting false: the game server grants them through the
//   inventory, reason "SlayerLinks.GrantRewards"). The link then stays in that player's slots for
//   CLAIM_GRACE_MS (the summary screen) and frees the slot at once.
// - DELETE /slayerlink/links {links: [{account_id, slot, delete_pair}]} (game server or player): a running
//   link ends for both, unless it is charged (then 409, the client says it cannot be cancelled); a finished
//   one leaves that player's slots only.
//
// The game server's requests carry its own key, and the account in them may be the player or the
// partner: a request names (account, slot), which is read as "this account's link in its slot", else as
// "the link of this account whose other player holds that slot".

export const LINK_SLOTS = 3;
export const INVITE_EXPIRY_HOURS = 48;
export const LINK_DURATION_HOURS = 168;
export const TRACK_PREFIX = "Linked_Slayer_Slot_";
export const CLAIM_GRACE_MS = 10 * 60 * 1000;
export const POOL_WAIT_MS = 20 * 1000;
export const MAX_AVAILABILITY_IDS = 50;
export const MAX_INVITES_PER_WINDOW = 20;
export const INVITE_WINDOW_MS = 10 * 60 * 1000;
export const KEEP_DAYS = 30;
const MAX_POOL_ENTRIES = 50;
const HOUR_MS = 60 * 60 * 1000;

export type SlayerLinkReply = { Status: number, Body: unknown };
export type Prize = { catalog_id: string, quantity: number, received_for_level: number };

type InviteRow = typeof slayerlinkinvites.$inferSelect;
type LinkRow = typeof slayerlinks.$inferSelect;
type StateRow = typeof slayerlinkstate1147.$inferSelect;
type Side = "sender" | "target";
type Linked = { Link: LinkRow, State: StateRow };
type Action = "accept" | "reject" | "cancel";

const ANSWERED: Record<Action, string> = { accept: "ACCEPTED", reject: "DECLINED", cancel: "CANCELED" };
const ALL_SLOTS = Array.from({ length: LINK_SLOTS }, (_, Index) => Index + 1);

let Clock: () => number = () => Date.now();
let Random: () => number = Math.random;

// Tests only: a controllable clock and dice
export function SetSlayerLink1147ClockForTests(NewClock?: () => number){
    Clock = NewClock ?? (() => Date.now());
}

export function SetSlayerLink1147RandomForTests(NewRandom?: () => number){
    Random = NewRandom ?? Math.random;
}

function Ok(Payload: unknown): SlayerLinkReply {
    return { Status: 200, Body: { code: null, message: "OK", payload: Payload } };
}

function Fail(Status: number, Message: string): SlayerLinkReply {
    return { Status, Body: { code: String(Status), message: Message, payload: null } };
}

function Shown(Value: unknown){
    return IsAccountIdShape(Value) ? Value : typeof Value === "string" ? "<not an account id>" : "<none>";
}

function SlotOf(Value: unknown): number | undefined {
    const Slot = typeof Value === "number" ? Value : typeof Value === "string" && /^\d{1,2}$/.test(Value) ? Number(Value) : NaN;

    return Number.isInteger(Slot) && Slot >= 1 && Slot <= LINK_SLOTS ? Slot : undefined;
}

// The client's STOMP handlers only log a message (realtime/stompbus1147.ts); it learns of a change from its
// own poll of status_good (every 3 s with the DLL's SocialPollRate1147). The message shows in client.log.
function Notify(AccountId: string, Event: string, Data: Record<string, unknown>){
    try{
        PublishToPlayer(AccountId, { type: "slayer_link", event: Event, ...Data });
    }
    catch(error){
        logger.debug(`slayerlink: stomp publish failed (${(error as Error).message})`);
    }
}

// ---- Links, sides and slots ----

function SideOf(Link: LinkRow, AccountId: string): Side | undefined {
    return Link.senderId === AccountId ? "sender" : Link.targetId === AccountId ? "target" : undefined;
}

function OtherOf(Row: { senderId: string, targetId: string }, AccountId: string){
    return Row.senderId === AccountId ? Row.targetId : Row.senderId;
}

function SlotFor(Link: LinkRow, AccountId: string){
    return Link.senderId === AccountId ? Link.senderSlot : Link.targetSlot;
}

function ClaimedAt(State: StateRow, S: Side){
    return S === "sender" ? State.senderClaimedAt : State.targetClaimedAt;
}

function RemovedAt(State: StateRow, S: Side){
    return S === "sender" ? State.senderRemovedAt : State.targetRemovedAt;
}

function EmptyState(LinkId: string): StateRow {
    return { linkId: LinkId, prizePool: null, poolSource: null, senderClaimedAt: null, targetClaimedAt: null, senderRewards: null, targetRewards: null, senderRemovedAt: null, targetRemovedAt: null };
}

function StateOf(tx: Tx, LinkId: string): StateRow {
    return tx.select().from(slayerlinkstate1147).where(eq(slayerlinkstate1147.linkId, LinkId)).get() ?? EmptyState(LinkId);
}

function SaveState(tx: Tx, State: StateRow){
    tx.insert(slayerlinkstate1147).values(State).onConflictDoUpdate({ target: slayerlinkstate1147.linkId, set: State }).run();
}

// Every link of this account not older than KEEP_DAYS, newest first, with its state
function LinksOf(tx: Tx, AccountId: string, Now: number): Linked[] {
    const Rows = tx.select().from(slayerlinks)
        .where(and(gt(slayerlinks.endsAt, Now - KEEP_DAYS * 24 * HOUR_MS), or(eq(slayerlinks.senderId, AccountId), eq(slayerlinks.targetId, AccountId))))
        .orderBy(asc(slayerlinks.createdAt)).all().reverse();

    // One query for every state (the client polls every 3 s)
    const States = Rows.length === 0 ? new Map<string, StateRow>() : new Map(tx.select().from(slayerlinkstate1147)
        .where(inArray(slayerlinkstate1147.linkId, Rows.map((Link) => Link.linkId))).all().map((State) => [State.linkId, State]));

    return Rows.map((Link) => ({ Link, State: States.get(Link.linkId) ?? EmptyState(Link.linkId) }));
}

function IsRunning(Link: LinkRow, Now: number){
    return Link.endsAt > Now;
}

// A link this account still has in its slots: not removed, and running, or finished and not yet
// unlocked, or unlocked less than CLAIM_GRACE_MS ago
function IsShown(Each: Linked, AccountId: string, Now: number){
    const S = SideOf(Each.Link, AccountId)!;
    const Claimed = ClaimedAt(Each.State, S);

    return RemovedAt(Each.State, S) == null && (IsRunning(Each.Link, Now) || Claimed == null || Now - Claimed < CLAIM_GRACE_MS);
}

// A link holds its slot until its rewards are unlocked (or it is removed)
function HoldsSlot(Each: Linked, AccountId: string){
    const S = SideOf(Each.Link, AccountId)!;

    return RemovedAt(Each.State, S) == null && ClaimedAt(Each.State, S) == null;
}

// The links shown in this account's slots, one per slot (the newest)
function ShownLinksOf(tx: Tx, AccountId: string, Now: number): Linked[] {
    const BySlot = new Map<number, Linked>();

    for(const Each of LinksOf(tx, AccountId, Now)){
        const Slot = SlotFor(Each.Link, AccountId);

        if(IsShown(Each, AccountId, Now) && !BySlot.has(Slot)){
            BySlot.set(Slot, Each);
        }
    }

    return [...BySlot.values()].sort((A, B) => SlotFor(A.Link, AccountId) - SlotFor(B.Link, AccountId));
}

function FreeSlots(tx: Tx, AccountId: string, Now: number): number[] {
    const Held = new Set(LinksOf(tx, AccountId, Now).filter((Each) => HoldsSlot(Each, AccountId)).map((Each) => SlotFor(Each.Link, AccountId)));

    return ALL_SLOTS.filter((Slot) => !Held.has(Slot));
}

// A running link between the two (a finished one does not stop a new link: "Link Again")
function LinkedWith(tx: Tx, A: string, B: string, Now: number){
    return LinksOf(tx, A, Now).some((Each) => OtherOf(Each.Link, A) === B && IsRunning(Each.Link, Now) && RemovedAt(Each.State, SideOf(Each.Link, A)!) == null);
}

// The link a request names by (account, slot); see the top of the file. Running or finished, not removed
// by the side it is about.
function FindLinkBySlot(tx: Tx, AccountId: string, Slot: number, Now: number): { Each: Linked, Player: string } | undefined {
    const Mine = LinksOf(tx, AccountId, Now);
    const Own = Mine.find((Each) => SlotFor(Each.Link, AccountId) === Slot && RemovedAt(Each.State, SideOf(Each.Link, AccountId)!) == null);

    if(Own !== undefined){
        return { Each: Own, Player: AccountId };
    }

    const Theirs = Mine.find((Each) => {
        const Other = OtherOf(Each.Link, AccountId);
        return SlotFor(Each.Link, Other) === Slot && RemovedAt(Each.State, SideOf(Each.Link, Other)!) == null;
    });

    return Theirs !== undefined ? { Each: Theirs, Player: OtherOf(Theirs.Link, AccountId) } : undefined;
}

// ---- Progression (the link's level) ----

export function TrackIdFor(Slot: number){
    return `${TRACK_PREFIX}${Slot}`;
}

function TrackProgress(tx: Tx, AccountId: string, Slot: number){
    return tx.select().from(progresstracks).where(and(eq(progresstracks.accountId, AccountId), eq(progresstracks.progressionId, TrackIdFor(Slot)))).get()?.progress ?? 0;
}

function SetTrackProgress(tx: Tx, AccountId: string, Slot: number, Progress: number){
    const Now = new Date().toISOString();
    const Values = { progress: Progress, confirmedFreeRank: 0, confirmedPremiumRank: 0, confirmedDate: "2019-01-01T00:00:00.000Z", updatedDate: Now };

    tx.insert(progresstracks).values({ accountId: AccountId, progressionId: TrackIdFor(Slot), ...Values })
        .onConflictDoUpdate({ target: [progresstracks.accountId, progresstracks.progressionId], set: Values }).run();
}

// The link level a player reached: the rank of their slot's track
function LevelOf(tx: Tx, AccountId: string, Slot: number){
    const Path = GetProgressionPath(TrackIdFor(Slot));

    return Path === undefined ? 0 : ComputeEarnedRanks(Path, TrackProgress(tx, AccountId, Slot), false).EarnedFreeRank;
}

// Levels a link can reach: the ranks of Linked_Slayer_Slot_1 after rank 0, as the game server counts them
// when it draws (GeneratePrizePoolInternal, exe 0x19FF7F0)
function LevelCount(){
    return Math.max(0, (GetProgressionPath(TrackIdFor(1))?.requirements?.length ?? 1) - 1);
}

function IsHuntPassTrack(ProgressionId: string){
    return ProgressionId === GetActiveHuntPass() || /^season\d+[a-z]?$/.test(ProgressionId) || ProgressionId.startsWith("eventpass_");
}

// After the game server granted a player Hunt Pass XP (routes/progression.ts): the same amount on the
// track of each running link whose partner is in the player's party. Returns what it added, for the tests.
export function AddLinkProgressForHuntPassXp(AccountId: string, ProgressionId: string, AmountRaw: unknown): { Slot: number, Partner: string, Progress: number }[] {
    const Amount = typeof AmountRaw === "number" ? AmountRaw : typeof AmountRaw === "string" && /^\d{1,10}$/.test(AmountRaw) ? Number(AmountRaw) : NaN;

    if(!IsHuntPassTrack(ProgressionId) || !Number.isSafeInteger(Amount) || Amount <= 0){
        return [];
    }

    const Party = GetPartyOf(AccountId)?.Members ?? [];

    if(Party.length < 2){
        return [];
    }

    const Added = Math.min(Amount, GetGrantCap());
    const Now = Clock();
    const Done = GetDb().transaction((tx) => {
        const Out: { Slot: number, Partner: string, Progress: number }[] = [];

        for(const Each of LinksOf(tx, AccountId, Now)){
            const Partner = OtherOf(Each.Link, AccountId);

            if(!IsRunning(Each.Link, Now) || !HoldsSlot(Each, AccountId) || !Party.includes(Partner)){
                continue;
            }

            const Slot = SlotFor(Each.Link, AccountId);
            const Progress = Math.min(TrackProgress(tx, AccountId, Slot) + Added, INT32_MAX);

            SetTrackProgress(tx, AccountId, Slot, Progress);
            Out.push({ Slot, Partner, Progress });
        }

        return Out;
    });

    for(const Each of Done){
        logger.info(`slayerlink: ${AccountId} earned ${Added} Hunt Pass XP with ${Each.Partner}: ${TrackIdFor(Each.Slot)} -> ${Each.Progress} (level ${GetDb().transaction((tx) => LevelOf(tx, AccountId, Each.Slot))})`);
        Notify(AccountId, "progress", { account_id: Each.Partner, slot: Each.Slot, progress: Each.Progress });
    }

    return Done;
}

AddProgressionGrantListener((AccountId, ProgressionId, Amount) => {
    if(process.env.TARGET_GAME_VERSION === "1.14.7" && SlayerLinks()){
        AddLinkProgressForHuntPassXp(AccountId, ProgressionId, Amount);
    }
});

// ---- Prize pool ----

type TableRow = { catalog_id: string, amount: number, weight: number, item_class: number };

// GeneratePrizePoolInternal's draw: ClassesToDraw[c] prizes of each class c, weighted by ItemWeight (one row
// at most once), shuffled; the first LevelCount() get levels 1..n, the rest -1
export function DrawPrizePool(): Prize[] {
    const Rows = RewardTables.rewards as TableRow[];
    const Drawn: Prize[] = [];

    RewardTables.classes_to_draw.forEach((Wanted, Class) => {
        const Left = Rows.filter((Row) => Row.item_class === Class && Row.weight > 0);

        for(let Index = 0; Index < Wanted && Left.length > 0; Index++){
            const Total = Left.reduce((Sum, Row) => Sum + Row.weight, 0);
            let Pick = Random() * Total;
            let At = Left.findIndex((Row) => (Pick -= Row.weight) < 0);

            if(At < 0) At = Left.length - 1;

            const [Row] = Left.splice(At, 1);
            Drawn.push({ catalog_id: Row.catalog_id, quantity: Row.amount, received_for_level: -1 });
        }
    });

    Shuffle(Drawn);
    Drawn.slice(0, LevelCount()).forEach((Prize, Index) => { Prize.received_for_level = Index + 1; });
    Shuffle(Drawn);

    return Drawn;
}

function Shuffle<T>(List: T[]){
    for(let Index = List.length - 1; Index > 0; Index--){
        const Other = Math.floor(Random() * (Index + 1));
        [List[Index], List[Other]] = [List[Other], List[Index]];
    }
}

function PoolOf(State: StateRow): Prize[] {
    try{
        const Parsed = State.prizePool == null ? [] : JSON.parse(State.prizePool);
        return Array.isArray(Parsed) ? Parsed : [];
    }
    catch{
        return [];
    }
}

// A prize list the game server sent, kept to the shape the client reads
function ParsePool(Value: unknown): Prize[] | undefined {
    if(!Array.isArray(Value) || Value.length === 0 || Value.length > MAX_POOL_ENTRIES){
        return undefined;
    }

    const Pool: Prize[] = [];

    for(const Entry of Value){
        const Id = Entry?.catalog_id;
        const Quantity = Entry?.quantity;
        const Level = Entry?.received_for_level ?? -1;

        if(typeof Id !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(Id) || !Number.isSafeInteger(Quantity) || Quantity < 1 || Quantity > 1_000_000 || !Number.isSafeInteger(Level) || Level < -1 || Level > 100){
            return undefined;
        }

        Pool.push({ catalog_id: Id, quantity: Quantity, received_for_level: Level });
    }

    return Pool;
}

// A link with no pool once POOL_WAIT_MS passed gets one drawn here
function EnsurePoolInTx(tx: Tx, Each: Linked, Now: number){
    if(Each.State.prizePool != null || Now - Each.Link.createdAt < POOL_WAIT_MS){
        return;
    }

    Each.State = { ...Each.State, prizePool: JSON.stringify(DrawPrizePool()), poolSource: "metagame" };
    SaveState(tx, Each.State);
    logger.info(`slayerlink: no prize pool from a game server for link ${Each.Link.linkId} after ${POOL_WAIT_MS / 1000} s, drew one`);
}

// The prizes a player's level won
function WonBy(tx: Tx, Each: Linked, AccountId: string): Prize[] {
    const Level = LevelOf(tx, AccountId, SlotFor(Each.Link, AccountId));

    return PoolOf(Each.State).filter((Prize) => Prize.received_for_level >= 1 && Prize.received_for_level <= Level);
}

// ---- Housekeeping ----

function AccountExists(tx: Tx, AccountId: string){
    return tx.select({ userId: users.userId }).from(users).where(eq(users.userId, AccountId)).get() != undefined;
}

function Involving(AccountId: string){
    return or(eq(slayerlinkinvites.senderId, AccountId), eq(slayerlinkinvites.targetId, AccountId));
}

function ExpireInvitesInTx(tx: Tx, AccountIds: string[], Now: number){
    for(const AccountId of new Set(AccountIds)){
        for(const Column of [slayerlinkinvites.senderId, slayerlinkinvites.targetId]){
            tx.update(slayerlinkinvites).set({ status: "EXPIRED" })
                .where(and(eq(slayerlinkinvites.status, "PENDING"), lte(slayerlinkinvites.expiresAt, Now), eq(Column, AccountId))).run();
        }
    }
}

function PendingInvitesOf(tx: Tx, AccountId: string, Now: number): InviteRow[] {
    return tx.select().from(slayerlinkinvites)
        .where(and(eq(slayerlinkinvites.status, "PENDING"), gt(slayerlinkinvites.expiresAt, Now), Involving(AccountId)))
        .orderBy(asc(slayerlinkinvites.createdAt)).all();
}

function RecentInvitesBy(tx: Tx, AccountId: string, Now: number){
    return tx.select({ Sent: count() }).from(slayerlinkinvites)
        .where(and(eq(slayerlinkinvites.senderId, AccountId), gt(slayerlinkinvites.createdAt, Now - INVITE_WINDOW_MS))).get()?.Sent ?? 0;
}

function SweepInTx(tx: Tx, Now: number){
    const Before = Now - KEEP_DAYS * 24 * HOUR_MS;

    tx.delete(slayerlinkinvites).where(and(inArray(slayerlinkinvites.status, ["DECLINED", "CANCELED", "EXPIRED"]), lte(slayerlinkinvites.expiresAt, Now))).run();
    tx.delete(slayerlinkinvites).where(and(eq(slayerlinkinvites.status, "ACCEPTED"), lte(slayerlinkinvites.expiresAt, Before))).run();

    const Old = tx.select({ linkId: slayerlinks.linkId }).from(slayerlinks).where(lte(slayerlinks.endsAt, Before)).all().map((Row) => Row.linkId);

    if(Old.length > 0){
        tx.delete(slayerlinkstate1147).where(inArray(slayerlinkstate1147.linkId, Old)).run();
        tx.delete(slayerlinks).where(inArray(slayerlinks.linkId, Old)).run();
    }
}

// ---- Replies ----

function InviteEntry(Row: InviteRow, AccountId: string){
    return {
        account_id: OtherOf(Row, AccountId),
        slot: Row.senderSlot,
        direction: Row.senderId === AccountId ? "sent" : "received",
        status: "pending",
        expires: new Date(Row.expiresAt).toISOString(),
        link_id: Row.inviteId
    };
}

function LinkEntry(Each: Linked, AccountId: string){
    const Other = OtherOf(Each.Link, AccountId);

    return {
        account_id: Other,
        linked_account_id: Other,
        slot: SlotFor(Each.Link, AccountId),
        ends: new Date(Each.Link.endsAt).toISOString(),
        link_id: Each.Link.linkId,
        prize_pool: PoolOf(Each.State)
    };
}

function ReadLists(AccountId: string){
    const Now = Clock();

    // No ExpireInvitesInTx here: PendingInvitesOf already leaves out expired invites, and the writes
    // (invite, accept) mark them EXPIRED, so a poll writes nothing unless a prize pool must be drawn.
    return GetDb().transaction((tx) => {
        const Shown = ShownLinksOf(tx, AccountId, Now);

        for(const Each of Shown){
            EnsurePoolInTx(tx, Each, Now);
        }

        return {
            Invites: PendingInvitesOf(tx, AccountId, Now).map((Row) => InviteEntry(Row, AccountId)),
            Links: Shown.map((Each) => LinkEntry(Each, AccountId))
        };
    });
}

// GET /slayerlink/invites
export function ListSlayerLinkInvites1147(AccountId: string): SlayerLinkReply {
    return Ok({ invites: ReadLists(AccountId).Invites });
}

// GET /slayerlink/links
export function ListSlayerLinks1147(AccountId: string): SlayerLinkReply {
    return Ok({ links: ReadLists(AccountId).Links });
}

// GET /slayerlink/status_good (the client's poll)
export function SlayerLinkStatus1147(AccountId: string): SlayerLinkReply {
    const Lists = ReadLists(AccountId);

    return Ok({
        invites: Lists.Invites,
        links: Lists.Links,
        config: { link_duration_hours: LINK_DURATION_HOURS, invite_expiry_hours: INVITE_EXPIRY_HOURS }
    });
}

// ---- Invites ----

// PUT /slayerlink/invite {account_id, slot, action_source}
export function InviteToSlayerLink1147(Caller: string, Body: any): SlayerLinkReply {
    const Target = Body?.account_id;
    const Slot = SlotOf(Body?.slot);
    const Refuse = (Status: number, Why: string) => {
        logger.info(`slayerlink: invite by=${Caller} to=${Shown(Target)} slot=${Slot ?? "?"} refused ${Status}: ${Why}`);
        return Fail(Status, Why);
    };

    if(!IsAccountIdShape(Target)){
        return Refuse(400, "no account to invite");
    }

    if(Slot === undefined){
        return Refuse(400, `the slot must be 1 to ${LINK_SLOTS}`);
    }

    if(Target === Caller){
        return Refuse(409, "you cannot link with yourself");
    }

    const Now = Clock();
    const Result = GetDb().transaction((tx): SlayerLinkReply | { InviteId: string, Again: boolean } => {
        if(!AccountExists(tx, Target)){
            return Refuse(404, "no such account");
        }

        if(IsBlockedEitherWayInTx(tx, Caller, Target)){
            return Refuse(403, "blocked");
        }

        if(!AreFriendsInTx(tx, Caller, Target)){
            return Refuse(403, "only friends can link");
        }

        ExpireInvitesInTx(tx, [Caller, Target], Now);

        const Pending = PendingInvitesOf(tx, Caller, Now);
        const ToTarget = Pending.find((Row) => Row.senderId === Caller && Row.targetId === Target);

        if(ToTarget !== undefined){
            return { InviteId: ToTarget.inviteId, Again: true };
        }

        if(Pending.some((Row) => Row.senderId === Target && Row.targetId === Caller)){
            return Refuse(409, "this player already invited you");
        }

        if(LinkedWith(tx, Caller, Target, Now)){
            return Refuse(409, "already linked with this player");
        }

        if(!FreeSlots(tx, Caller, Now).includes(Slot)){
            return Refuse(409, "the slot is already linked");
        }

        if(Pending.some((Row) => Row.senderId === Caller && Row.senderSlot === Slot)){
            return Refuse(409, "the slot already has an invite waiting");
        }

        if(FreeSlots(tx, Target, Now).length === 0){
            return Refuse(409, "the player has no free slot");
        }

        if(RecentInvitesBy(tx, Caller, Now) >= MAX_INVITES_PER_WINDOW){
            return Refuse(409, `too many invites: at most ${MAX_INVITES_PER_WINDOW} in ${INVITE_WINDOW_MS / 60000} minutes`);
        }

        const InviteId = crypto.randomUUID();

        tx.insert(slayerlinkinvites).values({
            inviteId: InviteId,
            senderId: Caller,
            targetId: Target,
            senderSlot: Slot,
            createdAt: Now,
            expiresAt: Now + INVITE_EXPIRY_HOURS * HOUR_MS,
            status: "PENDING"
        }).run();
        SweepInTx(tx, Now);

        return { InviteId, Again: false };
    });

    if(!("InviteId" in Result)){
        return Result;
    }

    logger.info(`slayerlink: invite by=${Caller} to=${Target} slot=${Slot} (${typeof Body?.action_source === "string" ? Body.action_source.slice(0, 32) : "?"}) -> ${Result.Again ? "already invited" : "sent"} id=${Result.InviteId}`);

    if(!Result.Again){
        Notify(Target, "invite_received", { account_id: Caller, slot: Slot, link_id: Result.InviteId });
    }

    return Ok({ link_id: Result.InviteId });
}

function FindInviteInTx(tx: Tx, Caller: string, Act: Action, Ids: string[], Other: unknown): InviteRow | undefined {
    const Mine = Act === "cancel" ? slayerlinkinvites.senderId : slayerlinkinvites.targetId;
    const Theirs = Act === "cancel" ? slayerlinkinvites.targetId : slayerlinkinvites.senderId;

    for(const Id of Ids){
        const ById = tx.select().from(slayerlinkinvites).where(and(eq(slayerlinkinvites.inviteId, Id), eq(Mine, Caller))).get();

        if(ById !== undefined){
            return ById;
        }
    }

    if(!IsAccountIdShape(Other)){
        return undefined;
    }

    const Rows = tx.select().from(slayerlinkinvites).where(and(eq(Mine, Caller), eq(Theirs, Other))).orderBy(asc(slayerlinkinvites.createdAt)).all();

    return Rows.find((Row) => Row.status === "PENDING") ?? Rows.at(-1);
}

// A player with no free slot left can take no other link: their other pending invites end (the 1.14.7
// text: accepting on the last free slot declines the others)
function CloseInvitesOfFullInTx(tx: Tx, AccountId: string, Now: number){
    if(FreeSlots(tx, AccountId, Now).length > 0){
        return 0;
    }

    const Got = tx.update(slayerlinkinvites).set({ status: "DECLINED" })
        .where(and(eq(slayerlinkinvites.status, "PENDING"), eq(slayerlinkinvites.targetId, AccountId))).run().changes;
    const Sent = tx.update(slayerlinkinvites).set({ status: "CANCELED" })
        .where(and(eq(slayerlinkinvites.status, "PENDING"), eq(slayerlinkinvites.senderId, AccountId))).run().changes;

    return Got + Sent;
}

// POST /slayerlink/invite {account_id, action: accept|reject|cancel, slot, action_source}
export function AnswerSlayerLinkInvite1147(Caller: string, Body: any): SlayerLinkReply {
    const Raw = typeof Body?.action === "string" ? Body.action.toLowerCase() : "";
    const Other = Body?.account_id;
    const Refuse = (Status: number, Why: string) => {
        logger.info(`slayerlink: ${Raw || "answer"} by=${Caller} other=${Shown(Other)} refused ${Status}: ${Why}`);
        return Fail(Status, Why);
    };

    if(Raw !== "accept" && Raw !== "reject" && Raw !== "cancel"){
        return Refuse(400, "the action must be accept, reject or cancel");
    }

    const Act: Action = Raw;
    const Ids = [Body?.link_id, Body?.invite_id].filter((Id): Id is string => typeof Id === "string" && Id.length > 0 && Id.length <= 64);
    const Now = Clock();

    const Result = GetDb().transaction((tx): SlayerLinkReply | { Row: InviteRow, Again: boolean, Slot?: number, Closed?: number } => {
        const Row = FindInviteInTx(tx, Caller, Act, Ids, Other);

        if(Row === undefined){
            return Refuse(404, "no such invite");
        }

        if(Row.status !== "PENDING"){
            if(Row.status === ANSWERED[Act]){
                return { Row, Again: true };
            }

            return Refuse(409, Row.status === "EXPIRED" ? "the invite ran out" : `the invite was already ${Row.status.toLowerCase()}`);
        }

        if(Row.expiresAt <= Now){
            tx.update(slayerlinkinvites).set({ status: "EXPIRED" }).where(eq(slayerlinkinvites.inviteId, Row.inviteId)).run();
            return Refuse(409, "the invite ran out");
        }

        let TargetSlot: number | undefined;
        let Closed = 0;

        if(Act === "accept"){
            if(IsBlockedEitherWayInTx(tx, Row.senderId, Row.targetId) || !AreFriendsInTx(tx, Row.senderId, Row.targetId)){
                return Refuse(403, "only friends can link");
            }

            if(LinkedWith(tx, Row.senderId, Row.targetId, Now)){
                return Refuse(409, "already linked with this player");
            }

            if(!FreeSlots(tx, Row.senderId, Now).includes(Row.senderSlot)){
                return Refuse(409, "the other player's slot is taken");
            }

            const Free = FreeSlots(tx, Row.targetId, Now);
            const Asked = SlotOf(Body?.slot);

            TargetSlot = Asked !== undefined && Free.includes(Asked) ? Asked : Free[0];

            if(TargetSlot === undefined){
                return Refuse(409, "no free slot");
            }

            tx.insert(slayerlinks).values({
                linkId: Row.inviteId,
                senderId: Row.senderId,
                targetId: Row.targetId,
                senderSlot: Row.senderSlot,
                targetSlot: TargetSlot,
                createdAt: Now,
                endsAt: Now + LINK_DURATION_HOURS * HOUR_MS
            }).run();
            SaveState(tx, StateOf(tx, Row.inviteId));

            // A new link starts at level 0 on both sides
            SetTrackProgress(tx, Row.senderId, Row.senderSlot, 0);
            SetTrackProgress(tx, Row.targetId, TargetSlot, 0);
        }

        tx.update(slayerlinkinvites).set({ status: ANSWERED[Act] }).where(eq(slayerlinkinvites.inviteId, Row.inviteId)).run();

        if(Act === "accept"){
            Closed = CloseInvitesOfFullInTx(tx, Row.targetId, Now) + CloseInvitesOfFullInTx(tx, Row.senderId, Now);
        }

        return { Row, Again: false, Slot: TargetSlot, Closed };
    });

    if(!("Row" in Result)){
        return Result;
    }

    const OtherId = OtherOf(Result.Row, Caller);

    logger.info(`slayerlink: ${Act} by=${Caller} other=${OtherId} id=${Result.Row.inviteId} -> ${Result.Again ? "already done" : ANSWERED[Act].toLowerCase()}${Result.Slot !== undefined ? ` (slots ${Result.Row.senderSlot} and ${Result.Slot}, ends in ${LINK_DURATION_HOURS} h)` : ""}${Result.Closed ? `, ${Result.Closed} other invite(s) closed (no free slot left)` : ""}`);

    if(!Result.Again){
        const Event = Act === "accept" ? "invite_accepted" : Act === "reject" ? "invite_declined" : "invite_cancelled";
        Notify(OtherId, Event, { account_id: Caller, link_id: Result.Row.inviteId });
    }

    return Ok({ link_id: Result.Row.inviteId });
}

// POST /slayerlink/availability {account_ids}
export function SlayerLinkAvailability1147(Caller: string, Body: any): SlayerLinkReply {
    const Ids = [...new Set((Array.isArray(Body?.account_ids) ? Body.account_ids : []).filter((Id: unknown): Id is string => typeof Id === "string" && Id.length > 0 && Id.length <= 128))].slice(0, MAX_AVAILABILITY_IDS) as string[];
    const Now = Clock();

    const Availability = GetDb().transaction((tx) => {
        ExpireInvitesInTx(tx, [Caller], Now);

        const Pending = PendingInvitesOf(tx, Caller, Now);
        const CallerHasSlot = FreeSlots(tx, Caller, Now).some((Slot) => !Pending.some((Row) => Row.senderId === Caller && Row.senderSlot === Slot));

        return Ids.map((Id) => ({
            account_id: Id,
            available: CallerHasSlot
                && Id !== Caller
                && IsAccountIdShape(Id)
                && AccountExists(tx, Id)
                && AreFriendsInTx(tx, Caller, Id)
                && !IsBlockedEitherWayInTx(tx, Caller, Id)
                && !LinkedWith(tx, Caller, Id, Now)
                && !Pending.some((Row) => OtherOf(Row, Caller) === Id)
                && FreeSlots(tx, Id, Now).length > 0
        }));
    });

    logger.debug(`slayerlink: availability for ${Caller}: ${Availability.filter((Entry) => Entry.available).length} of ${Availability.length}`);

    return Ok({ availability: Availability });
}

// ---- Prize pool, rewards and removal (sent by the game server) ----

// Who may act on a link: the game server, or one of its two players
function MayTouch(Caller: { IsGameserver: boolean, UserId?: string }, Link: LinkRow){
    return Caller.IsGameserver || (Caller.UserId !== undefined && SideOf(Link, Caller.UserId) !== undefined);
}

export type LinkCaller = { IsGameserver: boolean, UserId?: string };

// PUT /slayerlink/links/rewards {links: [{account_id, slot, prize_pool}]}
export function SetSlayerLinkPrizePool1147(Caller: LinkCaller, Body: any): SlayerLinkReply {
    const Entries = Array.isArray(Body?.links) ? Body.links.slice(0, LINK_SLOTS * 2) : [];

    if(Entries.length === 0){
        logger.info(`slayerlink: prize pool refused 400: no links`);
        return Fail(400, "no links");
    }

    const Now = Clock();
    const Notes = GetDb().transaction((tx) => Entries.map((Entry: any) => {
        const Account = Entry?.account_id;
        const Slot = SlotOf(Entry?.slot);
        const Pool = ParsePool(Entry?.prize_pool);

        if(!IsAccountIdShape(Account) || Slot === undefined || Pool === undefined){
            return `${Shown(Account)} slot ${Entry?.slot}: bad entry`;
        }

        const Found = FindLinkBySlot(tx, Account, Slot, Now);

        if(Found === undefined || !MayTouch(Caller, Found.Each.Link)){
            return `${Account} slot ${Slot}: no such link`;
        }

        if(Found.Each.State.prizePool != null){
            return `${Account} slot ${Slot}: link ${Found.Each.Link.linkId} already has its pool (${Found.Each.State.poolSource}), kept`;
        }

        SaveState(tx, { ...Found.Each.State, prizePool: JSON.stringify(Pool), poolSource: Caller.IsGameserver ? "gameserver" : "player" });

        return `${Account} slot ${Slot}: link ${Found.Each.Link.linkId} pool of ${Pool.length} (${Pool.filter((Prize) => Prize.received_for_level >= 1).length} to win) stored`;
    }));

    logger.info(`slayerlink: prize pool from ${Caller.IsGameserver ? "the game server" : Caller.UserId}: ${Notes.join("; ")}`);

    return Ok({});
}

// GET /slayerlink/links/rewards/{account_id}/{slot}: the prizes the player won, handed out once
export function GrantSlayerLinkRewards1147(Caller: LinkCaller, AccountId: unknown, SlotRaw: unknown): SlayerLinkReply {
    const Slot = SlotOf(SlotRaw);

    if(!IsAccountIdShape(AccountId) || Slot === undefined){
        logger.info(`slayerlink: rewards for ${Shown(AccountId)} slot ${String(SlotRaw).slice(0, 8)} refused 400`);
        return Fail(400, "no account or slot");
    }

    const Now = Clock();
    const Result = GetDb().transaction((tx): SlayerLinkReply | { Player: string, Rewards: Prize[], Again: boolean, Link: LinkRow } => {
        const Found = FindLinkBySlot(tx, AccountId, Slot, Now);

        if(Found === undefined || !MayTouch(Caller, Found.Each.Link)){
            return Fail(404, "no such link");
        }

        if(!Caller.IsGameserver && Caller.UserId !== Found.Player){
            return Fail(403, "only the player's own rewards");
        }

        const { Each, Player } = Found;
        const S = SideOf(Each.Link, Player)!;

        if(IsRunning(Each.Link, Now)){
            return Fail(409, "the link is still running");
        }

        const Claimed = ClaimedAt(Each.State, S);

        if(Claimed != null){
            return { Player, Rewards: [], Again: true, Link: Each.Link };
        }

        EnsurePoolInTx(tx, { Link: Each.Link, State: Each.State }, Now + POOL_WAIT_MS);

        const Fresh = StateOf(tx, Each.Link.linkId);
        const Rewards = WonBy(tx, { Link: Each.Link, State: Fresh }, Player);

        SaveState(tx, S === "sender"
            ? { ...Fresh, senderClaimedAt: Now, senderRewards: JSON.stringify(Rewards) }
            : { ...Fresh, targetClaimedAt: Now, targetRewards: JSON.stringify(Rewards) });

        return { Player, Rewards, Again: false, Link: Each.Link };
    });

    if(!("Player" in Result)){
        logger.info(`slayerlink: rewards for ${AccountId} slot ${Slot} refused ${Result.Status}: ${(Result.Body as any).message}`);
        return Result;
    }

    logger.info(`slayerlink: rewards of link ${Result.Link.linkId} for ${Result.Player} (asked as ${AccountId} slot ${Slot}) -> ${Result.Again ? "already handed out, none" : Result.Rewards.length === 0 ? "none won" : Result.Rewards.map((Prize) => `${Prize.catalog_id} x${Prize.quantity} (level ${Prize.received_for_level})`).join(", ")}`);

    if(!Result.Again){
        Notify(Result.Player, "rewards", { slot: SlotFor(Result.Link, Result.Player), rewards: Result.Rewards });
    }

    return Ok({ is_service_granting: false, rewards: Result.Rewards });
}

// DELETE /slayerlink/links {links: [{account_id, slot, delete_pair}]} (1.14.7), or one entry flat
export function DeleteSlayerLinks1147(Caller: LinkCaller, Body: any, Query: any): SlayerLinkReply {
    const Entries: any[] = Array.isArray(Body?.links) ? Body.links.slice(0, LINK_SLOTS * 2)
        : [{ account_id: Body?.account_id ?? Query?.account_id, slot: Body?.slot ?? Query?.slot, delete_pair: Body?.delete_pair ?? Query?.delete_pair }];
    const Now = Clock();
    let Refusal: SlayerLinkReply | undefined;
    const Told: [string, string][] = [];

    const Notes = GetDb().transaction((tx) => Entries.map((Entry) => {
        const Account = Entry?.account_id;
        const Slot = SlotOf(Entry?.slot);
        const Pair = Entry?.delete_pair === true || Entry?.delete_pair === "true";
        let Found: { Each: Linked, Player: string } | undefined;

        if(!Caller.IsGameserver && Caller.UserId !== undefined){
            // A player removes their own link: in that slot, or with that player
            const Mine = LinksOf(tx, Caller.UserId, Now).filter((Each) => RemovedAt(Each.State, SideOf(Each.Link, Caller.UserId!)!) == null);
            const Each = Mine.find((One) => (Slot === undefined || SlotFor(One.Link, Caller.UserId!) === Slot) && (!IsAccountIdShape(Account) || Account === Caller.UserId || OtherOf(One.Link, Caller.UserId!) === Account));
            Found = Each !== undefined ? { Each, Player: Caller.UserId } : undefined;
        }
        else if(IsAccountIdShape(Account) && Slot !== undefined){
            Found = FindLinkBySlot(tx, Account, Slot, Now);
        }

        if(Found === undefined){
            return `${Shown(Account)} slot ${Entry?.slot ?? "-"}: nothing to remove`;
        }

        const { Each, Player } = Found;
        const Partner = OtherOf(Each.Link, Player);
        const S = SideOf(Each.Link, Player)!;

        if(IsRunning(Each.Link, Now)){
            if(TrackProgress(tx, Player, SlotFor(Each.Link, Player)) > 0 || TrackProgress(tx, Partner, SlotFor(Each.Link, Partner)) > 0){
                Refusal = Fail(409, "the link is charged and cannot be cancelled");
                return `link ${Each.Link.linkId}: charged, kept`;
            }

            SaveState(tx, { ...Each.State, senderRemovedAt: Each.State.senderRemovedAt ?? Now, targetRemovedAt: Each.State.targetRemovedAt ?? Now, prizePool: Each.State.prizePool });
            tx.update(slayerlinks).set({ endsAt: Math.min(Each.Link.endsAt, Now) }).where(eq(slayerlinks.linkId, Each.Link.linkId)).run();
            Told.push([Partner, Each.Link.linkId]);
            return `link ${Each.Link.linkId} of ${Player} and ${Partner}: cancelled for both (delete_pair=${Pair})`;
        }

        SaveState(tx, S === "sender" ? { ...Each.State, senderRemovedAt: Now } : { ...Each.State, targetRemovedAt: Now });
        return `link ${Each.Link.linkId}: removed from the slots of ${Player} (finished; delete_pair=${Pair})`;
    }));

    logger.info(`slayerlink: delete links by ${Caller.IsGameserver ? "the game server" : Caller.UserId}: ${Notes.join("; ")}`);

    for(const [Partner, LinkId] of Told){
        Notify(Partner, "link_cancelled", { link_id: LinkId });
    }

    if(Refusal !== undefined && Entries.length === 1){
        return Refusal;
    }

    return Ok({});
}

// ---- Tests and operators: shorten a link (the client's own end-time commands are empty in Shipping) ----

export function SetSlayerLinkEndForAccount(AccountId: string, Slot: number, EndsAt: number){
    return GetDb().transaction((tx) => {
        const Found = FindLinkBySlot(tx, AccountId, Slot, Clock());

        if(Found === undefined){
            return undefined;
        }

        tx.update(slayerlinks).set({ endsAt: EndsAt }).where(eq(slayerlinks.linkId, Found.Each.Link.linkId)).run();
        return Found.Each.Link.linkId;
    });
}
