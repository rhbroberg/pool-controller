'use strict';
// Learns how long each body of water takes to warm, from the history of what the pump, heater and
// heat pump did and what the water and air temperatures did meanwhile.
//
// The work is in three steps, each its own request, so an admin can look before anything is kept:
//
//   scan     reads a range of stored history and finds the windows it could learn from (the
//            WindowExtractor), a few minutes of work that goes on after the request answers
//   preview  fits a model to the windows left ticked, and shows it beside the model in use
//   save     keeps exactly what was previewed as the model every estimate uses from then on
//
// Raw events are removed after the retention period, so a scan can only see what is still held;
// a saved model stays whatever happens to the history it came from.

var { Event } = require('../models/event');
var { HeatingModel } = require('../models/heatingModel');
const { WindowExtractor, SWITCHES, SERIES, AIR, SOURCES } = require('../heating/windows');
const { fitBody } = require('../heating/fit');
const { timeToReach } = require('../heating/estimate');
const sun = require('../heating/sun');
const settings = require('./SettingsService');
const scheduler = require('../jobs/scheduler');
const activity = require('./ActivityService');
var utils = require('../utils/writer.js');
const crypto = require('crypto');
const log4js = require('log4js');
var logger = log4js.getLogger();

// history from this time on was produced by the simulator, not a pool
const SIMULATED_FROM = new Date('2026-01-01T00:00:00Z');
const BODIES = ['pool', 'spa'];
const PROGRESS_EVERY = 5000;
const KEEP_PREVIEWS = 5;
const PREVIEW_LIFE_MS = 60 * 60 * 1000;

// what the preview shows each model doing, so the numbers mean something: warm this far, at these airs
const SAMPLE_SETPOINT = { pool: 84, spa: 102 };
const SAMPLE_DEGREES_BELOW = 10;
const SAMPLE_AIRS = [50, 65, 80];
const SAMPLE_SUN = 0.5;

var activeModel = null;
var latestScan = null;
var previews = new Map();
var listeners = [];

var badRequest = (message) => utils.respondWithCode(400, { code: 400, message });
var notFound = (message) => utils.respondWithCode(404, { code: 404, message });

var parseDate = (text, label) => {
    const date = new Date(text);
    if (typeof text !== 'string' || isNaN(date.getTime())) {
        throw badRequest(`${label} is not a date: ${text}`);
    }
    return date;
};

/** listener() runs after a model is saved or removed */
exports.onChange = function(listener) {
    listeners.push(listener);
};

var publicModel = (doc) => doc && {
    id: String(doc._id),
    createdAt: doc.createdAt,
    createdBy: doc.createdBy || null,
    range: doc.range,
    timeZone: doc.timeZone || null,
    bodies: doc.bodies
};

/**
 * reads the model in use; run at startup and after a factory reset
 **/
exports.load = async function() {
    previews.clear();
    latestScan = null;
    const doc = await HeatingModel.findOne({ active: true }).sort({ createdAt: -1 }).select({ windowsUsed: 0 }).lean();
    activeModel = doc || null;
    if (activeModel) {
        const available = BODIES.filter((body) => activeModel.bodies && activeModel.bodies[body] && activeModel.bodies[body].available);
        logger.info(`heating model from ${new Date(activeModel.createdAt).toISOString()} for ${available.join(', ') || 'no body of water'}`);
    }
};

/**
 * the model in use (as stored: { createdAt, timeZone, bodies: { pool, spa } }), or null
 **/
exports.model = function() {
    return activeModel;
};

/**
 * the range a scan covers by default: all of history up to the point the simulator started
 * writing its own
 **/
var defaultRange = async () => {
    const first = await Event.findOne({ eventType: 'info' }).sort({ timestamp: 1 }).select({ timestamp: 1 }).lean();
    const from = first ? first.timestamp : SIMULATED_FROM;
    return { from, to: new Date(Math.min(Date.now(), SIMULATED_FROM.getTime())) };
};

