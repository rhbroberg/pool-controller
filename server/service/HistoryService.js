'use strict';
require('../config/config');

var { Event } = require('../models/event');
var { Rollup } = require('../models/rollup');
var utils = require('../utils/writer.js');
const rollups = require('./RollupService');
const settings = require('./SettingsService');
const tz = require('../utils/timezone');
const log4js = require('log4js');
var logger = log4js.getLogger();

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_POINTS = 2000;
const MIN_POINTS = 10;
const MAX_POINTS = 5000;
const MAX_NAMES = 16;
const MAX_AVAILABILITY_DAYS = 1500;
// bucket lengths in seconds; a window is bucketed at the shortest that keeps it within maxPoints
const RESOLUTIONS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 1209600, 2592000];

var badRequest = (message) => utils.respondWithCode(400, { code: 400, message: message });

var parseDate = (text, fallback, label) => {
    if (typeof text === 'undefined' || text === '') {
        return fallback;
    }
    const date = new Date(text);
    if (isNaN(date.getTime())) {
        throw badRequest(`${label} is not a date: ${text}`);
    }
    return date;
};

/**
 * the shortest bucket at least `requested` seconds long that keeps the window within maxPoints
 **/
var chooseResolution = (spanMs, maxPoints, requested = 0) => {
    const shortest = Math.max(requested, spanMs / 1000 / maxPoints);
    return RESOLUTIONS.find((seconds) => seconds >= shortest && Math.ceil(spanMs / 1000 / seconds) + 1 <= maxPoints)
        || RESOLUTIONS[RESOLUTIONS.length - 1];
};

var pointAt = (reading) => (reading ? { t: new Date(reading.t), v: reading.v } : null);

var countRaw = (name, from, to) => Event.countDocuments({ eventType: rollups.eventTypeOf(name), 'status.name': name, timestamp: { $gte: from, $lt: to } });

// every reading as recorded, which is what a short window gets
var rawSeries = async (name, from, to) => {
    if (rollups.isDerived(name)) {
        const line = (await rollups.timelines([name], from.getTime(), to.getTime()))[name];
        return {
            name,
            resolution: 0,
            before: line.initial === null ? null : { t: from, v: line.initial },
            points: line.events.map((event) => ({ t: new Date(event.t), v: event.v })),
            downsampled: false
        };
    }
    const [before, docs] = await Promise.all([
        rollups.rawValueBefore(name, from.getTime()),
        Event.find({ eventType: rollups.eventTypeOf(name), 'status.name': name, timestamp: { $gte: from, $lt: to } })
            .sort({ timestamp: 1 })
            .select({ timestamp: 1, status: 1 })
            .lean()
    ]);
    return {
        name,
        resolution: 0,
        before: pointAt(before),
        points: docs.map((doc) => {
            const entry = doc.status.find((reading) => reading.name === name);
            return { t: doc.timestamp, v: entry ? entry.value : null };
        }),
        downsampled: false
    };
};

var asPart = (doc) => ({ start: doc.start.getTime(), end: doc.end.getTime(), count: doc.count, min: doc.min, max: doc.max, sum: doc.sum, knownMs: doc.knownMs, last: doc.last });

/**
 * one point per bucket of `seconds`: stored rollups as far as the rollups job has got, then raw
 * events for the rest, or hourly rollups where raw events have expired
 **/
var bucketedSeries = async (name, from, to, seconds, context) => {
    const edges = rollups.edgesFor(from.getTime(), to.getTime(), seconds, context.timeZone);
    const end = edges[edges.length - 1];
    const rolled = rollups.ROLLED_NAMES.includes(name);
    const parts = [];
    let cursor = edges[0];

    const storedRes = !rolled ? undefined : seconds >= rollups.DAY ? rollups.DAY : seconds >= rollups.HOUR ? rollups.HOUR : undefined;
    // daily rollups count days in the zone they were made in
    const watermark = storedRes === rollups.DAY
        ? (context.watermarks.timeZone === context.timeZone ? context.watermarks.day : undefined)
        : storedRes === rollups.HOUR ? context.watermarks.hour : undefined;
    if (typeof watermark === 'number' && watermark > cursor) {
        const until = Math.min(watermark, end);
        parts.push(...(await rollups.stored(name, storedRes, cursor, until)).map(asPart));
        cursor = until;
    }
    if (cursor < end && rolled && (typeof context.oldestRaw === 'undefined' || cursor < context.oldestRaw)) {
        const until = Math.min(end, typeof context.oldestRaw === 'number' ? context.oldestRaw : end, context.watermarks.hour || cursor);
        if (until > cursor) {
            parts.push(...(await rollups.stored(name, rollups.HOUR, cursor, until)).map(asPart));
            cursor = until;
        }
    }
    if (cursor < end) {
        const rest = [cursor, ...edges.filter((edge) => edge > cursor)];
        parts.push(...(await rollups.bucketsFromRaw([name], rest))[name]);
    }

    const points = [];
    let next = 0;
    for (let i = 0; i + 1 < edges.length; i++) {
        const inside = [];
        while (next < parts.length && parts[next].start < edges[i + 1]) {
            if (parts[next].start >= edges[i]) {
                inside.push(parts[next]);
            }
            next++;
        }
        const point = rollups.pointOf(rollups.combine(inside, edges[i], edges[i + 1]));
        if (point) {
            points.push(point);
        }
    }
    const before = rollups.isDerived(name) ? null : pointAt(await rollups.rawValueBefore(name, from.getTime()));
    return { name, resolution: seconds, before, points, downsampled: true };
};

