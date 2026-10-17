import crypto from "node:crypto";
import { Router } from "express";
import { and, eq, isNull, lt } from "drizzle-orm";
import { GetDb } from "../db";
import { characters, inventory, storepurchases } from "../db/schema";
import { logger } from "../logger";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { PlayerTokenOnly } from "../middleware/PlayerAuth";
import { PlayerMutationRateLimit } from "../middleware/RateLimits";
import { GetActiveCharacter } from "../controllers/activecharacter";
import { ApplyInventoryTransactionInTx, InventoryErrorOf } from "../controllers/inventory";
import { Tx } from "../controllers/savehistory";
import { StoreImages } from "../controllers/storeimages";
import { ParseOnOff } from "../features";
import darkHarvest from "../vendor/store_darkharvest_1147.json";

// The Dark Harvest (Halloween) event store of the Dauntless 1.14.7 client (TARGET_GAME_VERSION=1.14.7).
// Evidence: PORT-1.14.7/19-lore-objects-event-vendor.md.
//
// The store screen is UEventStoreScreen (/Game/UI/Events/event_store_screen, EUIMajorScreen::EventStore; the same
// class is the rumour store, EUIMajorScreen::RumourStore, when its data carries "rumour_store"). Its view model
// /Game/UI/Events/event_store_view_model asks for the tag "seasonal_event". The event's currency is the
// seasonal_event_ui_table row DarkHarvest: CURRENCY_EVENT_DARKHARVEST, which /balance already reports from the
// inventory as id_currency_event_darkharvest (BALANCE_FROM_INVENTORY). The client keeps the raw currency code for
// a currency it does not know (SetStoreCurrency 0x220E020), so the offers say id_currency_event_darkharvest and the
// purchase path is /token/id_currency_event_darkharvest/<sku>.
//
// The Unseen in Ramsgate's city_01_event_dark_harvest level (npc_unseen_bp_2, a vendor_interactive_bp) has no
// store menu of its own (its NPCInteractionWidgets name no tag; the level instance opens EUIMajorScreen::Quests),
// so this router answers the two tags the event screens can ask for:
// - GET /product/skus/public?requiredTags=seasonal_event (every enabled offer) or =rumour_store (the rumour group);
// - GET /product/sku/darkharvest_<id>, GET /token/<currency>/darkharvest_<id> (storepurchases row, 10 minutes;
//   409 when owned, sold out of rumours or short of currency), POST /notification/<currency>?token= (the currency
//   is taken and the items granted in one inventory transaction, caller "store", source "store:<sku>"; a retried
//   redeem answers 204 and grants nothing).
// Offers with a "drop" (the BUNDLE_* rows of bundles_events_catalog) roll their DT_control_events_rewards table at
// redeem time, one weighted result, seeded by the purchase token; ignoreOwned skips results the character holds.
//
// Switches (read per request): DARK_HARVEST_STORE=0 turns the router off (the store stub then answers []);
// DARK_HARVEST_STORE_GROUPS=event,rumour,witch (default: all three) picks the offer groups;
// DARK_HARVEST_RUMOURS=item (default: the rumour offers grant the Unseen item) or token (they grant the rumour
// quest token, TOKEN_RUMOUR_*, for the Unseen's quests); DARK_HARVEST_STORE_FREE=1 prices everything at 0.

const IsGame1147 = () => process.env.TARGET_GAME_VERSION === "1.14.7";
const StoreOn = () => ParseOnOff(process.env.DARK_HARVEST_STORE ?? "1") ?? true;
const StoreFree = () => ParseOnOff(process.env.DARK_HARVEST_STORE_FREE ?? "0") ?? false;
const RumourTokens = () => (process.env.DARK_HARVEST_RUMOURS ?? "item").trim().toLowerCase() === "token";
const Groups = () => new Set((process.env.DARK_HARVEST_STORE_GROUPS ?? "event,rumour,witch").split(",").map((G) => G.trim().toLowerCase()).filter(Boolean));

export const EVENT_STORE_TAG = "seasonal_event";
export const RUMOUR_STORE_TAG = "rumour_store";
export const DARK_HARVEST_CURRENCY_ID = "id_currency_event_darkharvest";
export const DARK_HARVEST_CATALOG_ID = "CURRENCY_EVENT_DARKHARVEST";
const SKU_PREFIX = "darkharvest_";
const TOKEN_MINUTES = 10;

