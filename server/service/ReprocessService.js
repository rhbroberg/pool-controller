'use strict';
// Reads stored frames again with the server's current protocol code and stores what it makes of
// them now, as when a parser fix recovers frames that were stored as failures. Readings and
// switches are stored only when they change, so events are replayed in time order from the state
// history held when the range opens. Events of the chosen types are rewritten from their raw
// frames; the others stay as they are and only carry the state forward. A frame that now changes
// nothing is removed, as the server would never have stored it; one the server can't identify is
// kept as unrecognized, so its bytes stay for working out what it is.

var { Event } = require('../models/event');
const { EventFactory } = require('../protocol/eventfactory');
const { FrameInterpreter, HEATER_MODE } = require('../protocol/interpreter');
const { framesIn } = require('../protocol/parse');
const { statusMap } = require('../protocol/events');
const rollups = require('./RollupService');
const scheduler = require('../jobs/scheduler');
const activity = require('./ActivityService');
var utils = require('../utils/writer.js');
const log4js = require('log4js');
var logger = log4js.getLogger();

// the kinds of event made from controller frames; actions come from accounts and have none
const EVENT_TYPES = ['info', 'status', 'control', 'failed', 'unrecognized'];
const READINGS = ['pool temp', 'spa temp', 'salt', 'ambient'];
const WRITE_BATCH = 1000;
const PROGRESS_EVERY = 2000;

var badRequest = (message) => utils.respondWithCode(400, { code: 400, message });

// the latest run, kept until the next one starts
var latest = null;

var parseDate = (text, label) => {
    const date = new Date(text);
    if (typeof text !== 'string' || isNaN(date.getTime())) {
        throw badRequest(`${label} is not a date: ${text}`);
    }
    return date;
};

var chosenTypes = (eventTypes) => {
    if (eventTypes === undefined || eventTypes === null || (Array.isArray(eventTypes) && eventTypes.length === 0)) {
        return EVENT_TYPES;
    }
    const list = [...new Set((Array.isArray(eventTypes) ? eventTypes : String(eventTypes).split(','))
        .map((type) => String(type).trim())
        .filter((type) => type.length > 0))];
    const unknown = list.filter((type) => !EVENT_TYPES.includes(type));
    if (unknown.length > 0 || list.length === 0) {
        throw badRequest(`event types are ${EVENT_TYPES.join(', ')}`);
    }
    return list;
};

var statusKey = (status) => (status || []).map((entry) => `${entry.name}=${entry.value}`).sort().join('|');

var asBuffer = (raw) => {
    if (!raw) {
        return null;
    }
    if (Buffer.isBuffer(raw)) {
        return raw;
    }
    if (raw.buffer && Buffer.isBuffer(raw.buffer)) {
        return raw.buffer;
    }
    return Buffer.from(raw.buffer || raw);
};

/**
 * what the server makes of a stored frame now: { eventType, status }, with message when the panel
 * gave a new reason to check the system, or null when it changes nothing; undefined when the bytes
 * hold no whole frame, which leaves the event alone
 **/
var reinterpret = (raw, factory, interpreter) => {
    const bytes = asBuffer(raw);
    const frames = bytes ? framesIn(bytes) : [];
    if (frames.length === 0) {
        return undefined;
    }
    let result = null;
    for (const { frame } of frames) {
        let event;
        try {
            event = factory.create(frame);
        } catch {
            // the checksum still doesn't match
            result = result || { eventType: 'failed', status: [] };
            continue;
        }
        if (!event) {
            result = result || { eventType: 'unrecognized', status: [] };
            continue;
        }
        const stored = interpreter.interpret(event);
        if (stored) {
            const message = (result && result.message) || stored.message;
            result = result && result.status.length
                ? { eventType: result.eventType, status: result.status.concat(stored.status) }
                : { eventType: stored.eventType, status: stored.status };
            if (message) {
                result.message = message;
            }
        }
    }
    return result;
};

/**
 * the state history held as `from` opens: each reading's last value, the switches last on and the
 * heater's mode
 **/
