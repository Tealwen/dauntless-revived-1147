import path from "node:path";
import { Router } from "express";
import { logger } from "../logger";
import { STORE_IMAGES_DIR, StoreImageFile, StoreImages } from "../controllers/storeimages";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { GetHeldCurrencies, GetNotesForUser, OverlayHeldCurrencies } from "../controllers/store";
import { PlayerTokenOnly } from "../middleware/PlayerAuth";
import { CreateStorePurchase, GetStoreOffer, IsAnyStoreEnabled, IsKnownStoreTag, IsStoreSkuEnabled, IsStoreTagEnabled, ListStoreOffers, RedeemStorePurchase, StoreError } from "../controllers/freestore";
import { BalanceFromInventory } from "../features";
import { PlayerMutationRateLimit } from "../middleware/RateLimits";

export const storeRouter = Router();

// BALANCE_FROM_INVENTORY=1 (the default; roadmap 2.17): the currencies the account's active character
// holds replace the sheet's fixed values (controllers/store.ts). Off: the fixed sheet, as before. The
// idea is from Harmonic's fork (github.com/Harmonicrain/Undaunted 895f7c7), without its wallet table.
function ApplyHeldCurrencies(AccountId: unknown, Sheet: Record<string, unknown>){
    if(!BalanceFromInventory() || typeof AccountId !== "string"){
        return;
    }

    const { CharacterId, Held } = GetHeldCurrencies(AccountId);
    const Changed = OverlayHeldCurrencies(Sheet, Held);

    if(Changed.length > 0){
        logger.info(`Balances of ${AccountId} from the inventory of character ${CharacterId}: ${Changed.map((Key) => `${Key} ${Sheet[Key]}`).join(", ")}`);
    }
}

storeRouter.post("/reconcile", HasUndauntedMetagameAuth, async (req: any, res) => {
    const Notes = await GetNotesForUser(req.AuthData.userId);

    logger.info(`Retrieved notes balance of ${Notes} for ${req.AuthData.userId}`);

    const Balances: Record<string, unknown> = {
        id_currency_notes: Notes,
        CURRENCY_NOTES: Notes
    };

    ApplyHeldCurrencies(req.AuthData.userId, Balances);

    res.status(200);
    res.json({
        balances: Balances,
        refreshInventory: true
    });
});

storeRouter.get("/creator", HasUndauntedMetagameAuth, async (req: any, res) => {
    logger.info("SupportACreator (stubbed)");

    res.status(200);
    res.json({
        "expirationDate": "2099-01-01T01:00:00.041Z",
        "slug": "MROWMROW",
        "success": true
    });
})

storeRouter.get("/balance", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;

    const NotesBalance = await GetNotesForUser(UserId);

    logger.info(`Fetched notes balance of ${NotesBalance} for userId ${UserId}`);

    const Sheet: Record<string, unknown> = {
        id_currency_s20_coin: 0,
        CURRENCY_GAUNTLET_COIN_FADED: 0,
        CURRENCY_S20_COIN: 0,
        CURRENCY_S18_COIN: 0,
        id_currency_seasonal_coin: 0,
        id_currency_s18_coin: 0,
        id_currency_weapon_token: 25,
        id_currency_celldust: 0,
        id_currency_event_ramsgiving: 0,
        CURRENCY_NOTES: NotesBalance,
        id_currency_event_frostfall: 0,
        CURRENCY_EVENT_DARKHARVEST: 0,
        CURRENCY_S19_COIN: 0,
        id_currency_s16_coin: 0,
        CURRENCY_S16_COIN: 0,
        id_currency_gauntlet_coin: 0,
        id_currency_s13_coin: 0,
        CURRENCY_MARKS_STEEL: 0,
        CURRENCY_S13_COIN: 0,
        CURRENCY_EVENT_FROSTFALL: 0,
        CURRENCY_GAUNTLET_COIN: 0,
        id_currency_marks_steel: 0,
        id_currency_rewardcache: 0,
        CURRENCY_PRESTIGE: 0,
        CURRENCY_SEASONAL_COIN: 0,
        CURRENCY_REWARDCACHE: 0,
        id_currency_token_exchange_speed_up: 0,
        id_currency_event_springtide: 0,
        CURRENCY_TOKEN_EXCHANGE_SPEED_UP: 0,
        id_currency_gauntlet_coin_faded: 0,
        CURRENCY_S15_COIN: 0,
        CURRENCY_PLATINUM: 0,
        id_currency_platinum: 0,
        id_currency_s15_coin: 0,
        id_currency_marks_gilded: 0,
        id_currency_event_darkharvest: 0,
        id_currency_event_saintsbond: 0,
        CURRENCY_EVENT_SPRINGTIDE: 0,
        id_currency_s19_coin: 0,
        id_currency_notes: NotesBalance,
        id_currency_prestige: 0,
        id_currency_s13_daily: 0,
        CURRENCY_WEAPON_TOKEN: 25,
        CURRENCY_MARKS_GILDED: 0,
        CURRENCY_S13_DAILY: 0,
        CURRENCY_CELLDUST: 0,
        CURRENCY_S14_COIN: 0,
        CURRENCY_EVENT_SAINTSBOND: 0,
        CURRENCY_S17_COIN: 0,
        id_currency_s14_coin: 0,
        CURRENCY_EVENT_RAMSGIVING: 0,
        id_currency_s17_coin: 0
    };

    ApplyHeldCurrencies(UserId, Sheet);

    res.status(200);
    res.json(Sheet);
});

