'use strict';

var utils = require('../utils/writer.js');
const activity = require('./ActivityService');
const heating = require('../protocol/heating');
const heatingModels = require('./HeatingModelService');
const settings = require('./SettingsService');
const { timeToReach, currentRate } = require('../heating/estimate');
const sun = require('../heating/sun');
const log4js = require('log4js');
var logger = log4js.getLogger();

const DEFAULT_SETPOINT_F = 80;
const HOUR_MS = 3600 * 1000;
const MINUTE_MS = 60 * 1000;
// the sensor is in the plumbing: after the pump starts it shows what sat there before for a while
const DEFAULT_SETTLE_MINUTES = 15;

// stands in until the server can read the controller's setpoints and send it new ones: every
// setpoint starts at 80, and a change lasts until the server restarts without reaching the controller
var memorySetpoints = () => {
    const values = {};
    heating.BODIES.forEach((body) => {
        values[body] = {};
        heating.DEVICES.forEach((device) => {
            values[body][device] = DEFAULT_SETPOINT_F;
        });
    });
    return {
        reachesController: false,
        get: (body, device) => values[body][device],
        set: (body, device, degrees) => {
            values[body][device] = degrees;
        }
    };
};

var setpoints = memorySetpoints();
// { filter, spaFilter, waterMode, enabled: { heater1, heatpump }, heaterFiring, temperatures: { pool, spa }, ambient }
var stateSource = () => ({ enabled: {}, temperatures: {} });

/**
 * replaces the stand-in setpoints with a driver's own, such as the simulator's
 *
 * store  { reachesController, get(body, device), set(body, device, degrees) }
 **/
exports.registerSetpoints = function(store) {
    setpoints = store;
};

exports.registerStateSource = function(source) {
    stateSource = source;
};

// the body the pumps have been driving toward and since when; unknown (null) until it changes
// once after the server started, as the pump may have been running for hours already
var targetSeen;
var targetSince = null;

var settleMs = () => {
    const minutes = Number(process.env.POOL_ESTIMATE_SETTLE_MINUTES);
    return (Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_SETTLE_MINUTES) * MINUTE_MS;
};

/**
 * to be told when the switches change, so the moment a pump starts is known
 **/
exports.stateChanged = function() {
    const target = heating.targetBody(stateSource()) || null;
    if (targetSeen === undefined) {
        targetSeen = target;
        return;
    }
    if (target !== targetSeen) {
        targetSeen = target;
        targetSince = target ? Date.now() : null;
    }
};

var round = (value, places) => typeof value === 'number' ? Math.round(value * Math.pow(10, places)) / Math.pow(10, places) : null;

/**
 * how long until the water reaches its setpoint, or null while nothing is heating it: the pump is
 * running and a heat source is enabled and calling for heat
 **/
var estimateFor = (state, target, devices) => {
    const calling = heating.DEVICES.filter((device) => devices[device].callingForHeat);
    if (!target || calling.length === 0) {
        return null;
    }
    const now = Date.now();
    const temperature = state.temperatures[target];
    const air = state.ambient;
    const sources = calling.map((device) => ({ name: device, setpoint: devices[device].setpoint }));
    const estimate = {
        status: 'noReading',
        body: target,
        temperature: typeof temperature === 'number' ? temperature : null,
        setpoint: Math.max(...sources.map((source) => source.setpoint)),
        airTemperature: typeof air === 'number' ? air : null,
        minutes: null,
        readyAt: null,
        reachesAtMost: null,
        sources: calling,
        rate: null,
        model: null,
        display: settings.heatingEstimateDisplay(),
        timeZone: settings.timeZone()
    };
    if (typeof temperature !== 'number') {
        return estimate;
    }
    const saved = heatingModels.model();
    const model = saved && saved.bodies && saved.bodies[target];
    if (!model || !model.available) {
        estimate.status = 'noModel';
        return estimate;
    }
    estimate.model = {
        calculatedAt: saved.createdAt,
        windows: model.windows ? model.windows.total : 0,
        rSquared: round(model.rSquared, 3),
        rmse: round(model.rmse, 3),
        airRange: model.airRange || null,
        notes: model.notes || []
    };
    if (typeof air !== 'number') {
        return estimate;
    }
    const sunAt = sun.forTimeZone(saved.timeZone || settings.timeZone());
    const rate = currentRate(model, {
        temperature,
        airTemperature: air,
        heater: calling.includes('heater1'),
        heatPump: calling.includes('heatpump'),
        sun: sunAt(now)
    });
    estimate.rate = {
        net: round(rate.net, 3),
        heater: round(rate.heater, 3),
        heatPump: round(rate.heatPump, 3),
        solar: round(rate.solar, 3),
        loss: round(rate.loss, 3)
    };
    if (targetSince !== null && now - targetSince < settleMs()) {
        estimate.status = 'settling';
        return estimate;
    }
    const outcome = timeToReach(model, {
        temperature,
        airTemperature: air,
        sources,
        sun: (hours) => sun.averageOver(sunAt, now, now + hours * HOUR_MS)
    });
    estimate.status = outcome.status === 'atSetpoint' ? 'ready' : outcome.status;
    if (outcome.status === 'ready' || outcome.status === 'atSetpoint') {
        estimate.minutes = outcome.status === 'ready' ? Math.max(1, Math.ceil(outcome.hours * 60)) : 0;
        estimate.readyAt = new Date(now + estimate.minutes * MINUTE_MS).toISOString();
    } else if (outcome.status === 'unreachable') {
        estimate.reachesAtMost = round(outcome.reachesAtMost, 1);
    }
    return estimate;
};