/**
 * the model in use with the range a scan covers by default
 *
 * returns HeatingModelState
 **/
exports.getModel = async function() {
    return { model: publicModel(activeModel), defaultRange: await defaultRange() };
};

/** the state the scan starts from: the last each switch and reading had before `from` */
var stateBefore = async (from) => {
    const last = async (eventType, name) => {
        const doc = await Event.findOne({ eventType, 'status.name': name, timestamp: { $lt: from } })
            .sort({ timestamp: -1 }).select({ status: 1 }).lean();
        const entry = doc && doc.status.find((each) => each.name === name);
        return entry && typeof entry.value === 'number' ? entry.value : undefined;
    };
    const readingNames = [...Object.values(SERIES), AIR];
    const [switches, readings] = await Promise.all([
        Promise.all(SWITCHES.map((name) => last('status', name))),
        Promise.all(readingNames.map((name) => last('info', name)))
    ]);
    return {
        t: from.getTime(),
        switches: Object.fromEntries(SWITCHES.map((name, index) => [name, switches[index] === 1 ? 1 : 0])),
        readings: Object.fromEntries(readingNames.map((name, index) => [name, readings[index]]))
    };
};

var cursorFor = (eventType, from, to) => Event.find({ eventType, timestamp: { $gte: from, $lt: to } })
    .sort({ timestamp: 1 })
    .hint('eventType_timestamp')
    .select({ timestamp: 1, eventType: 1, status: 1 })
    .lean()
    .cursor({ batchSize: 1000 });

var scanHistory = async (run) => {
    const initial = await stateBefore(run.from);
    const extractor = new WindowExtractor(initial, { sun: sun.forTimeZone(run.timeZone) });
    // readings before switches at the same moment
    const types = ['info', 'status'];
    const cursors = types.map((type) => cursorFor(type, run.from, run.to));
    const heads = await Promise.all(cursors.map((cursor) => cursor.next()));
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
        heads[next] = await cursors[next].next();
        extractor.push({ t: doc.timestamp.getTime(), type: doc.eventType, status: doc.status });
        run.scanned++;
        if (run.scanned % PROGRESS_EVERY === 0) {
            run.through = doc.timestamp;
            // lets requests for the status through between batches of events
            await new Promise((resolve) => setImmediate(resolve));
        }
    }
    await Promise.all(cursors.map((cursor) => cursor.close()));
    run.windows = extractor.finish(run.to.getTime()).map((window) => Object.assign(window, {
        start: window.start.toISOString(),
        end: window.end.toISOString()
    }));
    run.gaps = extractor.gaps.length;
};

var summarize = (windows) => {
    const bodies = {};
    BODIES.forEach((body) => {
        bodies[body] = {};
        SOURCES.forEach((sources) => {
            const mine = windows.filter((window) => window.body === body && window.sources === sources);
            bodies[body][sources] = {
                windows: mine.length,
                suitable: mine.filter((window) => window.suitable).length,
                hours: mine.filter((window) => window.suitable).reduce((sum, window) => sum + window.hours, 0)
            };
        });
    });
    const reasons = {};
    windows.filter((window) => !window.suitable).forEach((window) => {
        reasons[window.reason] = (reasons[window.reason] || 0) + 1;
    });
    return {
        windows: windows.length,
        suitable: windows.filter((window) => window.suitable).length,
        bodies,
        reasons: Object.entries(reasons).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count)
    };
};

var describeScan = (run) => run && {
    id: run.id,
    state: run.state,
    from: run.from,
    to: run.to,
    requestedBy: run.requestedBy,
    requestedAt: run.requestedAt,
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
    through: run.through || null,
    scanned: run.scanned,
    gaps: run.gaps || 0,
    summary: run.windows ? summarize(run.windows) : null,
    error: run.error || null
};