var seriesFor = async (name, from, to, maxPoints, resolution, context) => {
    const rawKept = typeof context.oldestRaw === 'number' && from.getTime() >= context.oldestRaw;
    if (rawKept) {
        const counted = rollups.isDerived(name) ? rollups.rawNamesFor([name]) : [name];
        const count = (await Promise.all(counted.map((each) => countRaw(each, from, to)))).reduce((a, b) => a + b, 0);
        if (count <= maxPoints) {
            return rawSeries(name, from, to);
        }
    }
    let seconds = chooseResolution(to - from, maxPoints, resolution);
    // only hourly rollups reach back past the raw events kept
    if (!rawKept && seconds < rollups.HOUR && rollups.ROLLED_NAMES.includes(name)) {
        seconds = chooseResolution(to - from, maxPoints, rollups.HOUR);
    }
    return bucketedSeries(name, from, to, seconds, context);
};

var earliestReading = async (oldestRaw) => {
    const first = await Rollup.findOne({ res: rollups.HOUR }).sort({ start: 1 }).select({ start: 1 }).lean();
    const candidates = [oldestRaw, first ? first.start.getTime() : undefined].filter((ms) => typeof ms === 'number');
    return candidates.length ? new Date(Math.min(...candidates)) : null;
};

/**
 * readings for each name between from (inclusive) and to (exclusive); defaults to the last 24
 * hours. A series has every reading as recorded when there are no more than maxPoints of them;
 * otherwise one point per bucket (time-weighted average, minimum and maximum), with buckets just
 * long enough to keep it within maxPoints and at least `resolution` seconds
 *
 * returns History
 **/
exports.getHistory = async function(names, fromText, toText, maxPoints, resolution) {
    const requested = (names || []).map((name) => name.trim()).filter((name) => name.length > 0);
    if (requested.length === 0 || requested.length > MAX_NAMES) {
        throw badRequest(`ask for between 1 and ${MAX_NAMES} names`);
    }
    const to = parseDate(toText, new Date(), 'to');
    const from = parseDate(fromText, new Date(to.getTime() - DEFAULT_WINDOW_MS), 'from');
    if (from >= to) {
        throw badRequest('from must be earlier than to');
    }
    const limit = Math.min(Math.max(maxPoints || DEFAULT_MAX_POINTS, MIN_POINTS), MAX_POINTS);

    const started = Date.now();
    const [watermarks, oldestRaw] = await Promise.all([rollups.watermarks(), rollups.oldestRaw()]);
    const context = { timeZone: settings.timeZone(), watermarks, oldestRaw };
    const [series, earliest] = await Promise.all([
        Promise.all(requested.map((name) => seriesFor(name, from, to, limit, resolution || 0, context))),
        earliestReading(oldestRaw)
    ]);
    logger.debug(`history for ${requested.join(', ')} from ${from.toISOString()} to ${to.toISOString()} at ${series.map((s) => s.resolution).join('/')}s in ${Date.now() - started}ms`);

    return { from, to, timeZone: context.timeZone, earliest, series };
};

// a temperature is current only while its pump runs: the sensor sits downstream of it
const PUMP_FOR_TEMPERATURE = { 'pool temp': 'filter', 'spa temp': 'aux14' };

/**
 * the readings a calendar may mark. Omitting names marks every water reading. Naming a pool or
 * spa temperature marks days that temperature was known while its pump ran, which is when the
 * history graph can draw it. Salt has no pump, so naming it marks days it was recorded.
 **/