var stateBefore = async (from) => {
    // only stored events: an hourly summary can reach past from, into what is being reprocessed
    const last = async (eventType, name) => {
        const doc = await Event.findOne({ eventType, 'status.name': name, timestamp: { $lt: from } })
            .sort({ timestamp: -1 }).select({ status: 1 }).lean();
        const entry = doc && doc.status.find((each) => each.name === name);
        return entry && typeof entry.value === 'number' ? entry.value : undefined;
    };
    const switchNames = statusMap.flat();
    const [readings, switches, heaterAuto] = await Promise.all([
        Promise.all(READINGS.map((name) => last('info', name))),
        Promise.all(switchNames.map((name) => last('status', name))),
        last('info', HEATER_MODE)
    ]);
    return {
        readings: Object.fromEntries(READINGS.map((name, index) => [name, readings[index]])),
        switchesOn: switchNames.filter((name, index) => switches[index] === 1),
        heaterAuto
    };
};

// each kind has an index on eventType then timestamp; sorting kinds together has none, and the raw
// frames don't fit in MongoDB's in-memory sort
var cursorFor = (eventType, from, to, withRaw) => Event.find({ eventType, timestamp: { $gte: from, $lt: to } })
    .sort({ timestamp: 1 })
    .hint('eventType_timestamp')
    .select(withRaw ? { timestamp: 1, eventType: 1, status: 1, message: 1, raw: 1 } : { timestamp: 1, eventType: 1, status: 1, message: 1 })
    .lean()
    .cursor({ batchSize: 1000 });

// at one time, readings before the frames they might repeat
const ORDER = ['info', 'status', 'control', 'failed', 'unrecognized'];

var replay = async (run) => {
    const { from, to, eventTypes, dryRun } = run;
    const interpreter = new FrameInterpreter();
    interpreter.seed(await stateBefore(from));
    const factory = new EventFactory();

    // unchosen readings and switches still carry the state; other unchosen kinds change nothing
    const walked = ORDER.filter((type) => eventTypes.includes(type) || type === 'info' || type === 'status');
    const cursors = walked.map((type) => ({ type, cursor: cursorFor(type, from, to, eventTypes.includes(type)) }));
    const heads = await Promise.all(cursors.map((each) => each.cursor.next()));

    // an event that changes kind can come round again on its new kind's cursor
    const rewritten = new Set();
    let updates = [];
    let removals = [];
    const flush = async (force) => {
        if (dryRun) {
            updates = [];
            removals = [];
            return;
        }
        if (updates.length && (force || updates.length >= WRITE_BATCH)) {
            await Event.bulkWrite(updates, { ordered: false });
            updates = [];
        }
        if (removals.length && (force || removals.length >= WRITE_BATCH)) {
            await Event.deleteMany({ _id: { $in: removals } });
            removals = [];
        }
    };

    const transition = (before, after) => {
        const key = `${before}>${after}`;
        run.transitions[key] = (run.transitions[key] || 0) + 1;
    };

    for (;;) {
        let next = -1;
        heads.forEach((doc, index) => {
            if (doc && (next < 0 || doc.timestamp < heads[next].timestamp)) {
                next = index;
            }
        });
        if (next < 0) {
            break;
        }
        const doc = heads[next];
        heads[next] = await cursors[next].cursor.next();
        const id = String(doc._id);
        if (rewritten.has(id)) {
            continue;
        }

        run.scanned++;
        if (run.scanned % PROGRESS_EVERY === 0) {
            run.through = doc.timestamp;
        }
        if (!eventTypes.includes(doc.eventType)) {
            interpreter.adopt(doc.eventType, doc.status, doc.message);
            continue;
        }

        run.examined++;
        const result = reinterpret(doc.raw, factory, interpreter);
        if (result === undefined) {
            run.unreadable++;
        } else if (result === null) {
            run.removed++;
            transition(doc.eventType, 'removed');
            removals.push(doc._id);
        } else if (result.eventType === doc.eventType && statusKey(result.status) === statusKey(doc.status) && (result.message || null) === (doc.message || null)) {
            run.unchanged++;
        } else {
            run.updated++;
            transition(doc.eventType, result.eventType);
            if (result.eventType !== doc.eventType) {
                rewritten.add(id);
            }
            const update = result.message
                ? { $set: { eventType: result.eventType, status: result.status, message: result.message } }
                : { $set: { eventType: result.eventType, status: result.status }, $unset: { message: '' } };
            updates.push({ updateOne: { filter: { _id: doc._id }, update } });
        }
        await flush(false);
    }
    await flush(true);
    await Promise.all(cursors.map((each) => each.cursor.close()));
};