var executeScan = async (run) => {
    run.state = 'running';
    run.startedAt = new Date();
    try {
        await scanHistory(run);
        run.state = 'finished';
        const summary = summarize(run.windows);
        logger.info(`scanned ${run.scanned} events from ${run.from.toISOString()} to ${run.to.toISOString()}: ${summary.windows} windows, ${summary.suitable} suitable`);
    } catch (e) {
        run.state = 'failed';
        run.error = e.message;
        logger.error(`scanning history for heating windows failed: ${e.stack || e.message}`);
    } finally {
        run.finishedAt = new Date();
        run.through = run.to;
    }
};

/**
 * starts looking through history for the windows to learn from, from `from` (inclusive) to `to`
 * (exclusive): by default all of it except what the simulator made. Answers at once with the scan,
 * which goes on in the job queue
 *
 * returns HeatingScan
 **/
exports.startScan = async function({ from, to } = {}, user) {
    if (latestScan && (latestScan.state === 'waiting' || latestScan.state === 'running')) {
        throw utils.respondWithCode(409, { code: 409, message: 'history is already being scanned; wait for it to finish' });
    }
    const range = await defaultRange();
    const start = from === undefined || from === null ? range.from : parseDate(from, 'from');
    const end = to === undefined || to === null ? range.to : new Date(Math.min(parseDate(to, 'to').getTime(), Date.now()));
    if (start >= end) {
        throw badRequest('from must be earlier than to, and earlier than now');
    }
    latestScan = {
        id: crypto.randomUUID(),
        state: 'waiting',
        from: start,
        to: end,
        timeZone: settings.timeZone(),
        requestedBy: user && user.email ? user.email : null,
        requestedAt: new Date(),
        scanned: 0,
        windows: null
    };
    const run = latestScan;
    scheduler.exclusive(() => executeScan(run));
    return describeScan(run);
};

/**
 * the scan under way, or the last one; null before any
 *
 * returns HeatingScan
 **/
exports.getScan = async function() {
    return describeScan(latestScan);
};

/**
 * every window the last scan found, with whether it is suitable to learn from and if not why
 *
 * returns [HeatingWindow]
 **/
exports.getWindows = async function() {
    if (!latestScan || latestScan.state !== 'finished') {
        throw utils.respondWithCode(409, { code: 409, message: 'there is no finished scan; find windows first' });
    }
    return { scanId: latestScan.id, windows: latestScan.windows };
};

var chosenSources = (includeSources) => {
    if (includeSources === undefined || includeSources === null) {
        return SOURCES;
    }
    const list = Array.isArray(includeSources) ? includeSources : String(includeSources).split(',').map((item) => item.trim());
    const unknown = list.filter((item) => !SOURCES.includes(item));
    if (unknown.length > 0) {
        throw badRequest(`sources are ${SOURCES.join(', ')}`);
    }
    return list;
};

/** what the model says warming would take, for each body and way of heating, at a few air temperatures */
var samples = (bodies) => {
    const result = [];
    BODIES.forEach((body) => {
        const model = bodies[body];
        if (!model || !model.available) {
            return;
        }
        const setpoint = SAMPLE_SETPOINT[body];
        const temperature = setpoint - SAMPLE_DEGREES_BELOW;
        [['heater1'], ['heatpump'], ['heater1', 'heatpump']].forEach((names) => {
            SAMPLE_AIRS.forEach((air) => {
                const outcome = timeToReach(model, {
                    temperature,
                    airTemperature: air,
                    sources: names.map((name) => ({ name, setpoint })),
                    sun: () => SAMPLE_SUN
                });
                result.push({
                    body,
                    sources: names.length === 2 ? 'both' : names[0] === 'heater1' ? 'heater' : 'heatpump',
                    from: temperature,
                    to: setpoint,
                    airTemperature: air,
                    status: outcome.status,
                    minutes: outcome.status === 'ready' ? Math.round(outcome.hours * 60) : null
                });
            });
        });
    });
    return result;
};

