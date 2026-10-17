import crypto from "node:crypto";
import { Router } from "express";
import { GetDb } from "../db";
import { logger } from "../logger";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { PlayerTokenOnly } from "../middleware/PlayerAuth";
import { PlayerMutationRateLimit } from "../middleware/RateLimits";
import { GrantEntitlementInTx, HasActiveEntitlement } from "../controllers/entitlements";

// The Elite Hunt Pass offer for the Dauntless 1.14.7 client (TARGET_GAME_VERSION=1.14.7).
// Evidence: PORT-1.14.7/14-progression.md.
//
// The 1.14.7 client asks the store for the tag "<pass>_pass" (season43_pass, metagame.log) to show the
// Elite purchase. 1.4.4 Revived answered its season09b_pass tag from vendor/store_catalog.json with one
// free offer granting the entitlement season09b_premium (controllers/freestore.ts), which reads as owned
// because ENTITLEMENTS_DEFAULT gives that entitlement to every account. That catalogue has no 1.14.7 tag
// and its offers use the 1.4.4 flat price fields, so this router answers the pass tag itself, in the
// 1.14.7 offer shape (prices[], as routes/store.ts ToOffer1147), whatever STORE is set to:
// - GET /product/skus/public?requiredTags=<pass>_pass: [the offer], remaining 0 once the account owns
//   <pass>_premium (the track's premium_gating_entitlement);
// - GET /product/sku/<pass>_premium: the offer;
// - GET /token/<currency>/<pass>_premium and POST /notification/<currency>?token=: a free purchase that
//   grants <pass>_premium (source "store:<pass>_premium"). Other skus and tokens go on to storeRouter.
// The pass id is ACTIVE_HUNT_PASS (season43 by default).
const IsGame1147 = () => process.env.TARGET_GAME_VERSION === "1.14.7";
const PassId = () => (process.env.ACTIVE_HUNT_PASS || "season43").trim();
const PassTag = () => `${PassId()}_pass`;
const PassSku = () => `${PassId()}_premium`;

const TOKEN_MS = 10 * 60 * 1000;
// token -> {account, expiry, redeemed}; a redeemed token is kept until expiry so a retried redeem is a 204
const Tokens = new Map<string, { AccountId: string, Expires: number, Redeemed: boolean }>();

function Only1147(_req: any, _res: any, next: any){
    next(IsGame1147() ? undefined : "router");
}

function Owns(AccountId: string){
    return GetDb().transaction((tx) => HasActiveEntitlement(tx, AccountId, PassSku()));
}

export function ElitePassOffer1147(AccountId: string){
    const Sku = PassSku();

    return {
        id: Sku,
        displayName: "Elite Hunt Pass",
        displayDescription: "Unlock the Elite reward track for this Hunt Pass.",
        displayPriority: 300,
        maxAllowed: 1,
        remaining: Owns(AccountId) ? 0 : 1,
        prices: [{ currencyId: "id_currency_platinum", price: 0, salesPrice: 0 }],
        items: [],
        entitlements: [{ name: Sku, duration: 0 }],
        skuProgression: null,
        loadoutSlots: 0,
        tags: [PassTag()],
        availableFrom: null,
        availableTo: null,
        timeAvailabilityReason: "",
        platformOfferId: "",
        images: {},
        missingEntitlementNames: []
    };
}

function IsPlatinum(Currency: string){
    const Lower = Currency.toLowerCase();
    return Lower === "id_currency_platinum" || Lower === "platinum" || Lower === "currency_platinum_univ";
}

function Sweep(Now: number){
    for(const [Token, Entry] of Tokens){
        if(Entry.Expires <= Now) Tokens.delete(Token);
    }
}

export const progression1147Router = Router();

progression1147Router.use(Only1147);

progression1147Router.get("/product/skus/public", (req: any, res, next) => {
    next(req.query.requiredTags === PassTag() ? undefined : "route");
}, HasUndauntedMetagameAuth, PlayerTokenOnly, (req: any, res) => {
    const Offer = ElitePassOffer1147(req.AuthData.userId);

    logger.info(`Store SKUs for tag ${PassTag()}: the Elite pass, ${Offer.remaining === 0 ? "owned" : "not owned"}`);
    res.status(200);
    res.json([Offer]);
});

progression1147Router.get("/product/sku/:skuId", (req: any, res, next) => {
    next(req.params.skuId === PassSku() ? undefined : "route");
}, HasUndauntedMetagameAuth, PlayerTokenOnly, (req: any, res) => {
    res.status(200);
    res.json(ElitePassOffer1147(req.AuthData.userId));
});

progression1147Router.get("/token/:currency/:skuId", (req: any, res, next) => {
    next(req.params.skuId === PassSku() ? undefined : "route");
}, HasUndauntedMetagameAuth, PlayerTokenOnly, PlayerMutationRateLimit, (req: any, res) => {
    const AccountId: string = req.AuthData.userId;

    if(!IsPlatinum(req.params.currency)){
        res.status(400);
        res.json({ code: "400", message: "Offer is not sold in that currency" });
        return;
    }

    if(Owns(AccountId)){
        res.status(409);
        res.json({ code: "409", message: "The Elite pass is already owned" });
        return;
    }

    const Now = Date.now();
    Sweep(Now);

    const Token = crypto.randomBytes(24).toString("hex");
    Tokens.set(Token, { AccountId, Expires: Now + TOKEN_MS, Redeemed: false });
    logger.info(`Elite pass purchase token issued to ${AccountId}`);

    res.status(200);
    res.json({ purchaseToken: Token });
});

progression1147Router.post("/notification/:currency", (req: any, res, next) => {
    const Token = req.query.token;
    next(typeof Token === "string" && Tokens.has(Token) ? undefined : "route");
}, HasUndauntedMetagameAuth, PlayerTokenOnly, PlayerMutationRateLimit, (req: any, res) => {
    const Entry = Tokens.get(req.query.token)!;
    const AccountId: string = req.AuthData.userId;

    if(Entry.AccountId !== AccountId || Entry.Expires <= Date.now()){
        res.status(404);
        res.json({ code: "404", message: "Unknown purchase token" });
        return;
    }

    if(!Entry.Redeemed){
        GetDb().transaction((tx) => GrantEntitlementInTx(tx, AccountId, PassSku(), 0, `store:${PassSku()}`));
        Entry.Redeemed = true;
        logger.info(`Elite pass ${PassSku()} bought by ${AccountId}`);
    }

    res.status(204);
    res.send();
});
