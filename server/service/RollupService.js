'use strict';
// Summaries of readings over fixed buckets of time. Readings are stored only when they change,
// so a value holds until the next one: each bucket's average is weighted by how long each value
// was in effect, starting from the value carried in. The same math serves the rollups job,
// which stores hourly and daily buckets, and history requests, which bucket recent raw events
// on the fly. Everything here works on MongoDB 4.4.

var { Event } = require('../models/event');
var { Rollup } = require('../models/rollup');
var { JobState } = require('../models/jobState');
const tz = require('../utils/timezone');

const HOUR = 3600;
const DAY = 86400;
const INFO_NAMES = ['pool temp', 'spa temp', 'ambient', 'salt', 'heater1 mode'];
// a day "has data" when any of these was recorded; air temperature doesn't count
const WATER_NAMES = ['pool temp', 'spa temp', 'salt'];
const CIRCULATION = ['filter', 'aux14', 'spa', 'spillover'];
const HEAT_SOURCES = ['heater1', 'valve4'];
const BODIES = ['pool', 'spa'];
// heating:<body>:<source> is 1 while that source was warming that body
const HEATING_NAMES = BODIES.flatMap((body) => HEAT_SOURCES.map((source) => `heating:${body}:${source}`));
// what the history graphs draw; anything else is bucketed from raw events while they last
const ROLLED_NAMES = ['pool temp', 'spa temp', 'ambient', 'salt', 'filter', 'aux14', 'spa', 'spillover', 'heater1', 'valve4', ...HEATING_NAMES];
const ROLLUPS_JOB = 'rollups';

var isDerived = (name) => HEATING_NAMES.includes(name);
var eventTypeOf = (name) => (INFO_NAMES.includes(name) ? 'info' : 'status');
var unique = (values) => [...new Set(values)];
var componentsOf = (name) => [name.split(':')[2], ...CIRCULATION];
var rawNamesFor = (names) => unique(names.flatMap((name) => (isDerived(name) ? componentsOf(name) : [name])));

// MARK: the bucket grid

/**
 * the start of the bucket of `seconds` holding ms: on multiples of `seconds` since the epoch for
 * buckets shorter than a day, and on local midnights, counted from 1970-01-01, for days
 **/
var bucketStart = (ms, seconds, timeZone) => {
    if (seconds < DAY) {
        return Math.floor(ms / (seconds * 1000)) * seconds * 1000;
    }
    const days = Math.round(seconds / DAY);
    const dayStart = tz.startOfDay(ms, timeZone);
    const offset = ((tz.dayNumber(dayStart, timeZone) % days) + days) % days;
    return offset === 0 ? dayStart : tz.addDays(dayStart, -offset, timeZone);
};

var nextBucket = (start, seconds, timeZone) => (seconds < DAY ? start + seconds * 1000 : tz.addDays(start, Math.round(seconds / DAY), timeZone));

/**
 * the edges of the buckets covering [from, to): the first starts at or before from, the last
 * ends at or after to
 **/
var edgesFor = (from, to, seconds, timeZone) => {
    const edges = [bucketStart(from, seconds, timeZone)];
    while (edges[edges.length - 1] < to) {
        edges.push(nextBucket(edges[edges.length - 1], seconds, timeZone));
    }
    if (edges.length === 1) {
        edges.push(nextBucket(edges[0], seconds, timeZone));
    }
    return edges;
};

// MARK: the math

var emptyBucket = (start, end) => ({ start, end, count: 0, min: null, max: null, sum: 0, knownMs: 0, last: null });

var note = (bucket, value) => {
    bucket.min = bucket.min === null ? value : Math.min(bucket.min, value);
    bucket.max = bucket.max === null ? value : Math.max(bucket.max, value);
};

/**
 * summarizes one reading over the buckets between consecutive edges, given the value in effect
 * before the first event and the events [{ t, v }] in time order; time after `until` (now)
 * isn't counted, since nothing is known about it yet
 **/
var summarize = (initial, events, edges, until = Infinity) => {
    const buckets = [];
    let value = typeof initial === 'number' ? initial : null;
    let next = 0;
    while (next < events.length && events[next].t < edges[0]) {
        value = events[next].v;
        next++;
    }
    for (let i = 0; i + 1 < edges.length; i++) {
        const bucket = emptyBucket(edges[i], edges[i + 1]);
        let cursor = bucket.start;
        const hold = (upTo) => {
            const stop = Math.min(upTo, until);
            if (value !== null && stop > cursor) {
                bucket.sum += value * (stop - cursor);
                bucket.knownMs += stop - cursor;
                note(bucket, value);
            }
            cursor = Math.max(cursor, upTo);
        };
        while (next < events.length && events[next].t < bucket.end) {
            hold(events[next].t);
            value = typeof events[next].v === 'number' ? events[next].v : null;
            bucket.count++;
            if (value !== null) {
                note(bucket, value);
            }
            next++;
        }
        hold(bucket.end);
        bucket.last = value;
        buckets.push(bucket);
    }
    return buckets;
};