var compact = (window) => ({
    id: window.id,
    body: window.body,
    sources: window.sources,
    start: window.start,
    end: window.end,
    hours: Math.round(window.hours * 1000) / 1000,
    waterTemperature: Math.round(window.waterTemperature * 100) / 100,
    airTemperature: Math.round(window.airTemperature * 100) / 100,
    sun: Math.round(window.sun * 1000) / 1000,
    slope: Math.round(window.slope * 1000) / 1000
});

/**
 * fits a model to the suitable windows of the last scan that aren't excluded, and keeps it, for a
 * while, to be saved exactly as shown
 *
 *   scanId            the scan the windows are from; it must still be the latest
 *   excludeWindowIds  windows to leave out
 *   includeSources    the kinds of window to use (heater, heatpump, both, cooling); all by default
 *
 * returns HeatingModelPreview
 **/
exports.preview = async function({ scanId, excludeWindowIds, includeSources } = {}) {
    if (!latestScan || latestScan.state !== 'finished') {
        throw utils.respondWithCode(409, { code: 409, message: 'there is no finished scan; find windows first' });
    }
    if (scanId !== latestScan.id) {
        throw utils.respondWithCode(409, { code: 409, message: 'that scan has been replaced by a newer one; use its windows' });
    }
    const sources = chosenSources(includeSources);
    const excluded = new Set(Array.isArray(excludeWindowIds) ? excludeWindowIds : []);
    const chosen = latestScan.windows.filter((window) => window.suitable && sources.includes(window.sources) && !excluded.has(window.id));
    const bodies = {};
    BODIES.forEach((body) => {
        bodies[body] = fitBody(chosen.filter((window) => window.body === body));
    });
    const preview = {
        previewId: crypto.randomUUID(),
        scanId,
        createdAt: new Date(),
        range: { from: latestScan.from, to: latestScan.to },
        timeZone: latestScan.timeZone,
        windowsUsed: chosen.length,
        excludedWindows: latestScan.windows.filter((window) => window.suitable && excluded.has(window.id)).length,
        sources,
        bodies,
        current: publicModel(activeModel),
        samples: samples(bodies),
        compact: chosen.map(compact)
    };
    previews.set(preview.previewId, preview);
    [...previews.values()]
        .filter((each) => Date.now() - each.createdAt.getTime() > PREVIEW_LIFE_MS)
        .forEach((each) => previews.delete(each.previewId));
    while (previews.size > KEEP_PREVIEWS) {
        previews.delete(previews.keys().next().value);
    }
    const shown = Object.assign({}, preview);
    delete shown.compact;
    return shown;
};

/**
 * keeps a previewed model as the one in use
 *
 * returns HeatingModelState
 **/
exports.save = async function({ previewId } = {}, user) {
    const preview = previews.get(previewId);
    if (!preview) {
        throw notFound('that calculation is no longer held; calculate it again');
    }
    if (!BODIES.some((body) => preview.bodies[body].available)) {
        throw badRequest('no body of water has enough windows to make a model; choose more');
    }
    await HeatingModel.updateMany({ active: true }, { $set: { active: false } });
    const doc = await HeatingModel.create({
        createdAt: new Date(),
        createdBy: user && user.email ? user.email : null,
        range: preview.range,
        timeZone: preview.timeZone,
        bodies: preview.bodies,
        windowsUsed: preview.compact,
        active: true
    });
    activeModel = doc.toObject();
    delete activeModel.windowsUsed;
    previews.delete(previewId);
    const available = BODIES.filter((body) => preview.bodies[body].available);
    logger.info(`heating model saved for ${available.join(', ')} from ${preview.windowsUsed} windows`);
    activity.record(user, `Saved a heating estimate model for ${available.join(' and ')} from ${preview.windowsUsed} windows of history`);
    listeners.forEach((listener) => listener());
    return exports.getModel();
};

exports.SIMULATED_FROM = SIMULATED_FROM;
