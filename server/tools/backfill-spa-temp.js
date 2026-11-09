'use strict';
// The server parsed "Spa Temp" off the panel from 2018 on, but did not store it until November
// 2026. The text is still in the raw frames: info events (the pool-and-spa screen) and failed
// events (the wireless spa screen, header 04 0a, which the parser never recognized). This writes
// the missing spa temp readings the way the server stores pool temp: only when the value changes,
// dropping a one-degree bounce back to the previous reading. Info frames gain a status entry.
// A change that exists only on a failed frame becomes a new info event, and the failed frame stays.
// Hourly and daily spa temp rollups are then filled up to where the rollups job has already got,
// without redoing the other series.
//
//   MONGODB_URI=mongodb://host:27017/Mystic node tools/backfill-spa-temp.js           show what would change
//   MONGODB_URI=mongodb://host:27017/Mystic node tools/backfill-spa-temp.js --write   write it
require('../config/config');
const log4js = require('log4js');
log4js.getLogger().level = 'warn';
const { MongoClient, ObjectId } = require('mongodb');
var { mongoose } = require('../mongoose');
var { Event } = require('../models/event');
var { JobState } = require('../models/jobState');
const rollups = require('../service/RollupService');
const tz = require('../utils/timezone');

// the same pattern as DisplayUpdateEvent.getSpaTemp
const SPA_TEMP = / +Spa Temp +(\d+)_F/;
const NAME = 'spa temp';
const BATCH = 1000;

const uri = process.env.MONGODB_URI;
const write = process.argv.includes('--write');

var asBuffer = (raw) => {
    if (!raw) {
        return Buffer.alloc(0);
    }
    if (Buffer.isBuffer(raw)) {
        return raw;
    }
    if (typeof raw.value === 'function') {
        return Buffer.from(raw.value());
    }
    return Buffer.from(raw.buffer || raw);
};

var spaTempOf = (raw) => {
    const text = asBuffer(raw).toString('ascii', 4);
    const match = text.match(SPA_TEMP);
    return match ? Number(match[1]) : undefined;
};

var reading = (status, name) => (status || []).find((entry) => entry.name === name);

// present and previous follow server.js addIfChanged, including its one-degree hysteresis
var decide = (state, value) => {
    if (!value) {
        return false;
    }
    let record = false;
    if (state.present !== value) {
        const flicker = typeof state.previous !== 'undefined' && value === state.previous && Math.abs(state.present - value) === 1;
        if (flicker) {
            state.flickers++;
        } else {
            record = true;
            state.previous = state.present;
        }
    }
    state.present = value;
    return record;
};

var adopt = (state, value) => {
    state.previous = state.present;
    state.present = value;
};

// each event type has an index on eventType then timestamp; sorting the two together does not,
// and the raw frames do not fit in MongoDB's in-memory sort
var cursorFor = (events, eventType) => events.find(
    { eventType },
    { projection: { timestamp: 1, eventType: 1, status: 1, raw: 1 } }
).sort({ timestamp: 1 }).hint('eventType_timestamp');

var collect = async (events) => {
    const state = { present: undefined, previous: undefined, flickers: 0 };
    const updates = [];
    const inserts = [];
    const preview = [];
    let scanned = 0;
    let matched = 0;
    let already = 0;
    const infoCursor = cursorFor(events, 'info');
    const failedCursor = cursorFor(events, 'failed');
    let info = await infoCursor.next();
    let failed = await failedCursor.next();

    const handle = (doc) => {
        scanned++;
        if (scanned % 100000 === 0) {
            console.log(`scanned ${scanned}`);
        }
        const existing = reading(doc.status, NAME);
        if (existing && typeof existing.value === 'number') {
            adopt(state, existing.value);
            already++;
            return;
        }
        const value = spaTempOf(doc.raw);
        if (!value) {
            return;
        }
        matched++;
        if (!decide(state, value)) {
            return;
        }
        if (doc.eventType === 'info') {
            updates.push({ id: doc._id, value, timestamp: doc.timestamp });
        } else {
            inserts.push({
                _id: new ObjectId(),
                source: 'panel',
                raw: doc.raw,
                eventType: 'info',
                status: [{ _id: new ObjectId(), name: NAME, value }],
                command: [],
                timestamp: doc.timestamp,
                __v: 0
            });
        }
        if (doc.timestamp >= new Date('2021-07-06T04:00:00Z') && doc.timestamp < new Date('2021-07-07T04:00:00Z')) {
            preview.push(`${doc.timestamp.toISOString()} ${value}°F from ${doc.eventType}`);
        }
    };

    // info before failed at one timestamp, so a reading written last time is seen before its source frame
    while (info || failed) {
        const infoFirst = info && (!failed || info.timestamp <= failed.timestamp);
        if (infoFirst) {
            const doc = info;
            info = await infoCursor.next();
            handle(doc);
        } else {
            const doc = failed;
            failed = await failedCursor.next();
            handle(doc);
        }
    }
    return { state, updates, inserts, preview, scanned, matched, already };
};