// Path segments the client may put in /token/<currency> and /notification/<currency> (compared in lower case)
const CURRENCY_SEGMENTS = new Set([DARK_HARVEST_CURRENCY_ID, "currency_event_darkharvest", "event_darkharvest", "darkharvest", "all"]);

type Grant = { catalogId: string, quantity: number, kind: "stacked" | "instanced" };
type DropResult = Grant & { weight: number };
type EventOffer = {
    id: string, group: string, displayName: string, displayDescription: string, displayPriority: number, tags: string[],
    price: number, repeatable: boolean, items: Grant[], token?: Grant, ownedIf?: string[],
    drop?: { table: string, ignoreOwned: boolean, results: DropResult[] }
};
const Offers = (darkHarvest as unknown as { offers: EventOffer[] }).offers;
const OffersById = new Map(Offers.map((Offer) => [Offer.id, Offer]));

class EventStoreError extends Error {
    constructor(public Status: number, message: string){
        super(message);
    }
}

const Hash = (Value: string) => crypto.createHash("sha256").update(Value).digest("hex");
const PriceOf = (Offer: EventOffer) => StoreFree() ? 0 : Offer.price;
const Enabled = (Offer: EventOffer) => Groups().has(Offer.group);
// What a non-drop offer grants as sold now (the rumour switch changes it)
const GrantsOf = (Offer: EventOffer): Grant[] => Offer.group === "rumour" && RumourTokens() && Offer.token ? [Offer.token] : Offer.items;
// The token is bound to the offer as sold when it was issued (a price or rumour-mode change needs a new token)
const OfferHash = (Offer: EventOffer) => Hash(JSON.stringify({ ...Offer, price: PriceOf(Offer), grants: GrantsOf(Offer) }));

// The items' icons (controllers/storeimages.ts): the first granted item or drop result that has one; a rumour
// token shows the item it unlocks
const ImagesFor = (req: any, Offer: EventOffer) =>
    StoreImages(req, [...Offer.items, ...(Offer.drop?.results ?? [])].map((Item) => Item.catalogId.replace(/^TOKEN_RUMOUR_/i, "")));

function Stacks(tx: Tx, CharacterId: string){
    const Row = tx.select().from(inventory).where(eq(inventory.characterId, CharacterId)).get();
    return {
        Stacked: JSON.parse(Row?.stackedItems ?? "[]") as any[],
        Instanced: JSON.parse(Row?.instancedItems ?? "[]") as any[]
    };
}

function Held(tx: Tx, CharacterId: string | undefined){
    const Ids = new Set<string>();
    if(CharacterId == undefined) return Ids;
    const { Stacked, Instanced } = Stacks(tx, CharacterId);
    for(const Stack of Stacked) if(typeof Stack?.catalogId === "string" && Number(Stack.quantity) > 0) Ids.add(Stack.catalogId);
    for(const Item of Instanced) if(typeof Item?.catalogId === "string") Ids.add(Item.catalogId);
    return Ids;
}

function CurrencyBalance(tx: Tx, CharacterId: string){
    const Stack = Stacks(tx, CharacterId).Stacked.find((Item) => Item?.catalogId === DARK_HARVEST_CATALOG_ID);
    const Quantity = Number(Stack?.quantity ?? 0);
    return Number.isSafeInteger(Quantity) ? Quantity : 0;
}

// A drop result is "owned" when the character holds it, or (rumour tokens) the item its quest unlocks
const RumourRewardOf = new Map(Offers.filter((Offer) => Offer.token).map((Offer) => [Offer.token!.catalogId, Offer.items[0].catalogId]));
const HoldsResult = (HeldIds: Set<string>, Id: string) => HeldIds.has(Id) || (RumourRewardOf.has(Id) && HeldIds.has(RumourRewardOf.get(Id)!));
const Candidates = (Offer: EventOffer, HeldIds: Set<string>) =>
    (Offer.drop?.results ?? []).filter((Result) => !Offer.drop!.ignoreOwned || !HoldsResult(HeldIds, Result.catalogId));

