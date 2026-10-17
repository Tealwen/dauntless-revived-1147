import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PlatinumPriceFor, StoreOffer } from "../src/controllers/freestore";
import { OverlayHeldCurrencies } from "../src/controllers/store";

const Offer = (tags: string[], items = 1, platinumPrice: number | null = 0): StoreOffer => ({
    id: "x", tags, platinumPrice, entitlements: [], remaining: 1,
    items: Array.from({ length: items }, (_, i) => ({ catalogId: `ITEM_${i}`, quantity: 1 }))
});

describe("STORE_PRICING=platinum", () => {
    it("prices webstore offers by category, armour sets above single pieces", () => {
        assert.equal(PlatinumPriceFor(Offer(["webstore", "skin_armour"], 4)), 1500);
        assert.equal(PlatinumPriceFor(Offer(["webstore", "skin_armour"], 1)), 450);
        assert.equal(PlatinumPriceFor(Offer(["webstore", "skin_weapon_cb"])), 800);
        assert.equal(PlatinumPriceFor(Offer(["webstore", "social_emote", "personality_character"])), 300);
        assert.equal(PlatinumPriceFor(Offer(["webstore"])), 300);
    });

    it("keeps a catalogue price, and leaves supplies and other tags alone", () => {
        assert.equal(PlatinumPriceFor(Offer(["webstore", "skin_lantern"], 1, 999)), 999);
        assert.equal(PlatinumPriceFor(Offer(["webstore", "supplies_boost"])), undefined);
        assert.equal(PlatinumPriceFor(Offer(["ladyluckstore"])), undefined);
    });

    it("shows the CURRENCY_PLATINUM_UNIV stack as the Platinum balance", () => {
        const Sheet: Record<string, unknown> = { id_currency_platinum: 0, CURRENCY_PLATINUM: 0 };
        OverlayHeldCurrencies(Sheet, new Map([["CURRENCY_PLATINUM_UNIV", 1234]]));
        assert.deepEqual(Sheet, { id_currency_platinum: 1234, CURRENCY_PLATINUM: 1234 });
    });
});
