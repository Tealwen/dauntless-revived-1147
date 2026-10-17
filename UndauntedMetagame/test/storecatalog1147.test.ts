import "./env1147";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import catalog1147 from "../src/vendor/store_catalog_1147.json";
import { GrantKind, PlatinumPriceFor, StoreOffer } from "../src/controllers/freestore";

// vendor/store_catalog_1147.json, the 1.14.7 main store (PORT-1.14.7 doc 18)
const Offers = (catalog1147 as unknown as { webstore: StoreOffer[] }).webstore;

describe("1.14.7 store catalogue", () => {
    it("has the 1370 offers, each with a unique id, sold in the webstore", () => {
        assert.equal(Offers.length, 1370);
        assert.equal(new Set(Offers.map((Offer) => Offer.id)).size, Offers.length);
        assert.ok(Offers.every((Offer) => Offer.tags.includes("webstore")));
    });

    it("grants only items the store can hand out, and every offer gets a Platinum price", () => {
        for(const Offer of Offers){
            for(const Item of Offer.items ?? []){
                assert.ok(GrantKind(Item.catalogId) !== undefined, `${Offer.id}: ${Item.catalogId} has no grant kind`);
            }
            assert.ok((PlatinumPriceFor(Offer) ?? 0) > 0, `${Offer.id} has no Platinum price`);
        }
    });

    it("has an icon for nearly every offer in store-images-1147", () => {
        const Dir = path.join(__dirname, "..", "..", "store-images-1147");
        const Missing = Offers.filter((Offer) => !fs.existsSync(path.join(Dir, `${(Offer.items?.[0]?.catalogId ?? "").toLowerCase()}.png`)));
        assert.ok(Missing.length <= 20, `${Missing.length} offers without an icon`);
    });
});