var allSetpoints = () => {
    const all = {};
    heating.BODIES.forEach((body) => {
        all[body] = {};
        heating.DEVICES.forEach((device) => {
            all[body][device] = setpoints.get(body, device);
        });
    });
    return all;
};

var validate = (body, device) => {
    if (!heating.BODIES.includes(body)) {
        throw new Error(`the body of water must be one of ${heating.BODIES.join(', ')}`);
    }
    if (!heating.DEVICES.includes(device)) {
        throw new Error(`the heating device must be one of ${heating.DEVICES.join(', ')}`);
    }
};

var badRequest = (e) => utils.respondWithCode(400, { code: 400, message: e.message });

/**
 * the setpoint `device` uses for `body`
 **/
exports.setpoint = function(body, device) {
    return setpoints.get(body, device);
};

/**
 * every setpoint, and what each heating device is doing with them
 *
 * returns Heating
 **/
exports.getHeating = async function() {
    exports.stateChanged();
    const state = stateSource();
    const target = heating.targetBody(state);
    const devices = {};
    heating.DEVICES.forEach((device) => {
        const enabled = state.enabled[device];
        const setpoint = target ? setpoints.get(target, device) : null;
        const temperature = target ? state.temperatures[target] : undefined;
        const calling = enabled === true && heating.callsForHeat(temperature, setpoint);
        devices[device] = {
            enabled: typeof enabled === 'boolean' ? enabled : null,
            // the controller reports the heater firing; the heat pump has no such signal, so it
            // counts as running whenever it is enabled and its water is below the setpoint
            heating: device === 'heater1' ? enabled === true && state.heaterFiring === true : calling,
            callingForHeat: calling,
            body: target || null,
            setpoint: setpoint,
            temperature: typeof temperature === 'number' ? temperature : null
        };
    });
    return {
        units: 'fahrenheit',
        target: target || null,
        minimum: heating.SETPOINT_MIN_F,
        maximum: heating.SETPOINT_MAX_F,
        setpointsReachController: setpoints.reachesController === true,
        setpoints: allSetpoints(),
        devices: devices,
        estimate: estimateFor(state, target, devices)
    };
};

/**
 * returns Setpoint
 **/
exports.getSetpoint = async function(body, device) {
    try {
        validate(body, device);
    } catch (e) {
        throw badRequest(e);
    }
    return { body: body, device: device, setpoint: setpoints.get(body, device), units: 'fahrenheit' };
};

/**
 * returns SetpointChange
 **/
exports.setSetpoint = async function(body, device, degrees, user) {
    const who = user && user.email ? user.email : 'unknown user';
    try {
        validate(body, device);
        if (!heating.isSetpoint(degrees)) {
            throw new Error(`a setpoint must be a whole number from ${heating.SETPOINT_MIN_F} to ${heating.SETPOINT_MAX_F}°F`);
        }
    } catch (e) {
        logger.warn(`REST ${who}: rejected ${body} ${device} setpoint ${degrees}: ${e.message}`);
        throw badRequest(e);
    }

    const previous = setpoints.get(body, device);
    const what = `${heating.bodyLabels[body]} ${heating.deviceLabels[device]} setpoint`;
    if (previous === degrees) {
        logger.info(`REST ${who}: ${what} already ${degrees}°F`);
        activity.record(user, `Asked for a ${what} of ${degrees}°F; it already was`);
    } else {
        setpoints.set(body, device, degrees);
        logger.info(`REST ${who}: ${what} ${previous} -> ${degrees}°F${setpoints.reachesController ? '' : ' (kept by the server; not sent to the controller)'}`);
        activity.record(user, `Changed the ${what} from ${previous}°F to ${degrees}°F`);
    }
    return { body: body, device: device, setpoint: degrees, previousSetpoint: previous, units: 'fahrenheit' };
};