/**
 * one bucket from consecutive smaller ones, such as a day from its hours
 **/
var combine = (parts, start, end) => {
    const bucket = emptyBucket(start, end);
    for (const part of parts) {
        bucket.count += part.count || 0;
        bucket.sum += part.sum || 0;
        bucket.knownMs += part.knownMs || 0;
        if (part.min !== null && typeof part.min !== 'undefined') {
            note(bucket, part.min);
            note(bucket, part.max);
        }
        if (part.last !== null && typeof part.last !== 'undefined') {
            bucket.last = part.last;
        }
    }
    return bucket;
};

/**
 * the point a history response gives for a bucket, or undefined when nothing was known in it
 **/
var pointOf = (bucket) => {
    if (bucket.knownMs <= 0 && bucket.count === 0) {
        return undefined;
    }
    const average = bucket.knownMs > 0 ? bucket.sum / bucket.knownMs : bucket.last;
    if (average === null || typeof average === 'undefined') {
        return undefined;
    }
    return { t: new Date(bucket.start), v: Math.round(average * 100) / 100, min: bucket.min, max: bucket.max };
};

// MARK: heating, derived from the switches

// heat reaches the water only while a pump (the filter or the spa filter) moves it through the
// heaters, as in protocol/heating.js; then both bodies in spillover, otherwise the spa while
// water flows through it (spa mode or the spa filter), and the pool the rest of the time
var heats = (state, body) => {
    if (state.filter !== 1 && state.aux14 !== 1) {
        return false;
    }
    if (state.spillover === 1) {
        return true;
    }
    const toSpa = state.spa === 1 || state.aux14 === 1;
    return body === 'spa' ? toSpa : !toSpa;
};

var heatingValue = (name, state) => {
    const [, body, source] = name.split(':');
    if (state[source] === null || typeof state[source] === 'undefined') {
        return null;
    }
    return state[source] === 1 && heats(state, body) ? 1 : 0;
};

/**
 * a derived heating series from its switches: the value as the window opens and every change
 **/
var derive = (name, initials, eventsByName) => {
    const state = {};
    for (const component of componentsOf(name)) {
        state[component] = typeof initials[component] === 'number' ? initials[component] : null;
    }
    const initial = heatingValue(name, state);
    const changes = componentsOf(name)
        .flatMap((component) => (eventsByName[component] || []).map((event) => ({ t: event.t, name: component, v: event.v })))
        .sort((a, b) => a.t - b.t);
    const events = [];
    let current = initial;
    for (const change of changes) {
        state[change.name] = change.v;
        const value = heatingValue(name, state);
        if (value !== current) {
            events.push({ t: change.t, v: value });
            current = value;
        }
    }
    return { initial, events };
};

// MARK: reading raw events

/**
 * the value of a raw reading in effect just before ms: its last event, or once those have
 * expired, the value its latest hourly rollup ended on
 **/
var rawValueBefore = async (name, ms) => {
    const doc = await Event.findOne({ eventType: eventTypeOf(name), 'status.name': name, timestamp: { $lt: new Date(ms) } })
        .sort({ timestamp: -1 })
        .select({ timestamp: 1, status: 1 })
        .lean();
    if (doc) {
        const entry = doc.status.find((reading) => reading.name === name);
        return { t: doc.timestamp.getTime(), v: entry && typeof entry.value === 'number' ? entry.value : null };
    }
    const rollup = await Rollup.findOne({ name, res: HOUR, start: { $lt: new Date(ms) } }).sort({ start: -1 }).lean();
    return rollup && typeof rollup.last === 'number' ? { t: Math.min(rollup.end.getTime(), ms), v: rollup.last } : undefined;
};

/**
 * every event for the raw names in [from, to), by name, in time order
 **/
var rawEvents = async (names, from, to) => {
    const byName = Object.fromEntries(names.map((name) => [name, []]));
    const types = unique(names.map(eventTypeOf));
    const docs = await Event.find({ eventType: { $in: types }, 'status.name': { $in: names }, timestamp: { $gte: new Date(from), $lt: new Date(to) } })
        .sort({ timestamp: 1 })
        .select({ timestamp: 1, status: 1 })
        .lean();
    for (const doc of docs) {
        for (const entry of doc.status || []) {
            if (byName[entry.name]) {
                byName[entry.name].push({ t: doc.timestamp.getTime(), v: typeof entry.value === 'number' ? entry.value : null });
            }
        }
    }
    return byName;
};

