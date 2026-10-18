import "./setup";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StartupGameserverWithHuntIdAndPlayers } from "../src/controllers/gameservers";

// A 1.14.7 hunt missing from the 1.4.4 hunt tables is refused with its name, before any process starts
// (a TypeError on an undefined row before).
describe("unknown hunts", () => {
    it("name the hunt in the error", async () => {
        await assert.rejects(StartupGameserverWithHuntIdAndPlayers("CR19_PlayerHunt_Gauntlet", ["player"]),
            /Unknown player hunt CR19_PlayerHunt_Gauntlet/);
    });
});