// ---- Store purchase service. ----
// STORE=free controls the ordinary cosmetic webstore. Lady Luck and Middleman share the recovered
// token/notification protocol but are independently gated by TRIALS_STORE and MIDDLEMAN_STORE.
// This keeps the old storefront disabled without accidentally disabling gameplay vendors.

function StoreListOn(req: any, res: any, next: any){
    const Tag = req.query.requiredTags;
    next((typeof Tag === "string" ? IsStoreTagEnabled(Tag) : IsAnyStoreEnabled()) ? undefined : "route");
}

function StoreSkuOn(req: any, res: any, next: any){
    next(IsStoreSkuEnabled(req.params.skuId) ? undefined : "route");
}

function StoreAnyOn(req: any, res: any, next: any){
    next(IsAnyStoreEnabled() ? undefined : "route");
}

function SendStoreError(res: any, error: unknown, What: string){
    if(error instanceof StoreError){
        logger.warn(`Store ${What} refused (${error.Status}): ${error.message}`);
        res.status(error.Status);
        res.json({ code: String(error.Status), message: error.message });
        return;
    }

    logger.error(error, `Store ${What} failed`);
    res.status(500);
    res.json({ code: "500", message: "Store request failed" });
}

// An offer whose first item has an icon (controllers/storeimages.ts) gets its URL on this server
function WithStoreImage(req: any, Offer: any){
    const Images = StoreImages(req, [Offer?.items?.[0]?.catalogId]);
    return Images.standard == undefined ? Offer : {...Offer, images: {...(Offer.images ?? {}), ...Images}};
}

storeRouter.get("/store-images/:file", (req, res) => {
    const File = req.params.file;

    if(!/^[a-z0-9_]+\.png$/.test(File) || !StoreImageFile(File.slice(0, -4))){
        res.status(404);
        res.send();
        return;
    }

    res.set("Cache-Control", "public, max-age=86400");
    res.sendFile(path.join(STORE_IMAGES_DIR, File));
});

// 1.14.7 reads an offer's prices from prices: [{currencyId, price, salesPrice}] and skips an offer with none;
// the 1.4.4 flat price fields are unknown to it (PORT-1.14.7/09-store.md).
// The client's offer parser (0xE46900) turns each prices[] entry into a currency variant through its own map
// (0x146CD0280, built at 0x5EBAB0): id_currency_platinum / _celldust / _marks_steel / _marks_gilded / _event_01 ->
// CURRENCY_PLATINUM / ... (the codes UStoreItemViewModel::SetStoreCurrency knows). A currencyId missing from that
// map is dropped, so the prices must use the id_currency_* names.
const Is1147 = () => process.env.TARGET_GAME_VERSION === "1.14.7";
const PRICE_FIELDS_1147: Record<string, string> = {
    platinumPrice: "id_currency_platinum",
    cellDustPrice: "id_currency_celldust",
    steelMarksPrice: "id_currency_marks_steel",
    gildedMarksPrice: "id_currency_marks_gilded",
    prestigePrice: "id_currency_prestige",
    event01Price: "id_currency_event_01"
};

function ToInt(Value: unknown, Default: number){
    return typeof Value === "number" && Number.isFinite(Value) ? Math.trunc(Value) : Default;
}

