'use strict';
// The everyday jobs the apps offer in place of single switches. Each is a set of switches the
// controller already has, so whether a task is on is read from those switches:
//
//   pool        spillover water flow with the filter pump running; off stops the filter pump
//   spaPreheat  turns on the spa filter with the heater and heat pump, and is on while the spa
//               filter runs with either of them; off stops the spa filter. It can be scheduled to be ready by a time, and then starts only as early as the
//               spa needs to reach its setpoint by then
//   spaParty    a spa preheat with the blower, and the lights when it's dark; off stops the spa
//               filter, blower and lights

const { Event } = require('../models/event');
const { Setting } = require('../models/setting');
const utils = require('../utils/writer.js');
const deviceService = require('./DeviceService');
const waterService = require('./WaterService');
const heatingService = require('./HeatingService');
const heatingModels = require('./HeatingModelService');
const settings = require('./SettingsService');
const activity = require('./ActivityService');
const { timeToReach } = require('../heating/estimate');
const heatingRules = require('../heating/rules');
const sun = require('../heating/sun');
const { isDark } = require('../utils/daylight');
const log4js = require('log4js');
var logger = log4js.getLogger();

const SETTINGS_ID = 'server';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
// how often to check whether a scheduled preheat is due; the tests shorten it
var tickMs = () => {
    const ms = Number(process.env.POOL_TASK_TICK_MS);
    return Number.isFinite(ms) && ms > 0 ? ms : MINUTE_MS;
};
// the sensor is in the plumbing, so the spa's last reading is only trusted for this long; after
// that the water may have cooled as far as the air
const SPA_READING_FRESH_MS = 3 * HOUR_MS;
// what the spa is assumed to be with no reading and no air temperature
const UNKNOWN_SPA_F = 70;
const SWITCHES = { filter: 'filter', spaFilter: 'aux14', heater: 'heater1', heatPump: 'valve4', blower: 'aux5', lights: 'lights' };
const TASKS = ['pool', 'spaPreheat', 'spaParty'];
const TITLES = { pool: 'Pool', spaPreheat: 'Spa Preheat', spaParty: 'Spa Party' };

// { isOn(name), waterMode }
var stateSource = () => ({ isOn: () => false, waterMode: undefined });
var scheduled = null;
var listeners = [];
var ticker;
var clock = () => Date.now();

exports.registerStateSource = function(source) {
    stateSource = source;
};

/** for the tests: a clock other than the real one */
exports.useClock = function(now) {
    clock = now || (() => Date.now());
};

/** listener() runs when a scheduled preheat is set, cancelled or started */
exports.onChange = function(listener) {
    listeners.push(listener);
};

var changed = () => listeners.forEach((listener) => listener());

var conflict = (message) => utils.respondWithCode(409, { code: 409, message });
var badRequest = (message) => utils.respondWithCode(400, { code: 400, message });

var who = (user) => user && user.email ? user.email : 'unknown user';

/**
 * reads a preheat scheduled before a restart, and checks every minute whether it's time to start
 * one; run at startup and after a factory reset
 **/
exports.load = async function() {
    const doc = await Setting.findById(SETTINGS_ID).lean();
    scheduled = doc && doc.scheduledPreheat && doc.scheduledPreheat.readyAt ? doc.scheduledPreheat : null;
    if (scheduled) {
        logger.info(`a spa preheat is scheduled to be ready at ${new Date(scheduled.readyAt).toISOString()}`);
    }
    if (!ticker) {
        ticker = setInterval(() => exports.tick().catch((e) => logger.error(`scheduled preheat: ${e.message}`)), tickMs());
        ticker.unref();
    }
};

var saveSchedule = async (value) => {
    scheduled = value;
    await Setting.updateOne({ _id: SETTINGS_ID }, { $set: { scheduledPreheat: value } }, { upsert: true });
    changed();
};

// MARK: state

var spaSetpoint = () => Math.max(heatingService.setpoint('spa', 'heater1'), heatingService.setpoint('spa', 'heatpump'));

var states = () => {
    const state = stateSource();
    const on = (name) => state.isOn(SWITCHES[name]) === true;
    // turning one heat source off leaves the spa heating with the other, so it stays a preheat
    const preheat = on('spaFilter') && (on('heater') || on('heatPump'));
    return {
        pool: on('filter') && state.waterMode === 'spillover',
        spaPreheat: preheat,
        spaParty: preheat && on('blower')
    };
};