function Owned(HeldIds: Set<string>, Offer: EventOffer){
    if(Offer.drop) return Candidates(Offer, HeldIds).length === 0;
    if(Offer.repeatable) return false;
    if(Offer.ownedIf) return Offer.ownedIf.some((Id) => HeldIds.has(Id));
    return Offer.items.every((Item) => HeldIds.has(Item.catalogId));
}

// One weighted pick, seeded by the purchase so a given token always rolls the same result
function Roll(Offer: EventOffer, HeldIds: Set<string>, Seed: string): Grant | undefined {
    const Pool = Candidates(Offer, HeldIds);
    const Total = Pool.reduce((Sum, Result) => Sum + Math.max(0, Result.weight), 0);
    if(Pool.length === 0 || Total <= 0) return undefined;
    let Pick = parseInt(Hash(`${Seed}:${Offer.id}`).slice(0, 12), 16) % Total;
    for(const Result of Pool){
        Pick -= Math.max(0, Result.weight);
        if(Pick < 0) return { catalogId: Result.catalogId, quantity: Result.quantity, kind: Result.kind };
    }
    return undefined;
}

export function DarkHarvestOffer1147(req: any, Offer: EventOffer, HeldIds: Set<string>){
    return {
        id: Offer.id,
        displayName: Offer.displayName,
        displayDescription: Offer.displayDescription,
        displayPriority: Offer.displayPriority,
        maxAllowed: Offer.repeatable ? 0 : 1,
        remaining: Owned(HeldIds, Offer) ? 0 : 1,
        prices: [{ currencyId: DARK_HARVEST_CURRENCY_ID, price: PriceOf(Offer), salesPrice: 0 }],
        items: Offer.drop ? [] : GrantsOf(Offer).map((Item) => ({ catalogId: Item.catalogId, quantity: Item.quantity })),
        entitlements: [],
        skuProgression: null,
        loadoutSlots: 0,
        tags: Offer.tags,
        availableFrom: null,
        availableTo: null,
        timeAvailabilityReason: "",
        platformOfferId: "",
        images: ImagesFor(req, Offer),
        missingEntitlementNames: []
    };
}

function HeldNow(AccountId: string){
    return GetDb().transaction((tx) => Held(tx, GetActiveCharacter(tx, AccountId)?.characterId));
}

function ListFor(Tags: string[]){
    const WantRumours = Tags.includes(RUMOUR_STORE_TAG);
    const WantEvent = Tags.includes(EVENT_STORE_TAG);
    return Offers.filter((Offer) => Enabled(Offer) && (WantEvent || (WantRumours && Offer.tags.includes(RUMOUR_STORE_TAG))));
}

export function CreateDarkHarvestPurchase(AccountId: string, Currency: string, SkuId: string){
    if(!CURRENCY_SEGMENTS.has(Currency.toLowerCase())){
        throw new EventStoreError(400, "Offer is not sold in that currency");
    }
    const Offer = OffersById.get(SkuId);
    if(Offer == undefined || !Enabled(Offer)){
        throw new EventStoreError(404, "Unknown store offer");
    }

    const Token = crypto.randomBytes(32).toString("hex");
    const CharacterId = GetDb().transaction((tx) => {
        const Now = new Date();
        tx.delete(storepurchases).where(and(eq(storepurchases.accountId, AccountId), isNull(storepurchases.redeemedDate), lt(storepurchases.expiresDate, Now.toISOString()))).run();

        const Character = GetActiveCharacter(tx, AccountId);
        if(Character == undefined){
            throw new EventStoreError(409, "The account has no character to deliver the purchase to");
        }
        if(Owned(Held(tx, Character.characterId), Offer)){
            throw new EventStoreError(409, Offer.drop ? "You already own everything this offer can grant" : "You already own everything this offer grants");
        }
        if(CurrencyBalance(tx, Character.characterId) < PriceOf(Offer)){
            throw new EventStoreError(409, "Not enough Dark Harvest currency");
        }

        tx.insert(storepurchases).values({
            tokenHash: Hash(Token),
            accountId: AccountId,
            characterId: Character.characterId,
            skuId: SkuId,
            offerHash: OfferHash(Offer),
            createdDate: Now.toISOString(),
            expiresDate: new Date(Now.getTime() + TOKEN_MINUTES * 60 * 1000).toISOString(),
            redeemedDate: null
        }).run();
        return Character.characterId;
    });

    logger.info(`Dark Harvest purchase token for ${SkuId} issued to ${AccountId} (character ${CharacterId})`);
    return { purchaseToken: Token };
}