/**
 * the value in effect before ms and every change in [ms, to) for each name, derived heating
 * series included
 **/
var timelines = async (names, from, to) => {
    const raw = rawNamesFor(names);
    const [befores, eventsByName] = await Promise.all([
        Promise.all(raw.map((name) => rawValueBefore(name, from))),
        rawEvents(raw, from, to)
    ]);
    const initials = {};
    raw.forEach((name, index) => {
        initials[name] = befores[index] ? befores[index].v : null;
    });
    const result = {};
    for (const name of names) {
        result[name] = isDerived(name)
            ? derive(name, initials, eventsByName)
            : { initial: initials[name], events: eventsByName[name] || [] };
    }
    return result;
};

/**
 * each name summarized over the buckets between edges, from raw events
 **/
var bucketsFromRaw = async (names, edges, until = Date.now()) => {
    const lines = await timelines(names, edges[0], edges[edges.length - 1]);
    const result = {};
    for (const name of names) {
        result[name] = summarize(lines[name].initial, lines[name].events, edges, until);
    }
    return result;
};

/**
 * the oldest info or status event still kept, in milliseconds
 **/
var oldestRaw = async () => {
    const doc = await Event.findOne({ eventType: { $in: ['info', 'status'] } }).sort({ timestamp: 1 }).select({ timestamp: 1 }).lean();
    return doc ? doc.timestamp.getTime() : undefined;
};

// MARK: stored rollups

var docsFor = (res, bucketsByName) => {
    const docs = [];
    for (const [name, buckets] of Object.entries(bucketsByName)) {
        for (const bucket of buckets) {
            if (bucket.knownMs > 0 || bucket.count > 0) {
                docs.push({ name, res, start: new Date(bucket.start), end: new Date(bucket.end), count: bucket.count, min: bucket.min, max: bucket.max, sum: bucket.sum, knownMs: bucket.knownMs, last: bucket.last });
            }
        }
    }
    return docs;
};

/**
 * replaces the stored buckets of `res` between from and to
 **/
var store = async (res, from, to, bucketsByName) => {
    await Rollup.deleteMany({ res, name: { $in: Object.keys(bucketsByName) }, start: { $gte: new Date(from), $lt: new Date(to) } });
    const docs = docsFor(res, bucketsByName);
    if (docs.length > 0) {
        await Rollup.insertMany(docs, { ordered: false });
    }
    return docs.length;
};

/**
 * stored buckets of one name at one resolution with starts in [from, to), oldest first
 **/
var stored = (name, res, from, to) => Rollup.find({ name, res, start: { $gte: new Date(from), $lt: new Date(to) } })
    .sort({ start: 1 })
    .lean();

/**
 * daily buckets from the hourly ones, for days whose raw events have already expired
 **/
var daysFromHours = async (names, edges) => {
    const result = {};
    for (const name of names) {
        const hours = await stored(name, HOUR, edges[0], edges[edges.length - 1]);
        result[name] = [];
        for (let i = 0; i + 1 < edges.length; i++) {
            const inside = hours.filter((hour) => hour.start.getTime() >= edges[i] && hour.start.getTime() < edges[i + 1]);
            result[name].push(combine(inside, edges[i], edges[i + 1]));
        }
    }
    return result;
};

// MARK: the rollups job's progress

/**
 * how far hourly and daily rollups have got: buckets before these are stored
 **/
var watermarks = async () => {
    const state = await JobState.findById(ROLLUPS_JOB).select({ data: 1 }).lean();
    const data = state && state.data ? state.data : {};
    return {
        hour: data.hourWatermark ? new Date(data.hourWatermark).getTime() : undefined,
        day: data.dayWatermark ? new Date(data.dayWatermark).getTime() : undefined,
        timeZone: data.timeZone
    };
};

/**
 * makes the rollups job recompute everything from `date` on, as after history is added or
 * removed in the past
 **/
var invalidateFrom = async (date) => {
    await JobState.updateOne({ _id: ROLLUPS_JOB }, { $min: { 'data.rebuildFrom': new Date(date) } }, { upsert: true });
};

module.exports = {
    HOUR,
    DAY,
    INFO_NAMES,
    WATER_NAMES,
    HEATING_NAMES,
    ROLLED_NAMES,
    ROLLUPS_JOB,
    isDerived,
    eventTypeOf,
    rawNamesFor,
    bucketStart,
    nextBucket,
    edgesFor,
    summarize,
    combine,
    pointOf,
    derive,
    rawValueBefore,
    rawEvents,
    timelines,
    bucketsFromRaw,
    oldestRaw,
    store,
    stored,
    daysFromHours,
    watermarks,
    invalidateFrom
};