/**
 * the spa's temperature to time a preheat from: its last reading while recent, otherwise the
 * lower of that and the air, since an idle spa cools toward the air
 **/
var spaStartingTemperature = async (air) => {
    const last = await Event.findOne({ eventType: 'info', 'status.name': 'spa temp' }).sort({ timestamp: -1 }).lean();
    const entry = last && last.status.find((reading) => reading.name === 'spa temp');
    const reading = entry && typeof entry.value === 'number' && entry.value > 0 ? entry.value : undefined;
    const fresh = reading !== undefined && clock() - new Date(last.timestamp).getTime() < SPA_READING_FRESH_MS;
    if (fresh) {
        return reading;
    }
    const candidates = [reading, air].filter((value) => typeof value === 'number');
    return candidates.length > 0 ? Math.min(...candidates) : UNKNOWN_SPA_F;
};

/**
 * how long, in minutes, the spa takes from cold to its setpoint with both heat sources, and what
 * timed it: the spa's model, the admin's rules where the model can't say, and the admin's margin
 **/
var leadTime = async () => {
    const state = stateSource();
    const air = typeof state.ambient === 'number' ? state.ambient : undefined;
    const temperature = await spaStartingTemperature(air);
    const setpoint = spaSetpoint();
    const margin = settings.preheatMarginMinutes();
    const saved = heatingModels.model();
    const effective = heatingRules.effectiveModel(saved && saved.bodies && saved.bodies.spa, settings.heatingRules().spa);
    const { basis } = heatingRules.basisFor(effective, ['heater1', 'heatpump']);
    const now = clock();
    const sunAt = sun.forTimeZone((saved && saved.timeZone) || settings.timeZone());
    const outcome = timeToReach(effective.model, {
        temperature,
        airTemperature: air === undefined ? temperature : air,
        sources: [{ name: 'heater1', setpoint }, { name: 'heatpump', setpoint }],
        sun: (hours) => sun.averageOver(sunAt, now, now + hours * HOUR_MS)
    });
    let minutes;
    if (outcome.status === 'ready') {
        minutes = Math.ceil(outcome.hours * 60);
    } else if (outcome.status === 'atSetpoint') {
        minutes = 0;
    } else {
        // the model says it can't get there in this weather; the rules, which lose nothing to
        // the air, give the soonest it might
        const rules = settings.heatingRules().spa;
        minutes = Math.ceil(Math.max(0, setpoint - temperature) / (rules.heater + rules.heatPump) * 60);
    }
    return { minutes: minutes + margin, from: basis, temperature, setpoint };
};

var scheduleView = async () => {
    if (!scheduled) {
        return null;
    }
    const lead = await leadTime();
    const readyAt = new Date(scheduled.readyAt).getTime();
    return {
        readyAt: new Date(readyAt).toISOString(),
        startAt: new Date(Math.max(clock(), readyAt - lead.minutes * MINUTE_MS)).toISOString(),
        leadMinutes: lead.minutes,
        leadFrom: lead.from,
        fromTemperature: lead.temperature,
        setpoint: lead.setpoint,
        requestedBy: scheduled.requestedBy || null
    };
};

/**
 * whether each task is on, a spa preheat waiting for its time, and whether it's dark
 *
 * returns Tasks
 **/
exports.getTasks = async function() {
    const on = states();
    return {
        pool: { on: on.pool },
        spaPreheat: { on: on.spaPreheat, scheduled: await scheduleView() },
        spaParty: { on: on.spaParty },
        dark: isDark(clock(), settings.location(), settings.timeZone())
    };
};

// MARK: changing

/**
 * asks for each switch in turn, going on past one the controller won't take, and fails with
 * what went wrong once all have been asked for
 **/
var apply = async (steps, user) => {
    const problems = [];
    for (const step of steps) {
        try {
            if (step.mode) {
                await waterService.setWaterMode(step.mode, user);
            } else {
                await deviceService.setDeviceState(SWITCHES[step.device], String(step.on), user);
            }
        } catch (e) {
            const message = e && e.payload && e.payload.message ? e.payload.message : (e && e.message) || String(e);
            problems.push(message);
        }
    }
    if (problems.length > 0) {
        throw conflict(problems.join('; '));
    }
};