export function RedeemDarkHarvestPurchase(AccountId: string, Currency: string, Token: string){
    if(!CURRENCY_SEGMENTS.has(Currency.toLowerCase())){
        throw new EventStoreError(400, "Invalid purchase token or currency");
    }

    const TokenHash = Hash(Token);
    const Result = GetDb().transaction((tx) => {
        const Purchase = tx.select().from(storepurchases).where(eq(storepurchases.tokenHash, TokenHash)).get();

        if(Purchase == undefined || Purchase.accountId !== AccountId){
            throw new EventStoreError(403, "Invalid purchase token");
        }
        if(Purchase.redeemedDate != null){
            return { Replayed: true, SkuId: Purchase.skuId, CharacterId: Purchase.characterId, Granted: [] as string[], Price: 0 };
        }
        if(Purchase.expiresDate < new Date().toISOString()){
            throw new EventStoreError(410, "Purchase token expired");
        }
        const Character = tx.select({ userId: characters.userId }).from(characters).where(eq(characters.characterId, Purchase.characterId)).get();
        if(Character == undefined || Character.userId !== AccountId){
            throw new EventStoreError(403, "The purchase's character is no longer the account's");
        }
        const Offer = OffersById.get(Purchase.skuId);
        if(Offer == undefined || !Enabled(Offer) || OfferHash(Offer) !== Purchase.offerHash){
            throw new EventStoreError(409, "Offer changed; request a new token");
        }

        const Price = PriceOf(Offer);
        if(CurrencyBalance(tx, Purchase.characterId) < Price){
            throw new EventStoreError(409, "Not enough Dark Harvest currency");
        }

        const HeldIds = Held(tx, Purchase.characterId);
        let ToGrant: Grant[];
        if(Offer.drop){
            const Rolled = Roll(Offer, HeldIds, TokenHash);
            if(Rolled == undefined){
                throw new EventStoreError(409, "You already own everything this offer can grant");
            }
            ToGrant = [Rolled];
        }
        else{
            // Unlocks are not granted twice; consumables (repeatable offers) always are
            ToGrant = GrantsOf(Offer).filter((Item) => Offer.repeatable || !HeldIds.has(Item.catalogId));
        }

        const Stacked = ToGrant.filter((Item) => Item.kind === "stacked").map((Item) => ({ catalogId: Item.catalogId, quantity: Item.quantity }));
        // Instanced ids derived from the token: a retried transaction names the same instance
        const Instanced = ToGrant.filter((Item) => Item.kind === "instanced")
            .map((Item) => ({ catalogId: Item.catalogId, instanceId: Hash(`${TokenHash}:${Item.catalogId}`).slice(0, 32), updateVersion: 0 }));

        if(Stacked.length > 0 || Instanced.length > 0 || Price > 0){
            try{
                ApplyInventoryTransactionInTx(tx, {
                    UserId: AccountId,
                    CharacterId: Purchase.characterId,
                    TransactionId: `store:${TokenHash}`,
                    InstancedItemsToAdd: Instanced,
                    StackedItemsToAdd: Stacked,
                    StackedItemsToRemove: Price > 0 ? [{ catalogId: DARK_HARVEST_CATALOG_ID, quantity: Price }] : undefined
                }, { Caller: "store", Source: `store:${Purchase.skuId}` });
            }
            catch(error){
                if(InventoryErrorOf(error) !== undefined){
                    throw new EventStoreError(409, "The inventory could not complete this purchase");
                }
                throw error;
            }
        }

        tx.update(storepurchases).set({ redeemedDate: new Date().toISOString() }).where(eq(storepurchases.tokenHash, TokenHash)).run();
        return { Replayed: false, SkuId: Purchase.skuId, CharacterId: Purchase.characterId, Granted: ToGrant.map((Item) => `${Item.catalogId} x${Item.quantity}`), Price };
    }, { behavior: "immediate" });

    logger.info(Result.Replayed
        ? `Dark Harvest purchase ${Result.SkuId} of ${AccountId} was already redeemed; nothing granted again`
        : `Dark Harvest purchase ${Result.SkuId} for ${AccountId} (character ${Result.CharacterId}): ${Result.Granted.join(", ") || "nothing new"} for ${Result.Price} ${DARK_HARVEST_CATALOG_ID}`);
    return Result;
}

