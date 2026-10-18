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
import { GrantKind } from "../controllers/freestore";
import { ApplyInventoryTransactionInTx, InventoryErrorOf } from "../controllers/inventory";
import { Tx } from "../controllers/savehistory";
import { StoreImages } from "../controllers/storeimages";
import { ParseOnOff } from "../features";
import rewardCache from "../vendor/store_rewardcache_1147.json";

// The Reward Cache of the Dauntless 1.14.7 client (TARGET_GAME_VERSION=1.14.7). Evidence:
// PORT-1.14.7/12-stores-vendors.md.
//
// The 1.14.7 Reward Cache is USeasonalStoreScreen (opened from the Journal). Its view model
// (/Game/UI/PlayerMenus/HuntingPass/Store/seasonal_store_view_model) asks the store for the tag
// "season_store" and splits the offers into tabs by their tags (season_store_feature, season_store_event,
// tab_season_armour, tab_season_weapon, tab_season_style, tab_season_limited, prestige_store,
// season_store_general). Prices are in Cache Coins: CURRENCY_SEASONAL_COIN in the inventory, which /balance
// already reports as id_currency_seasonal_coin. 1.14.7 keeps any priced currencyId as the raw currency code,
// so the offer says id_currency_seasonal_coin and the purchase path is /token/id_currency_seasonal_coin/<sku>.
//
// controllers/freestore.ts sells only its fixed flat-price currencies (platinum, celldust, marks, prestige),
// so this router answers the Reward Cache itself, whatever STORE is set to:
// - GET /product/skus/public?requiredTags=season_store: vendor/store_rewardcache_1147.json in the 1.14.7
//   offer shape (prices[]), remaining 0 once the active character holds every item;
// - GET /product/sku/rewardcache_<id>: one offer;
// - GET /token/<currency>/rewardcache_<id>: a purchase token (storepurchases row, 10 minutes), refused when
//   owned or when the active character has fewer Cache Coins than the price;
// - POST /notification/<currency>?token=: takes the coins and grants the items in one inventory transaction
//   (caller "store", source "store:<sku>"); a retried redeem answers 204 and grants nothing.
// Lady Luck (ladyluckstore) and the Research Lab (weekly_cell_offering, exchange_vendor_slot_2/3) are left to
// routes/store.ts: their 1.14.7 tags are the 1.4.4 ones and ToOffer1147 already turns their prices into prices[].
// REWARD_CACHE_STORE=0 turns this router off (the stub then answers the tag with []); REWARD_CACHE_FREE=1 sells
// every Reward Cache offer for 0 coins.

const IsGame1147 = () => process.env.TARGET_GAME_VERSION === "1.14.7";
const RewardCacheOn = () => ParseOnOff(process.env.REWARD_CACHE_STORE ?? "1") ?? true;
const RewardCacheFree = () => ParseOnOff(process.env.REWARD_CACHE_FREE ?? "0") ?? false;

export const REWARD_CACHE_TAG = "season_store";
export const CACHE_COIN_CURRENCY_ID = "id_currency_seasonal_coin";
export const CACHE_COIN_CATALOG_ID = "CURRENCY_SEASONAL_COIN";
const SKU_PREFIX = "rewardcache_";
const TOKEN_MINUTES = 10;

// Path segments the client may put in /token/<currency> and /notification/<currency> for this offer: the raw
// currency code (the expected one), its inventory names, and "all" (pay with every listed currency).
const CURRENCY_SEGMENTS = new Set([CACHE_COIN_CURRENCY_ID, "currency_seasonal_coin", "seasonal_coin", "all"]);

type CacheOffer = { id: string, displayName: string, displayDescription: string, displayPriority: number, tags: string[], price: number, items: { catalogId: string, quantity: number }[] };
const Offers = (rewardCache as unknown as { offers: CacheOffer[] }).offers;
const OffersById = new Map(Offers.map((Offer) => [Offer.id, Offer]));

class RewardCacheError extends Error {
    constructor(public Status: number, message: string){
        super(message);
    }
}

const Hash = (Value: string) => crypto.createHash("sha256").update(Value).digest("hex");
const PriceOf = (Offer: CacheOffer) => RewardCacheFree() ? 0 : Offer.price;
// The token is bound to the offer as sold when it was issued (a price change in between needs a new token)
const OfferHash = (Offer: CacheOffer) => Hash(JSON.stringify({ ...Offer, price: PriceOf(Offer) }));

// The items' icons (controllers/storeimages.ts): the first item that has one
const ImagesFor = (req: any, Offer: CacheOffer) => StoreImages(req, Offer.items.map((Item) => Item.catalogId));

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

function CoinBalance(tx: Tx, CharacterId: string){
    const Stack = Stacks(tx, CharacterId).Stacked.find((Item) => Item?.catalogId === CACHE_COIN_CATALOG_ID);
    const Quantity = Number(Stack?.quantity ?? 0);
    return Number.isSafeInteger(Quantity) ? Quantity : 0;
}