var availabilityNames = (names) => {
    if (names === undefined || names === null || names === '') {
        return rollups.WATER_NAMES;
    }
    const requested = [...new Set((Array.isArray(names) ? names : String(names).split(','))
        .map((name) => name.trim())
        .filter((name) => name.length > 0))];
    if (requested.length === 0) {
        return rollups.WATER_NAMES;
    }
    const unknown = requested.filter((name) => !rollups.WATER_NAMES.includes(name));
    if (unknown.length > 0) {
        throw badRequest(`ask for ${rollups.WATER_NAMES.join(', ')}`);
    }
    return requested;
};

/**
 * days whose daily rollups show `name` known while its pump was on. A temperature holds until it
 * changes, so a day can be graphable with no new reading, and a reading taken while the pump was
 * off is not.
 **/
var graphableRollupDays = (name, from, to, limit) => {
    const pump = PUMP_FOR_TEMPERATURE[name];
    const match = { name: { $in: [name, pump] }, res: rollups.DAY };
    if (from !== undefined || to !== undefined) {
        match.start = {};
        if (from !== undefined) {
            match.start.$gte = new Date(from);
        }
        if (to !== undefined) {
            match.start.$lt = new Date(to);
        }
    }
    return Rollup.aggregate([
        { $match: match },
        { $group: {
            _id: '$start',
            known: { $max: { $cond: [{ $and: [{ $eq: ['$name', name] }, { $or: [{ $gt: ['$knownMs', 0] }, { $gt: ['$count', 0] }] }] }, 1, 0] } },
            running: { $max: { $cond: [{ $and: [{ $eq: ['$name', pump] }, { $gt: ['$max', 0] }] }, 1, 0] } },
            readings: { $sum: { $cond: [{ $eq: ['$name', name] }, '$count', 0] } }
        } },
        { $match: { known: 1, running: 1 } },
        { $sort: { _id: 1 } },
        ...(limit ? [{ $limit: limit }] : [])
    ]);
};

var remember = (counts, key, readings) => {
    counts.set(key, (counts.get(key) || 0) + Math.max(readings || 0, 1));
};

/**
 * local days in [from, to) where `name` was known at the same time its pump was on
 **/
var graphableEventDays = async (name, from, to, timeZone, firstOnly = false) => {
    const pump = PUMP_FOR_TEMPERATURE[name];
    const [tempBefore, pumpBefore, events] = await Promise.all([
        rollups.rawValueBefore(name, from),
        rollups.rawValueBefore(pump, from),
        rollups.rawEvents([name, pump], from, to)
    ]);
    const changes = [...(events[name] || []).map((event) => ({ ...event, kind: 'temp' })), ...(events[pump] || []).map((event) => ({ ...event, kind: 'pump' }))]
        .sort((a, b) => a.t - b.t || (a.kind === 'pump' ? -1 : 1));
    let temp = tempBefore && typeof tempBefore.v === 'number' ? tempBefore.v : null;
    let running = pumpBefore && typeof pumpBefore.v === 'number' ? pumpBefore.v : 0;
    let cursor = from;
    const counts = new Map();
    const cover = (upTo) => {
        if (temp !== null && running > 0 && upTo > cursor) {
            let day = tz.startOfDay(cursor, timeZone);
            while (day < upTo) {
                const next = tz.addDays(day, 1, timeZone);
                if (Math.min(upTo, next) > Math.max(cursor, day)) {
                    remember(counts, tz.dayKey(day, timeZone), 1);
                    if (firstOnly) {
                        return true;
                    }
                }
                day = next;
            }
        }
        cursor = Math.max(cursor, upTo);
        return false;
    };
    for (const change of changes) {
        if (cover(change.t)) {
            return counts;
        }
        if (change.kind === 'temp') {
            temp = typeof change.v === 'number' ? change.v : null;
        } else {
            running = typeof change.v === 'number' ? change.v : 0;
        }
    }
    cover(to);
    return counts;
};

var earliestRecorded = async (names, timeZone) => {
    const [firstDay, firstRaw] = await Promise.all([
        Rollup.findOne({ name: { $in: names }, res: rollups.DAY, count: { $gt: 0 } }).sort({ start: 1 }).select({ start: 1 }).lean(),
        Event.findOne({ eventType: 'info', 'status.name': { $in: names } }).sort({ timestamp: 1 }).select({ timestamp: 1 }).lean()
    ]);
    const firsts = [firstDay ? firstDay.start.getTime() : undefined, firstRaw ? firstRaw.timestamp.getTime() : undefined].filter((ms) => typeof ms === 'number');
    return firsts.length ? tz.dayKey(Math.min(...firsts), timeZone) : null;
};