var apply = async (events, plan) => {
    for (let i = 0; i < plan.updates.length; i += BATCH) {
        const batch = plan.updates.slice(i, i + BATCH);
        await events.bulkWrite(batch.map((update) => ({
            updateOne: {
                filter: { _id: update.id, 'status.name': { $ne: NAME } },
                update: { $push: { status: { _id: new ObjectId(), name: NAME, value: update.value } } }
            }
        })), { ordered: false });
    }
    for (let i = 0; i < plan.inserts.length; i += BATCH) {
        await events.insertMany(plan.inserts.slice(i, i + BATCH), { ordered: false });
    }
};

var edgesBetween = (start, end, step) => {
    const edges = [];
    for (let edge = start; edge <= end; edge = step(edge)) {
        edges.push(edge);
    }
    return edges;
};

var storeChunks = async (res, edges, chunk) => {
    let stored = 0;
    for (let i = 0; i + 1 < edges.length; i += chunk) {
        const slice = edges.slice(i, Math.min(edges.length, i + chunk + 1));
        const buckets = await rollups.bucketsFromRaw([NAME], slice);
        stored += await rollups.store(res, slice[0], slice[slice.length - 1], buckets);
    }
    return stored;
};

var fillRollups = async () => {
    await mongoose.connection.asPromise();
    const first = await Event.findOne({ eventType: 'info', 'status.name': NAME }).sort({ timestamp: 1 }).select({ timestamp: 1 }).lean();
    if (!first) {
        console.log('no spa temp readings to roll up');
        return;
    }
    const job = await JobState.findById(rollups.ROLLUPS_JOB).lean();
    const data = job && job.data ? job.data : {};
    const timeZone = data.timeZone || 'America/New_York';
    const hourEnd = data.hourWatermark ? new Date(data.hourWatermark).getTime() : rollups.bucketStart(Date.now(), rollups.HOUR, timeZone);
    const dayEnd = data.dayWatermark ? new Date(data.dayWatermark).getTime() : tz.startOfDay(hourEnd, timeZone);
    const hourStart = rollups.bucketStart(first.timestamp.getTime(), rollups.HOUR, timeZone);
    const dayStart = tz.startOfDay(first.timestamp.getTime(), timeZone);
    const hours = edgesBetween(hourStart, hourEnd, (edge) => edge + rollups.HOUR * 1000);
    const days = edgesBetween(dayStart, dayEnd, (edge) => tz.addDays(edge, 1, timeZone));
    const hourly = await storeChunks(rollups.HOUR, hours, 24 * 60);
    const daily = await storeChunks(rollups.DAY, days, 400);
    console.log(`rollups in ${timeZone}: ${hourly} hourly through ${new Date(hourEnd).toISOString()}, ${daily} daily through ${new Date(dayEnd).toISOString()}`);
};

(async () => {
    if (!uri) {
        throw new Error('set MONGODB_URI');
    }
    const client = new MongoClient(uri);
    await client.connect();
    const events = client.db().collection('events');
    const plan = await collect(events);
    const first = plan.updates[0] || plan.inserts[0];
    const last = plan.updates[plan.updates.length - 1] || plan.inserts[plan.inserts.length - 1];
    console.log(`scanned ${plan.scanned} frames; ${plan.matched} carried a spa temperature; ${plan.already} already stored`);
    console.log(`record ${plan.updates.length} on existing info events and ${plan.inserts.length} new info events; ${plan.state.flickers} one-degree bounces dropped`);
    if (first) {
        console.log(`first ${first.timestamp.toISOString()} last ${(last.timestamp).toISOString()}`);
    }
    console.log('2021-07-06:');
    plan.preview.forEach((line) => console.log(`  ${line}`));
    if (!write) {
        console.log('dry run; pass --write to update the database');
        await client.close();
        return;
    }
    await apply(events, plan);
    await client.close();
    console.log('wrote the readings');
    await fillRollups();
})()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.connection.close();
        process.exit(process.exitCode || 0);
    });
