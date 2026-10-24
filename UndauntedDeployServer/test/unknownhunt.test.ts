import "./setup";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StartupGameserverWithHuntIdAndPlayers } from "../src/controllers/gameservers";

// A hunt missing from the tables (here a 1.14.7 ~DNT~ test map) is refused with its name, before any process starts
// (a TypeError on an undefined row before).
describe("unknown hunts", () => {
    it("name the hunt in the error", async () => {
        await assert.rejects(StartupGameserverWithHuntIdAndPlayers("ShatteredIsles_IslandM_183test", ["player"]),
            /Unknown player hunt ShatteredIsles_IslandM_183test/);
    });
});