var describe = (run) => run && {
    state: run.state,
    from: run.from,
    to: run.to,
    eventTypes: run.eventTypes,
    dryRun: run.dryRun,
    requestedBy: run.requestedBy,
    requestedAt: run.requestedAt,
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
    through: run.through || null,
    scanned: run.scanned,
    examined: run.examined,
    unchanged: run.unchanged,
    updated: run.updated,
    removed: run.removed,
    unreadable: run.unreadable,
    transitions: Object.entries(run.transitions)
        .map(([key, count]) => {
            const [before, after] = key.split('>');
            return { from: before, to: after, count };
        })
        .sort((a, b) => b.count - a.count),
    error: run.error || null
};

var execute = async (run, user) => {
    run.state = 'running';
    run.startedAt = new Date();
    try {
        await replay(run);
        if (!run.dryRun && (run.updated > 0 || run.removed > 0)) {
            // the summaries hold values until they change, so everything after the range can move too
            await rollups.invalidateFrom(run.from);
            scheduler.runNow(rollups.ROLLUPS_JOB, 'reprocessed history').catch((e) => logger.error(`rollups after reprocessing: ${e.message}`));
        }
        run.state = 'finished';
        const summary = `${run.examined} events from ${run.from.toISOString()} to ${run.to.toISOString()} (${run.eventTypes.join(', ')}): ${run.updated} rewritten, ${run.removed} removed, ${run.unchanged} unchanged`;
        logger.info(`${run.dryRun ? 'previewed reprocessing' : 'reprocessed'} ${summary}`);
        if (!run.dryRun) {
            await activity.record(user, `Reprocessed history: ${summary}`);
        }
    } catch (e) {
        run.state = 'failed';
        run.error = e.message;
        logger.error(`reprocessing history failed: ${e.stack || e.message}`);
    } finally {
        run.finishedAt = new Date();
        run.through = run.to;
    }
};

/**
 * starts reprocessing events from `from` (inclusive) to `to` (exclusive) of the given kinds, all of
 * them by default; with dryRun, only counts what would change. Answers at once with the run, which
 * goes on in the job queue
 **/
exports.start = async function({ from, to, eventTypes, dryRun } = {}, user) {
    if (latest && (latest.state === 'waiting' || latest.state === 'running')) {
        throw utils.respondWithCode(409, { code: 409, message: 'history is already being reprocessed; wait for it to finish' });
    }
    const start = parseDate(from, 'from');
    const end = new Date(Math.min(parseDate(to, 'to').getTime(), Date.now()));
    if (start >= end) {
        throw badRequest('from must be earlier than to, and earlier than now');
    }
    latest = {
        state: 'waiting',
        from: start,
        to: end,
        eventTypes: chosenTypes(eventTypes),
        dryRun: dryRun === true,
        requestedBy: user && user.email ? user.email : null,
        requestedAt: new Date(),
        scanned: 0,
        examined: 0,
        unchanged: 0,
        updated: 0,
        removed: 0,
        unreadable: 0,
        transitions: {}
    };
    const run = latest;
    scheduler.exclusive(() => execute(run, user));
    return describe(run);
};

/**
 * the run under way, or the last one; null before any
 **/
exports.status = async function() {
    return describe(latest);
};

exports.EVENT_TYPES = EVENT_TYPES;
exports.reinterpret = reinterpret;
