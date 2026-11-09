'use strict';
// Deletes raw events of every kind, user actions included, once they're older than the raw
// retention setting, but never before the rollups have summarized them; the rollups are kept.
// Weather older than the same setting goes too.

var { Event } = require('../models/event');
const rollups = require('../service/RollupService');
const settings = require('../service/SettingsService');
const weather = require('../service/WeatherService');

const BATCH = 5000;
const BUDGET_MS = Number(process.env.RETENTION_BUDGET_MS) || 20000;
const DAY_MS = 24 * 60 * 60 * 1000;

var run = async () => {
    const deadline = Date.now() + BUDGET_MS;
    const days = settings.rawRetentionDays();
    const cutoff = Date.now() - days * DAY_MS;
    // weather has no rollups to wait for
    const weatherRemoved = await weather.removeBefore(new Date(cutoff), settings.timeZone());
    const weatherNote = weatherRemoved > 0 ? `; removed ${weatherRemoved} hours and days of weather` : '';
    const { hour, day } = await rollups.watermarks();
    if (typeof hour === 'undefined' || typeof day === 'undefined') {
        return { summary: `waiting for the first rollups before removing any events${weatherNote}` };
    }
    const safe = Math.min(cutoff, hour, day);
    let removed = 0;
    let more = false;
    while (Date.now() < deadline) {
        const ids = (await Event.find({ timestamp: { $lt: new Date(safe) } }).sort({ timestamp: 1 }).limit(BATCH).select({ _id: 1 }).lean())
            .map((doc) => doc._id);
        if (ids.length === 0) {
            break;
        }
        removed += (await Event.deleteMany({ _id: { $in: ids } })).deletedCount;
        more = ids.length === BATCH;
    }
    const held = safe < cutoff ? `; waiting for rollups through ${new Date(cutoff).toISOString()}` : '';
    return {
        summary: `removed ${removed} events older than ${new Date(safe).toISOString()} (kept ${days} days)${held}${weatherNote}`,
        more: more && Date.now() >= deadline
    };
};

module.exports = {
    name: 'retention',
    description: 'removes raw events older than the retention period once they are rolled up',
    everyMs: Number(process.env.RETENTION_EVERY_MS) || 6 * 60 * 60 * 1000,
    firstDelayMs: Number(process.env.RETENTION_FIRST_DELAY_MS) || 10 * 60 * 1000,
    run
};