function SendError(res: any, error: unknown, What: string){
    if(error instanceof EventStoreError){
        logger.warn(`Dark Harvest store ${What} refused (${error.Status}): ${error.message}`);
        res.status(error.Status);
        res.json({ code: String(error.Status), message: error.message });
        return;
    }
    logger.error(error, `Dark Harvest store ${What} failed`);
    res.status(500);
    res.json({ code: "500", message: "Store request failed" });
}

function Only1147(_req: any, _res: any, next: any){
    next(IsGame1147() && StoreOn() ? undefined : "router");
}

const RequestedTags = (Value: unknown) => typeof Value === "string" ? Value.split(",").map((Tag) => Tag.trim()) : [];
const IsOurList = (Value: unknown) => RequestedTags(Value).some((Tag) => Tag === EVENT_STORE_TAG || Tag === RUMOUR_STORE_TAG);
const IsOurSku = (SkuId: unknown) => typeof SkuId === "string" && SkuId.startsWith(SKU_PREFIX) && OffersById.has(SkuId);

// The redeem request carries only the token: it is ours when its storepurchases row is a Dark Harvest sku
function IsOurToken(Token: unknown){
    if(typeof Token !== "string" || !/^[a-f0-9]{64}$/.test(Token)) return false;
    const Row = GetDb().select({ skuId: storepurchases.skuId }).from(storepurchases).where(eq(storepurchases.tokenHash, Hash(Token))).get();
    return Row != undefined && IsOurSku(Row.skuId);
}

export const darkHarvest1147Router = Router();

darkHarvest1147Router.use(Only1147);

darkHarvest1147Router.get("/product/skus/public", (req: any, _res, next) => {
    next(IsOurList(req.query.requiredTags) ? undefined : "route");
}, HasUndauntedMetagameAuth, PlayerTokenOnly, (req: any, res) => {
    try{
        const HeldIds = HeldNow(req.AuthData.userId);
        const Listed = ListFor(RequestedTags(req.query.requiredTags)).map((Offer) => DarkHarvestOffer1147(req, Offer, HeldIds));
        logger.info(`Store SKUs for tag ${req.query.requiredTags}: ${Listed.length} Dark Harvest offer(s)`);
        res.status(200);
        res.json(Listed);
    }
    catch(error){
        SendError(res, error, "list");
    }
});

darkHarvest1147Router.get("/product/sku/:skuId", (req: any, _res, next) => {
    next(IsOurSku(req.params.skuId) ? undefined : "route");
}, HasUndauntedMetagameAuth, PlayerTokenOnly, (req: any, res) => {
    try{
        const Offer = OffersById.get(req.params.skuId)!;
        if(!Enabled(Offer)) throw new EventStoreError(404, "Unknown store offer");
        res.status(200);
        res.json(DarkHarvestOffer1147(req, Offer, HeldNow(req.AuthData.userId)));
    }
    catch(error){
        SendError(res, error, `offer ${req.params.skuId}`);
    }
});

darkHarvest1147Router.get("/token/:currency/:skuId", (req: any, _res, next) => {
    next(IsOurSku(req.params.skuId) ? undefined : "route");
}, HasUndauntedMetagameAuth, PlayerTokenOnly, PlayerMutationRateLimit, (req: any, res) => {
    try{
        res.status(200);
        res.json(CreateDarkHarvestPurchase(req.AuthData.userId, req.params.currency, req.params.skuId));
    }
    catch(error){
        SendError(res, error, `token for ${req.params.skuId}`);
    }
});

darkHarvest1147Router.post("/notification/:currency", (req: any, _res, next) => {
    next(IsOurToken(req.query.token) ? undefined : "route");
}, HasUndauntedMetagameAuth, PlayerTokenOnly, PlayerMutationRateLimit, (req: any, res) => {
    try{
        RedeemDarkHarvestPurchase(req.AuthData.userId, req.params.currency, req.query.token);
        res.status(204);
        res.send();
    }
    catch(error){
        SendError(res, error, "purchase");
    }
});
