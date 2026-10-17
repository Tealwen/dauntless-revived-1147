import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SeasonalEventItems } from "../src/routes/tuning";

describe("SEASONAL_EVENTS", () => {
    it("keeps the listed events in the seasonal schedule, from 2020 to 2099", () => {
        const Items = SeasonalEventItems({ SEASONAL_EVENTS: "EVENT_DARKHARVEST, DarkHarvest" } as any);
        assert.deepEqual(Items.map((Item) => Item.ScheduledItems[0].ID), ["EVENT_DARKHARVEST", "DarkHarvest"]);
        assert.equal(Items[0].StartTime, "2020.01.01-00.00.00");
        assert.equal(Items[0].EndTime, "2099.12.31-00.00.00");
    });

    it("is empty when unset and ignores malformed ids", () => {
        assert.deepEqual(SeasonalEventItems({} as any), []);
        assert.deepEqual(SeasonalEventItems({ SEASONAL_EVENTS: "bad id,<x>" } as any), []);
    });
});