var earliestGraphable = async (names, timeZone, dayWatermark) => {
    let earliest = null;
    const consider = (key) => {
        if (key && (earliest === null || key < earliest)) {
            earliest = key;
        }
    };
    for (const name of names) {
        const days = await graphableRollupDays(name, undefined, undefined, 1);
        if (days.length) {
            consider(tz.dayKey(days[0]._id.getTime(), timeZone));
            continue;
        }
        const hasRollups = await Rollup.exists({ name, res: rollups.DAY });
        const from = hasRollups && typeof dayWatermark === 'number' ? dayWatermark : 0;
        if (from === 0 && !await Event.exists({ 'status.name': { $in: [name, PUMP_FOR_TEMPERATURE[name]] } })) {
            continue;
        }
        const counts = await graphableEventDays(name, from, Date.now(), timeZone, true);
        for (const key of counts.keys()) {
            consider(key);
        }
    }
    return earliest;
};

/**
 * which local days between from and to have the named readings, or pool or spa temperature or
 * salt when no names are given; air temperature doesn't count. Defaults to the year before to.
 *
 * returns HistoryAvailability
 **/
exports.getAvailability = async function(fromText, toText, names) {
    const requested = availabilityNames(names);
    const to = parseDate(toText, new Date(), 'to');
    const from = parseDate(fromText, new Date(to.getTime() - 366 * tz.DAY_MS), 'from');
    if (from >= to) {
        throw badRequest('from must be earlier than to');
    }
    if (to - from > MAX_AVAILABILITY_DAYS * tz.DAY_MS) {
        throw badRequest(`ask for at most ${MAX_AVAILABILITY_DAYS} days at a time`);
    }
    const timeZone = settings.timeZone();
    const start = tz.startOfDay(from.getTime(), timeZone);
    const end = to.getTime();
    const watermarks = await rollups.watermarks();
    const counts = new Map();
    // salt, and a request that mixes it with the temperatures, marks days a reading was stored.
    // a pool or spa calendar marks days the graph can draw: the temperature was known while that pump ran
    const graphable = requested.every((name) => PUMP_FOR_TEMPERATURE[name]) ? requested : [];
    const recorded = graphable.length ? [] : requested;

    // days the rollups job has finished, from their daily rollups
    const storedUntil = watermarks.timeZone === timeZone && typeof watermarks.day === 'number' ? Math.min(watermarks.day, end) : start;
    if (storedUntil > start && recorded.length) {
        const days = await Rollup.aggregate([
            { $match: { name: { $in: recorded }, res: rollups.DAY, start: { $gte: new Date(start), $lt: new Date(storedUntil) }, count: { $gt: 0 } } },
            { $group: { _id: '$start', readings: { $sum: '$count' } } }
        ]);
        for (const day of days) {
            remember(counts, tz.dayKey(day._id.getTime(), timeZone), day.readings);
        }
    }
    for (const name of graphable) {
        if (storedUntil <= start) {
            continue;
        }
        const days = await graphableRollupDays(name, start, storedUntil);
        for (const day of days) {
            remember(counts, tz.dayKey(day._id.getTime(), timeZone), day.readings);
        }
    }
    // the rest, normally just today, from raw events
    const rawFrom = Math.max(storedUntil, start);
    if (rawFrom < end && recorded.length) {
        const docs = await Event.find({ eventType: 'info', 'status.name': { $in: recorded }, timestamp: { $gte: new Date(rawFrom), $lt: to } })
            .select({ timestamp: 1, status: 1 })
            .lean();
        for (const doc of docs) {
            const readings = doc.status.filter((entry) => recorded.includes(entry.name)).length;
            remember(counts, tz.dayKey(doc.timestamp.getTime(), timeZone), readings);
        }
    }
    for (const name of graphable) {
        if (rawFrom >= end) {
            continue;
        }
        const days = await graphableEventDays(name, rawFrom, end, timeZone);
        for (const [key, readings] of days) {
            remember(counts, key, readings);
        }
    }

    const earliest = graphable.length
        ? await earliestGraphable(graphable, timeZone, watermarks.timeZone === timeZone ? watermarks.day : undefined)
        : null;
    const recordedEarliest = recorded.length ? await earliestRecorded(recorded, timeZone) : null;

    return {
        timeZone,
        from,
        to,
        earliest: [earliest, recordedEarliest].filter(Boolean).sort()[0] || null,
        days: [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, readings]) => ({ date, readings }))
    };
};

exports.RESOLUTIONS = RESOLUTIONS;
exports.chooseResolution = chooseResolution;
