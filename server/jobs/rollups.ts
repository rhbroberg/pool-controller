'use strict';
// Keeps hourly and daily rollups of the history graphs' readings up to date: every completed
// hour, and every completed local day, from raw events. A run stops after a time budget and
// says there's more, so a backfill of years of history goes in short steps between the
// controller's own work.

const rollups = require('../service/RollupService');
const settings = require('../service/SettingsService');
var { Rollup } = require('../models/rollup');
const tz = require('../utils/timezone');

const HOUR_MS = rollups.HOUR * 1000;
const BUDGET_MS = Number(process.env.ROLLUP_BUDGET_MS) || 15000;
// hours rolled per query; a few days of raw events at a time
const HOUR_CHUNK = 48;
const DAY_CHUNK = 14;
// raised whenever the heating series are derived from the switches differently, so the stored
// ones are redone from the raw events still kept; 2 needs a pump moving water
const HEATING_RULES = 2;

var floorHour = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS;

var run = async (context) => {
    const deadline = Date.now() + BUDGET_MS;
    const timeZone = settings.timeZone();
    const data = context.data;
    const oldest = await rollups.oldestRaw();
    if (typeof oldest === 'undefined' && !data.hourWatermark) {
        return { summary: 'no history to roll up yet' };
    }

    let hour = data.hourWatermark ? new Date(data.hourWatermark).getTime() : floorHour(oldest);
    let day = data.dayWatermark ? new Date(data.dayWatermark).getTime() : tz.startOfDay(hour, timeZone);
    const notes = [];

    // history added or removed in the past, as by seed-history
    if (data.rebuildFrom) {
        const from = new Date(data.rebuildFrom).getTime();
        hour = Math.min(hour, floorHour(from));
        day = Math.min(day, tz.startOfDay(from, timeZone));
        notes.push(`rebuilding from ${new Date(from).toISOString()}`);
    }
    // rollups from before raw events expired keep the old rules, since nothing is left to redo them from
    if (data.hourWatermark && data.heatingRules !== HEATING_RULES && typeof oldest === 'number') {
        hour = Math.min(hour, floorHour(oldest));
        day = Math.min(day, tz.startOfDay(oldest, timeZone));
        notes.push(`redoing heating from ${new Date(oldest).toISOString()} under new rules`);
    }
    // days start at a different time in the new zone, so every daily rollup is redone
    if (data.timeZone && data.timeZone !== timeZone) {
        await Rollup.deleteMany({ res: rollups.DAY });
        const firstHour = await Rollup.findOne({ res: rollups.HOUR }).sort({ start: 1 }).select({ start: 1 }).lean();
        const first = Math.min(firstHour ? firstHour.start.getTime() : hour, typeof oldest === 'number' ? oldest : hour);
        day = tz.startOfDay(first, timeZone);
        notes.push(`redoing daily rollups for ${timeZone}`);
    }
    await context.save({ hourWatermark: new Date(hour), dayWatermark: new Date(day), timeZone, rebuildFrom: null, heatingRules: HEATING_RULES });

    const target = floorHour(Date.now());
    let hours = 0;
    while (hour < target && Date.now() < deadline) {
        const end = Math.min(hour + HOUR_CHUNK * HOUR_MS, target);
        const edges = [];
        for (let edge = hour; edge <= end; edge += HOUR_MS) {
            edges.push(edge);
        }
        await rollups.store(rollups.HOUR, hour, end, await rollups.bucketsFromRaw(rollups.ROLLED_NAMES, edges));
        hours += edges.length - 1;
        hour = end;
        await context.save({ hourWatermark: new Date(hour) });
    }

    // days complete once every hour in them is rolled up
    let days = 0;
    let oldestKept = await rollups.oldestRaw();
    while (tz.addDays(day, 1, timeZone) <= hour && Date.now() < deadline) {
        const edges = [day];
        while (edges.length <= DAY_CHUNK && tz.addDays(edges[edges.length - 1], 1, timeZone) <= hour) {
            edges.push(tz.addDays(edges[edges.length - 1], 1, timeZone));
        }
        const end = edges[edges.length - 1];
        // from raw events while they're kept, from the hourly rollups once they've expired
        const raw = typeof oldestKept === 'number' && day >= oldestKept;
        const buckets = raw
            ? await rollups.bucketsFromRaw(rollups.ROLLED_NAMES, edges)
            : await rollups.daysFromHours(rollups.ROLLED_NAMES, edges);
        await rollups.store(rollups.DAY, day, end, buckets);
        days += edges.length - 1;
        day = end;
        await context.save({ dayWatermark: new Date(day) });
    }

    const caughtUp = hour >= target && tz.addDays(day, 1, timeZone) > hour;
    notes.push(`rolled up ${hours} hours and ${days} days; hourly through ${new Date(hour).toISOString()}, daily through ${tz.dayKey(day - 1, timeZone)}`);
    return { summary: notes.join('; '), more: !caughtUp };
};

module.exports = {
    name: rollups.ROLLUPS_JOB,
    description: 'summarizes history by hour and by day for the graphs and the calendar',
    everyMs: Number(process.env.ROLLUP_EVERY_MS) || 5 * 60 * 1000,
    firstDelayMs: Number(process.env.ROLLUP_FIRST_DELAY_MS) || 60 * 1000,
    run
};
