'use strict';
// Runs the server's maintenance jobs on their intervals, one at a time, inside the REST
// process. A lease in the jobs collection keeps two processes from running the same job, so the
// same code can later run in a jobs-only container (--jobs-only) beside REST ones (--no-jobs).

const os = require('os');
var { JobState } = require('../models/jobState');
const log4js = require('log4js');
var logger = log4js.getLogger();

const LEASE_MS = 10 * 60 * 1000;
// a job that reports more work left runs again this soon
const CATCH_UP_MS = 2000;
const OWNER = `${os.hostname()}:${process.pid}`;

var jobs = new Map();
var scheduling = false;
// jobs run one after another, so maintenance never piles up on the controller's bus timing
var queue = Promise.resolve();

/**
 * job: { name, description, everyMs, firstDelayMs, run(context) }, where run resolves with
 * { summary, more } and context has data (what the job kept from its last run) and save(data)
 **/
exports.register = function(job) {
    jobs.set(job.name, Object.assign({ running: false, timer: undefined, nextRunAt: undefined }, job));
};

var acquire = async (name) => {
    const now = new Date();
    try {
        return await JobState.findOneAndUpdate(
            { _id: name, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }, { leaseOwner: OWNER }] },
            { $set: { leaseOwner: OWNER, leaseUntil: new Date(now.getTime() + LEASE_MS) } },
            { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
    } catch (e) {
        // the upsert collides with the document another process holds the lease on
        if (e.code === 11000) {
            return undefined;
        }
        throw e;
    }
};

var schedule = (job, delayMs) => {
    clearTimeout(job.timer);
    if (!scheduling) {
        job.nextRunAt = undefined;
        return;
    }
    job.nextRunAt = new Date(Date.now() + delayMs);
    job.timer = setTimeout(() => {
        exports.runNow(job.name, 'schedule').catch((e) => logger.error(`job ${job.name}: ${e.message}`));
    }, delayMs);
    // waiting for a job alone doesn't keep the process running
    job.timer.unref();
};

var execute = async (job, trigger) => {
    const state = await acquire(job.name);
    if (!state) {
        return { busy: true };
    }
    job.running = true;
    const started = new Date();
    let outcome = { lastResult: 'ok', lastError: null, lastSummary: null };
    let more = false;
    try {
        let data = state.data || {};
        const context = {
            get data() {
                return data;
            },
            save: async (changes) => {
                data = Object.assign({}, data, changes);
                await JobState.updateOne({ _id: job.name }, { $set: { data, leaseUntil: new Date(Date.now() + LEASE_MS) } });
            }
        };
        const result = (await job.run(context)) || {};
        outcome.lastSummary = result.summary || null;
        more = result.more === true;
        logger.debug(`job ${job.name} (${trigger}): ${outcome.lastSummary || 'done'}`);
    } catch (e) {
        outcome = { lastResult: 'failed', lastError: e.message, lastSummary: null };
        logger.error(`job ${job.name} failed: ${e.stack || e.message}`);
    } finally {
        job.running = false;
        const finished = new Date();
        await JobState.updateOne({ _id: job.name }, {
            $set: Object.assign(outcome, { lastStartedAt: started, lastFinishedAt: finished, lastDurationMs: finished - started, leaseUntil: null }),
            $inc: { runs: 1 }
        }).catch((e) => logger.error(`job ${job.name}: could not record its run: ${e.message}`));
    }
    schedule(job, more ? CATCH_UP_MS : job.everyMs);
    return { busy: false, more };
};

/**
 * runs a job now, after any job already running; resolves with its status
 **/
exports.runNow = function(name, trigger = 'manual') {
    const job = jobs.get(name);
    if (!job) {
        return Promise.reject(new Error(`there is no job named ${name}`));
    }
    const run = queue.then(() => execute(job, trigger));
    queue = run.catch(() => {});
    return run.then(async (result) => Object.assign(await exports.status(name), { busy: result.busy, more: result.more === true }));
};

/**
 * starts running every job on its interval; with enabled false, jobs only run when asked
 **/
exports.start = function({ enabled }) {
    scheduling = enabled;
    for (const job of jobs.values()) {
        schedule(job, job.firstDelayMs || job.everyMs);
    }
    logger.info(enabled ? `maintenance jobs scheduled: ${[...jobs.keys()].join(', ')}` : 'maintenance jobs run only when asked (--no-jobs)');
};

exports.stop = function() {
    scheduling = false;
    for (const job of jobs.values()) {
        clearTimeout(job.timer);
        job.nextRunAt = undefined;
    }
};

var describe = (job, state) => ({
    name: job.name,
    description: job.description,
    intervalSeconds: Math.round(job.everyMs / 1000),
    scheduled: scheduling,
    running: job.running,
    nextRunAt: job.nextRunAt || null,
    lastStartedAt: state && state.lastStartedAt ? state.lastStartedAt : null,
    lastFinishedAt: state && state.lastFinishedAt ? state.lastFinishedAt : null,
    lastDurationMs: state && typeof state.lastDurationMs === 'number' ? state.lastDurationMs : null,
    lastResult: state && state.lastResult ? state.lastResult : null,
    lastError: state && state.lastError ? state.lastError : null,
    lastSummary: state && state.lastSummary ? state.lastSummary : null,
    runs: state && state.runs ? state.runs : 0
});

/**
 * one job's status, or every job's
 **/
exports.status = async function(name) {
    const states = new Map((await JobState.find({}).select({ data: 0 }).lean()).map((state) => [state._id, state]));
    if (name) {
        const job = jobs.get(name);
        return job ? describe(job, states.get(name)) : undefined;
    }
    return [...jobs.values()].map((job) => describe(job, states.get(job.name)));
};

exports.has = function(name) {
    return jobs.has(name);
};