var preheatSteps = () => [
    { device: 'spaFilter', on: true },
    { device: 'heater', on: true },
    { device: 'heatPump', on: true }
];

var record = (user, task, on, extra) => {
    const what = `${on ? 'Turned on' : 'Turned off'} ${TITLES[task]}${extra ? ` ${extra}` : ''}`;
    logger.info(`REST ${who(user)}: ${what}`);
    activity.record(user, what);
};

var startPreheat = async (user) => {
    await apply(preheatSteps(), user);
};

/**
 * pool on: spillover water flow and the filter pump; off: the filter pump
 *
 * returns Tasks
 **/
exports.setPool = async function(on, user) {
    record(user, 'pool', on);
    // the pump first, so the water flows as soon as the valves turn
    await apply(on ? [{ device: 'filter', on: true }, { mode: 'spillover' }] : [{ device: 'filter', on: false }], user);
    return exports.getTasks();
};

/**
 * spa preheat on now, or by `readyAt`; off stops the spa filter and drops a scheduled one
 *
 * returns Tasks
 **/
exports.setSpaPreheat = async function(on, readyAt, user) {
    if (!on) {
        record(user, 'spaPreheat', false, scheduled ? '(and its schedule)' : undefined);
        if (scheduled) {
            await saveSchedule(null);
        }
        await apply([{ device: 'spaFilter', on: false }], user);
        return exports.getTasks();
    }
    if (readyAt !== undefined && readyAt !== null) {
        const ready = new Date(readyAt).getTime();
        if (Number.isNaN(ready)) {
            throw badRequest(`${readyAt} is not a time`);
        }
        const lead = await leadTime();
        if (!states().spaPreheat && ready - lead.minutes * MINUTE_MS > clock()) {
            record(user, 'spaPreheat', true, `to be ready at ${new Date(ready).toISOString()}`);
            await saveSchedule({ readyAt: new Date(ready), requestedBy: who(user) });
            return exports.getTasks();
        }
    }
    record(user, 'spaPreheat', true);
    if (scheduled) {
        await saveSchedule(null);
    }
    await startPreheat(user);
    return exports.getTasks();
};

/**
 * spa party on: a preheat with the blower, and the lights when it's dark; off: the spa filter,
 * blower and lights
 *
 * returns Tasks
 **/
exports.setSpaParty = async function(on, user) {
    record(user, 'spaParty', on);
    if (on) {
        if (scheduled) {
            await saveSchedule(null);
        }
        const steps = preheatSteps().concat([{ device: 'blower', on: true }]);
        if (isDark(clock(), settings.location(), settings.timeZone())) {
            steps.push({ device: 'lights', on: true });
        }
        await apply(steps, user);
    } else {
        await apply([{ device: 'spaFilter', on: false }, { device: 'blower', on: false }, { device: 'lights', on: false }], user);
    }
    return exports.getTasks();
};

/**
 * starts a scheduled preheat once the spa needs all the time left to reach its setpoint
 **/
exports.tick = async function() {
    if (!scheduled) {
        return;
    }
    const lead = await leadTime();
    const readyAt = new Date(scheduled.readyAt).getTime();
    if (clock() < readyAt - lead.minutes * MINUTE_MS) {
        return;
    }
    const user = { email: scheduled.requestedBy || 'scheduled preheat' };
    const due = scheduled;
    await saveSchedule(null);
    logger.info(`starting the spa preheat scheduled by ${user.email} to be ready at ${new Date(due.readyAt).toISOString()} (${lead.minutes} minutes from ${lead.temperature}°F by the ${lead.from})`);
    activity.record(user, `Started the spa preheat scheduled to be ready at ${new Date(due.readyAt).toISOString()}`);
    try {
        await startPreheat(user);
    } catch (e) {
        const message = e && e.payload && e.payload.message ? e.payload.message : e.message;
        logger.warn(`the scheduled spa preheat didn't fully start: ${message}`);
    }
};

/** which task names PUT /tasks/{task} takes */
exports.TASKS = TASKS;
