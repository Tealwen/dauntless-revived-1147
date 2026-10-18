import crypto from "node:crypto";
import { Router } from "express";
import { and, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { GetDb } from "../db";
import { characters, storepurchases } from "../db/schema";
import { logger } from "../logger";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { PlayerTokenOnly } from "../middleware/PlayerAuth";
import { PlayerMutationRateLimit } from "../middleware/RateLimits";
import { GetActiveCharacter } from "../controllers/activecharacter";
import { ApplyInventoryTransactionInTx, InventoryErrorOf } from "../controllers/inventory";
import { Tx } from "../controllers/savehistory";
import { ParseOnOff } from "../features";

// The Ramsgate fountain of the 1.14.7 client (TARGET_GAME_VERSION=1.14.7): a player flips a coin once a day.
// The client asks the store for the tag "fountain_daily_free_bundle" and buys its one free offer; the coin
// toss animation and the reward stinger (/Game/UI/CoinToss/cointoss_stringer_bpw, DailyBonusItemId
// CONTAINER_CORE_REWARD_DAILY_01) only play once that purchase succeeds. The store answered no offer, so the
// fountain did nothing.
// - GET /product/skus/public?requiredTags=fountain_daily_free_bundle: the offer, remaining 0 once bought since
//   the last daily reset (17:00 UTC, as the bounties);
// - GET /product/sku/fountain_daily_free_bundle_01, GET /token/<currency>/fountain_daily_free_bundle_01 (free,
//   storepurchases row, 10 minutes, refused when already bought today);
// - POST /notification/<currency>?token=: grants the daily core (CONTAINER_CORE_REWARD_DAILY_01, opened by the
//   game like the mastery cores); a retried redeem answers 204 and grants nothing.
// FOUNTAIN=0 turns this router off.

const IsGame1147 = () => process.env.TARGET_GAME_VERSION === "1.14.7";
const FountainOn = () => ParseOnOff(process.env.FOUNTAIN ?? "1") ?? true;

export const FOUNTAIN_TAG = "fountain_daily_free_bundle";
export const FOUNTAIN_SKU = "fountain_daily_free_bundle_01";
export const FOUNTAIN_ITEM = "CONTAINER_CORE_REWARD_DAILY_01";
const TOKEN_MINUTES = 10;
const CURRENCY_SEGMENTS = new Set(["platinum", "id_currency_platinum", "currency_platinum", "currency_platinum_univ", "all"]);

class FountainError extends Error {
    constructor(public Status: number, message: string){
        super(message);
    }
}

const Hash = (Value: string) => crypto.createHash("sha256").update(Value).digest("hex");

// Start of the current daily period (17:00 UTC)
export function FountainDayStart(Now = Date.now()){
    const Reset = 17 * 3600 * 1000, Day = 24 * 3600 * 1000;
    return new Date(Math.floor((Now - Reset) / Day) * Day + Reset).toISOString();
}

function BoughtToday(tx: Tx, AccountId: string){
    return tx.select({ tokenHash: storepurchases.tokenHash }).from(storepurchases)
        .where(and(eq(storepurchases.accountId, AccountId), eq(storepurchases.skuId, FOUNTAIN_SKU), isNotNull(storepurchases.redeemedDate),
            gte(storepurchases.redeemedDate, FountainDayStart()))).get() != undefined;
}

function Offer(Remaining: number){
    return {
        id: FOUNTAIN_SKU,
        displayName: "Fountain",
        displayDescription: "Flip a coin in the fountain once a day.",
        displayPriority: 0,
        maxAllowed: 1,
        remaining: Remaining,
        prices: [{ currencyId: "id_currency_platinum", price: 0, salesPrice: 0 }],
        items: [{ catalogId: FOUNTAIN_ITEM, quantity: 1 }],
        entitlements: [],
        skuProgression: null,
        loadoutSlots: 0,
        tags: [FOUNTAIN_TAG],
        availableFrom: null,
        availableTo: null,
        timeAvailabilityReason: "",
        platformOfferId: "",
        images: {},
        missingEntitlementNames: []
    };
}

const OfferFor = (AccountId: string) => Offer(GetDb().transaction((tx) => BoughtToday(tx, AccountId)) ? 0 : 1);

export function CreateFountainPurchase(AccountId: string, Currency: string){
    if(!CURRENCY_SEGMENTS.has(Currency.toLowerCase())){
        throw new FountainError(400, "Offer is not sold in that currency");
    }

    const Token = crypto.randomBytes(32).toString("hex");
    GetDb().transaction((tx) => {
        const Now = new Date();
        tx.delete(storepurchases).where(and(eq(storepurchases.accountId, AccountId), isNull(storepurchases.redeemedDate), lt(storepurchases.expiresDate, Now.toISOString()))).run();

        const Character = GetActiveCharacter(tx, AccountId);
        if(Character == undefined){
            throw new FountainError(409, "The account has no character to deliver the purchase to");
        }
        if(BoughtToday(tx, AccountId)){
            throw new FountainError(409, "Already flipped a coin today; come back after the daily reset");
        }

        tx.insert(storepurchases).values({
            tokenHash: Hash(Token),
            accountId: AccountId,
            characterId: Character.characterId,
            skuId: FOUNTAIN_SKU,
            offerHash: Hash(FOUNTAIN_ITEM),
            createdDate: Now.toISOString(),
            expiresDate: new Date(Now.getTime() + TOKEN_MINUTES * 60 * 1000).toISOString(),
            redeemedDate: null
        }).run();
    });

    logger.info(`Fountain token issued to ${AccountId}`);
    return { purchaseToken: Token };
}

export function RedeemFountainPurchase(AccountId: string, Token: string){
    const TokenHash = Hash(Token);
    const Granted = GetDb().transaction((tx) => {
        const Purchase = tx.select().from(storepurchases).where(eq(storepurchases.tokenHash, TokenHash)).get();
        if(Purchase == undefined || Purchase.accountId !== AccountId){
            throw new FountainError(403, "Invalid purchase token");
        }
        if(Purchase.redeemedDate != null){
            return false;
        }
        if(Purchase.expiresDate < new Date().toISOString()){
            throw new FountainError(410, "Purchase token expired");
        }
        const Character = tx.select({ userId: characters.userId }).from(characters).where(eq(characters.characterId, Purchase.characterId)).get();
        if(Character == undefined || Character.userId !== AccountId){
            throw new FountainError(403, "The purchase's character is no longer the account's");
        }
        // Two tokens issued before either was redeemed: only the first one pays out today
        if(BoughtToday(tx, AccountId)){
            throw new FountainError(409, "Already flipped a coin today; come back after the daily reset");
        }

        try{
            ApplyInventoryTransactionInTx(tx, {
                UserId: AccountId,
                CharacterId: Purchase.characterId,
                TransactionId: `store:${TokenHash}`,
                InstancedItemsToAdd: [],
                StackedItemsToAdd: [{ catalogId: FOUNTAIN_ITEM, quantity: 1 }]
            }, { Caller: "store", Source: `store:${FOUNTAIN_SKU}` });
        }
        catch(error){
            if(InventoryErrorOf(error) !== undefined){
                throw new FountainError(409, "The inventory could not complete this purchase");
            }
            throw error;
        }

        tx.update(storepurchases).set({ redeemedDate: new Date().toISOString() }).where(eq(storepurchases.tokenHash, TokenHash)).run();
        return true;
    }, { behavior: "immediate" });

    logger.info(Granted ? `Fountain: ${FOUNTAIN_ITEM} for ${AccountId}` : `Fountain purchase of ${AccountId} was already redeemed; nothing granted again`);
    return Granted;
}

function SendError(res: any, error: unknown, What: string){
    if(error instanceof FountainError){
        logger.warn(`Fountain ${What} refused (${error.Status}): ${error.message}`);
        res.status(error.Status);
        res.json({ code: String(error.Status), message: error.message });
        return;
    }
    logger.error(error, `Fountain ${What} failed`);
    res.status(500);
    res.json({ code: "500", message: "Store request failed" });
}

function IsFountainToken(Token: unknown){
    if(typeof Token !== "string" || !/^[a-f0-9]{64}$/.test(Token)) return false;
    const Row = GetDb().select({ skuId: storepurchases.skuId }).from(storepurchases).where(eq(storepurchases.tokenHash, Hash(Token))).get();
    return Row?.skuId === FOUNTAIN_SKU;
}

export const fountain1147Router = Router();

fountain1147Router.use((_req: any, _res: any, next: any) => next(IsGame1147() && FountainOn() ? undefined : "router"));

fountain1147Router.get("/product/skus/public", (req: any, _res, next) => {
    next(req.query.requiredTags === FOUNTAIN_TAG ? undefined : "route");
}, HasUndauntedMetagameAuth, PlayerTokenOnly, (req: any, res) => {
    try{
        const Listed = OfferFor(req.AuthData.userId);
        logger.info(`Store SKUs for tag ${FOUNTAIN_TAG}: the fountain, ${Listed.remaining ? "available" : "used today"}`);
        res.status(200);
        res.json([Listed]);
    }
    catch(error){
        SendError(res, error, "list");
    }
});

fountain1147Router.get("/product/sku/:skuId", (req: any, _res, next) => {
    next(req.params.skuId === FOUNTAIN_SKU ? undefined : "route");
}, HasUndauntedMetagameAuth, PlayerTokenOnly, (req: any, res) => {
    try{
        res.status(200);
        res.json(OfferFor(req.AuthData.userId));
    }
    catch(error){
        SendError(res, error, "offer");
    }
});

fountain1147Router.get("/token/:currency/:skuId", (req: any, _res, next) => {
    next(req.params.skuId === FOUNTAIN_SKU ? undefined : "route");
}, HasUndauntedMetagameAuth, PlayerTokenOnly, PlayerMutationRateLimit, (req: any, res) => {
    try{
        res.status(200);
        res.json(CreateFountainPurchase(req.AuthData.userId, req.params.currency));
    }
    catch(error){
        SendError(res, error, "token");
    }
});

fountain1147Router.post("/notification/:currency", (req: any, _res, next) => {
    next(IsFountainToken(req.query.token) ? undefined : "route");
}, HasUndauntedMetagameAuth, PlayerTokenOnly, PlayerMutationRateLimit, (req: any, res) => {
    try{
        RedeemFountainPurchase(req.AuthData.userId, req.query.token);
        res.status(204);
        res.send();
    }
    catch(error){
        SendError(res, error, "purchase");
    }
});