const Owned = (HeldIds: Set<string>, Offer: CacheOffer) => Offer.items.every((Item) => HeldIds.has(Item.catalogId));

export function RewardCacheOffer1147(req: any, Offer: CacheOffer, HeldIds: Set<string>){
    return {
        id: Offer.id,
        displayName: Offer.displayName,
        displayDescription: Offer.displayDescription,
        displayPriority: Offer.displayPriority,
        maxAllowed: 1,
        remaining: Owned(HeldIds, Offer) ? 0 : 1,
        prices: [{ currencyId: CACHE_COIN_CURRENCY_ID, price: PriceOf(Offer), salesPrice: 0 }],
        items: Offer.items,
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

function CheckGrantable(Offer: CacheOffer){
    if(Offer.items.length === 0 || Offer.items.some((Item) => GrantKind(Item.catalogId) === undefined || Item.quantity !== 1)){
        throw new RewardCacheError(409, "Offer is not a supported Reward Cache item");
    }
}

export function CreateRewardCachePurchase(AccountId: string, Currency: string, SkuId: string){
    if(!CURRENCY_SEGMENTS.has(Currency.toLowerCase())){
        throw new RewardCacheError(400, "Offer is not sold in that currency");
    }

    const Offer = OffersById.get(SkuId);
    if(Offer == undefined){
        throw new RewardCacheError(404, "Unknown store offer");
    }
    CheckGrantable(Offer);

    const Token = crypto.randomBytes(32).toString("hex");
    const CharacterId = GetDb().transaction((tx) => {
        const Now = new Date();
        tx.delete(storepurchases).where(and(eq(storepurchases.accountId, AccountId), isNull(storepurchases.redeemedDate), lt(storepurchases.expiresDate, Now.toISOString()))).run();

        const Character = GetActiveCharacter(tx, AccountId);
        if(Character == undefined){
            throw new RewardCacheError(409, "The account has no character to deliver the purchase to");
        }
        if(Owned(Held(tx, Character.characterId), Offer)){
            throw new RewardCacheError(409, "You already own everything this offer grants");
        }
        if(CoinBalance(tx, Character.characterId) < PriceOf(Offer)){
            throw new RewardCacheError(409, "Not enough Cache Coins");
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

    logger.info(`Reward Cache purchase token for ${SkuId} issued to ${AccountId} (character ${CharacterId})`);
    return { purchaseToken: Token };
}

export function RedeemRewardCachePurchase(AccountId: string, Currency: string, Token: string){
    if(!CURRENCY_SEGMENTS.has(Currency.toLowerCase())){
        throw new RewardCacheError(400, "Invalid purchase token or currency");
    }

    const TokenHash = Hash(Token);
    const Result = GetDb().transaction((tx) => {
        const Purchase = tx.select().from(storepurchases).where(eq(storepurchases.tokenHash, TokenHash)).get();

        if(Purchase == undefined || Purchase.accountId !== AccountId){
            throw new RewardCacheError(403, "Invalid purchase token");
        }
        if(Purchase.redeemedDate != null){
            return { Replayed: true, SkuId: Purchase.skuId, CharacterId: Purchase.characterId, Items: 0, Price: 0 };
        }
        if(Purchase.expiresDate < new Date().toISOString()){
            throw new RewardCacheError(410, "Purchase token expired");
        }

        const Character = tx.select({ userId: characters.userId }).from(characters).where(eq(characters.characterId, Purchase.characterId)).get();
        if(Character == undefined || Character.userId !== AccountId){
            throw new RewardCacheError(403, "The purchase's character is no longer the account's");
        }

        const Offer = OffersById.get(Purchase.skuId);
        if(Offer == undefined || OfferHash(Offer) !== Purchase.offerHash){
            throw new RewardCacheError(409, "Offer changed; request a new token");
        }
        CheckGrantable(Offer);

        const Price = PriceOf(Offer);
        if(CoinBalance(tx, Purchase.characterId) < Price){
            throw new RewardCacheError(409, "Not enough Cache Coins");
        }

        // Unlocks: an item the character already holds is not granted twice (overlapping bundles)
        const HeldIds = Held(tx, Purchase.characterId);
        const ToGrant = Offer.items.filter((Item) => !HeldIds.has(Item.catalogId));
        // Everything was obtained since the token was issued: charge nothing for nothing
        if(ToGrant.length === 0 && Offer.items.length > 0){
            throw new RewardCacheError(409, "You already own everything in this offer");
        }
        const Stacked = ToGrant.filter((Item) => GrantKind(Item.catalogId) === "stacked").map((Item) => ({ catalogId: Item.catalogId, quantity: 1 }));
        // Instanced ids derived from the token: a retried transaction names the same instance
        const Instanced = ToGrant.filter((Item) => GrantKind(Item.catalogId) === "instanced")
            .map((Item) => ({ catalogId: Item.catalogId, instanceId: Hash(`${TokenHash}:${Item.catalogId}`).slice(0, 32), updateVersion: 0 }));

        if(Stacked.length > 0 || Instanced.length > 0 || Price > 0){
            try{
                ApplyInventoryTransactionInTx(tx, {
                    UserId: AccountId,
                    CharacterId: Purchase.characterId,
                    TransactionId: `store:${TokenHash}`,
                    InstancedItemsToAdd: Instanced,
                    StackedItemsToAdd: Stacked,
                    StackedItemsToRemove: Price > 0 ? [{ catalogId: CACHE_COIN_CATALOG_ID, quantity: Price }] : undefined
                }, { Caller: "store", Source: `store:${Purchase.skuId}` });
            }
            catch(error){
                if(InventoryErrorOf(error) !== undefined){
                    throw new RewardCacheError(409, "The inventory could not complete this purchase");
                }
                throw error;
            }
        }

        tx.update(storepurchases).set({ redeemedDate: new Date().toISOString() }).where(eq(storepurchases.tokenHash, TokenHash)).run();
        return { Replayed: false, SkuId: Purchase.skuId, CharacterId: Purchase.characterId, Items: Stacked.length + Instanced.length, Price };
    }, { behavior: "immediate" });

    logger.info(Result.Replayed
        ? `Reward Cache purchase ${Result.SkuId} of ${AccountId} was already redeemed; nothing granted again`
        : `Reward Cache purchase ${Result.SkuId} for ${AccountId} (character ${Result.CharacterId}): ${Result.Items} item(s) for ${Result.Price} Cache Coins`);
    return Result;
}

function SendError(res: any, error: unknown, What: string){
    if(error instanceof RewardCacheError){
        logger.warn(`Reward Cache ${What} refused (${error.Status}): ${error.message}`);
        res.status(error.Status);
        res.json({ code: String(error.Status), message: error.message });
        return;
    }
    logger.error(error, `Reward Cache ${What} failed`);
    res.status(500);
    res.json({ code: "500", message: "Store request failed" });
}

function Only1147(_req: any, _res: any, next: any){
    next(IsGame1147() && RewardCacheOn() ? undefined : "router");
}

const IsCacheSku = (SkuId: unknown) => typeof SkuId === "string" && SkuId.startsWith(SKU_PREFIX) && OffersById.has(SkuId);

// The redeem request carries only the token: it is ours when its storepurchases row is a Reward Cache sku
function IsCacheToken(Token: unknown){
    if(typeof Token !== "string" || !/^[a-f0-9]{64}$/.test(Token)) return false;
    const Row = GetDb().select({ skuId: storepurchases.skuId }).from(storepurchases).where(eq(storepurchases.tokenHash, Hash(Token))).get();
    return Row != undefined && IsCacheSku(Row.skuId);
}

export const stores1147Router = Router();

stores1147Router.use(Only1147);

stores1147Router.get("/product/skus/public", (req: any, _res, next) => {
    next(req.query.requiredTags === REWARD_CACHE_TAG ? undefined : "route");
}, HasUndauntedMetagameAuth, PlayerTokenOnly, (req: any, res) => {
    try{
        const HeldIds = HeldNow(req.AuthData.userId);
        const Listed = Offers.filter((Offer) => Offer.items.every((Item) => GrantKind(Item.catalogId) !== undefined))
            .map((Offer) => RewardCacheOffer1147(req, Offer, HeldIds));
        logger.info(`Store SKUs for tag ${REWARD_CACHE_TAG}: ${Listed.length} Reward Cache offer(s)`);
        res.status(200);
        res.json(Listed);
    }
    catch(error){
        SendError(res, error, "list");
    }
});

stores1147Router.get("/product/sku/:skuId", (req: any, _res, next) => {
    next(IsCacheSku(req.params.skuId) ? undefined : "route");
}, HasUndauntedMetagameAuth, PlayerTokenOnly, (req: any, res) => {
    try{
        res.status(200);
        res.json(RewardCacheOffer1147(req, OffersById.get(req.params.skuId)!, HeldNow(req.AuthData.userId)));
    }
    catch(error){
        SendError(res, error, `offer ${req.params.skuId}`);
    }
});

stores1147Router.get("/token/:currency/:skuId", (req: any, _res, next) => {
    next(IsCacheSku(req.params.skuId) ? undefined : "route");
}, HasUndauntedMetagameAuth, PlayerTokenOnly, PlayerMutationRateLimit, (req: any, res) => {
    try{
        res.status(200);
        res.json(CreateRewardCachePurchase(req.AuthData.userId, req.params.currency, req.params.skuId));
    }
    catch(error){
        SendError(res, error, `token for ${req.params.skuId}`);
    }
});

stores1147Router.post("/notification/:currency", (req: any, _res, next) => {
    next(IsCacheToken(req.query.token) ? undefined : "route");
}, HasUndauntedMetagameAuth, PlayerTokenOnly, PlayerMutationRateLimit, (req: any, res) => {
    try{
        RedeemRewardCachePurchase(req.AuthData.userId, req.params.currency, req.query.token);
        res.status(204);
        res.send();
    }
    catch(error){
        SendError(res, error, "purchase");
    }
});