function ToOffer1147(Offer: any){
    if(!Is1147()) return Offer;

    const Out: any = {...Offer};
    const Prices: any[] = [];

    for(const [Field, CurrencyId] of Object.entries(PRICE_FIELDS_1147)){
        if(typeof Offer[Field] === "number"){
            const Sale = Field === "platinumPrice" ? Offer.platinumSalePrice : undefined;
            Prices.push({currencyId: CurrencyId, price: ToInt(Offer[Field], 0), salesPrice: ToInt(Sale, 0)});
        }
        delete Out[Field];
    }
    delete Out.platinumSalePrice;

    return {
        ...Out,
        displayName: Out.displayName ?? "",
        displayDescription: Out.displayDescription ?? "",
        displayPriority: ToInt(Out.displayPriority, 0),
        maxAllowed: ToInt(Out.maxAllowed, 0),
        remaining: ToInt(Out.remaining, 0),
        prices: Array.isArray(Out.prices) && Out.prices.length > 0 ? Out.prices : Prices,
        items: Out.items ?? [],
        entitlements: Out.entitlements ?? [],
        skuProgression: null,
        loadoutSlots: ToInt(Out.loadoutSlots, 0),
        tags: Out.tags ?? [],
        timeAvailabilityReason: Out.timeAvailabilityReason ?? "",
        platformOfferId: Out.platformOfferId ?? "",
        images: Out.images ?? {},
        missingEntitlementNames: Out.missingEntitlementNames ?? []
    };
}

// StoreGetItemByTagEndpoint: a bare array of offers
storeRouter.get("/product/skus/public", StoreListOn, HasUndauntedMetagameAuth, PlayerTokenOnly, (req: any, res) => {
    const RequiredTags = req.query.requiredTags;

    if(typeof RequiredTags !== "string" || RequiredTags.length === 0){
        logger.warn("Store SKU request with no requiredTags");
        res.status(400);
        res.json({ code: "400", message: "missing requiredTags query parameter" });
        return;
    }

    try{
        const Offers = ListStoreOffers(req.AuthData.userId, RequiredTags);

        if(IsKnownStoreTag(RequiredTags)){
            logger.info(`Store SKUs for tag ${RequiredTags}: ${Offers.length} offer(s)`);
        }
        else{
            logger.warn(`Store SKUs requested for unknown tag ${RequiredTags}: an empty list`);
        }

        res.status(200);
        res.json(Offers.map((Offer: any) => ToOffer1147(WithStoreImage(req, Offer))));
    }
    catch(error){
        SendStoreError(res, error, `list ${RequiredTags}`);
    }
});

// StoreGetItemByIdEndpoint: one offer, for the purchase dialog
storeRouter.get("/product/sku/:skuId", StoreSkuOn, HasUndauntedMetagameAuth, PlayerTokenOnly, (req: any, res) => {
    try{
        res.status(200);
        res.json(ToOffer1147(WithStoreImage(req, GetStoreOffer(req.AuthData.userId, req.params.skuId))));
    }
    catch(error){
        SendStoreError(res, error, `offer ${req.params.skuId}`);
    }
});

// StorePurchaseItemEndpoint: {purchaseToken}. Whatever else the request carries is ignored.
storeRouter.get("/token/:currency/:skuId", StoreSkuOn, HasUndauntedMetagameAuth, PlayerTokenOnly, PlayerMutationRateLimit, (req: any, res) => {
    try{
        res.status(200);
        res.json(CreateStorePurchase(req.AuthData.userId, req.params.currency, req.params.skuId));
    }
    catch(error){
        SendStoreError(res, error, `token for ${req.params.skuId}`);
    }
});

// StorePurchaseItemConfirmEndpoint: redeems the token; 204, also for a token already redeemed
storeRouter.post("/notification/:currency", StoreAnyOn, HasUndauntedMetagameAuth, PlayerTokenOnly, PlayerMutationRateLimit, (req: any, res) => {
    try{
        RedeemStorePurchase(req.AuthData.userId, req.params.currency, req.query.token);
        res.status(204);
        res.send();
    }
    catch(error){
        SendStoreError(res, error, "purchase");
    }
});

// STORE=off: the answer the store screen always got
storeRouter.get("/product/skus/public", HasUndauntedMetagameAuth, async (req: any, res) => {
    logger.info(`Store SKUs (stubbed) for tag ${req.query.requiredTags}`);

    // 1.14.7 takes a 400 as a broken store ("Unable to open the store") on every vendor screen; an empty list is fine
    // there. The main store (webstore) is the exception: with an empty list it spins forever, so it keeps the
    // 1.4.4 answer below and says the store is unavailable.
    if(Is1147() && req.query.requiredTags !== "webstore"){
        res.status(200);
        res.json([]);
        return;
    }

    // TODO: No clue if this is microtransactions or game transactions yet
    // If game transactions, I'll support it as it was on live
    // If microtransactions, I'll prob rewire to make everything earnable (no real money here!)

    res.status(400);
    res.json({
        code: "400",
        message: "The store is not available on Dauntless Revived yet."
    });
});
