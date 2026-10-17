import { Router } from "express";
import { logger } from "../logger";
import { TrialsSchedule } from "../features";
import { TrialIdForWeek, TrialWeekAt, TrialsWindowForWeek } from "../controllers/trials";

export const tuningRouter = Router();

type ScheduledItem = {
    ID: string,
    MaxCompletionPerInterval: number
};

type Schedule = {
    EndTime: string,
    IsRepeatable: boolean,
    Name: string,
    RepeatableDetails: {
        EachDay: boolean,
        EachWeek: boolean
    },
    ScheduledItems: ScheduledItem[],
    StartTime: string
};

function ServiceDate(EpochSeconds: number){
    const DateValue = new Date(EpochSeconds * 1000);
    const Pad = (Value: number) => String(Value).padStart(2, "0");

    return `${DateValue.getUTCFullYear()}.${Pad(DateValue.getUTCMonth() + 1)}.${Pad(DateValue.getUTCDate())}-${Pad(DateValue.getUTCHours())}.${Pad(DateValue.getUTCMinutes())}.${Pad(DateValue.getUTCSeconds())}`;
}

function OneTimeSchedule(Id: string, StartTime: string, EndTime: string): Schedule {
    return {
        EndTime,
        IsRepeatable: false,
        Name: Id,
        RepeatableDetails: {
            EachDay: false,
            EachWeek: false
        },
        ScheduledItems: [{
            ID: Id,
            MaxCompletionPerInterval: -1
        }],
        StartTime
    };
}

// SEASONAL_EVENTS: seasonal events kept running, comma-separated scheduler ids, e.g. EVENT_DARKHARVEST,DarkHarvest
// (Halloween; the 1.14.7 seasonal_event_ui_table has EventID EVENT_DARKHARVEST on row DarkHarvest). Ramsgate's
// event decoration is a game feature flag (DR_FEATURES on the game servers and the launcher); the event's
// gatherables and currency are only live while the event is in this schedule. Each id runs from 2020 to 2099.
export function SeasonalEventItems(Env: NodeJS.ProcessEnv = process.env): Schedule[] {
    return (Env.SEASONAL_EVENTS ?? "").split(",").map((Id) => Id.trim())
        .filter((Id) => /^[A-Za-z0-9_.-]{1,64}$/.test(Id))
        .map((Id) => OneTimeSchedule(Id, "2020.01.01-00.00.00", "2099.12.31-00.00.00"));
}

export function GetSeasonalEventSchedule(At: Date = new Date()){
    const Seasonal = SeasonalEventItems();

    if(!TrialsSchedule()){
        return {
            code: null,
            message: "OK",
            payload: {
                ScheduledItems: Seasonal
            }
        };
    }

    const Week = TrialWeekAt(At);
    const Window = TrialsWindowForWeek(Week, At);
    const StartTime = ServiceDate(Window.trial_start);
    const EndTime = ServiceDate(Window.trial_end);
    const Ids = [
        // Captured Phoenix tuning keeps this exact service key active for Lady Luck/Trials.
        // The four hunt ids below remain alongside it for the 1.4.4 A/B test because the
        // native GetCurrentNormalHuntScheduleDetails implementation is not symbolized.
        "event_ladyluck_repeatable",
        "CR19_PlayerHunt_Arena_Hard",
        "CR19_PlayerHunt_Arena_Elite",
        TrialIdForWeek(0, Week),
        TrialIdForWeek(1, Week)
    ];

    return {
        code: null,
        message: "OK",
        payload: {
            // FServiceSchedule -> FScheduleData -> FScheduledItem in the 1.4.4 SDK. The captured
            // event_ladyluck_repeatable key is the strongest known scheduler identifier; the player-hunt
            // and matchmaker ids make the experiment tolerant of whichever key the native arena code asks for.
            ScheduledItems: [...Ids.map((Id) => OneTimeSchedule(Id, StartTime, EndTime)), ...Seasonal]
        }
    };
}

tuningRouter.get("/game_tuning/seasonal_event_schedule", (req: any, res) => {
    logger.info(`Seasonal Event Schedule (${TrialsSchedule() ? "Trials active" : "no Trials"}; events: ${process.env.SEASONAL_EVENTS || "none"})`);

    res.status(200);
    res.json(GetSeasonalEventSchedule());
});

tuningRouter.get("/game_tuning/huntpass_xp_config", (req: any, res) => {
    logger.info("Huntpass XP Config (stubbed)");

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            EventConfigs: [],
            GlobalConfig: {
                DifficultyBias: 1.000000000000000,
                GlobalMultiplier: 1.000000000000000,
                MaxXPAwarded: 200
            }
        }
    });
});
