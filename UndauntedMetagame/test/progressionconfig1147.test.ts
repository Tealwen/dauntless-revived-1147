import "./env1147";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GetConfiguredPath, GetProgressionConfigPayload } from "../src/controllers/progressionconfig";
import slayersPathItems from "../src/vendor/slayers_path_items_1147.json";

const Items = (Path: any) => [...(Path.free_rewards ?? []), ...(Path.premium_rewards ?? [])].flatMap((Reward: any) =>
    ["stacked_items", "instanced_items", "ordered_instanced_items"].flatMap((List) => (Reward[List] ?? []).map((Item: any) => typeof Item === "string" ? Item : Item.catalog_id)));

// controllers/progressionconfig.ts on 1.14.7: the Slayer's Path items stay out of the 1.4.4 mastery rewards
describe("1.14.7 progression config", () => {
    it("the weapon mastery tracks no longer grant the weapon specials and mods of the Slayer's Path", () => {
        const Axe = GetConfiguredPath("MasteryTrack_Weapon_Axe");
        assert.ok(Axe);
        assert.ok(!Items(Axe).some((Id: string) => Id in slayersPathItems.items));
        assert.ok(Items(Axe).some((Id: string) => Id.startsWith("Container_Core")), "the other rewards stay");
        assert.equal(Axe.free_rewards?.length, 20, "every rank keeps its entry");
    });

    it("what /progression/config serves is the filtered config", () => {
        const Paths = (GetProgressionConfigPayload() as any).payload.paths;
        assert.ok(!Paths.flatMap(Items).some((Id: string) => Id.startsWith("PART_") && Id in slayersPathItems.items));
        assert.ok(Paths.some((Path: any) => Path.progression_id === "MasteryTrack_Weapon_Axe"));
    });
});
