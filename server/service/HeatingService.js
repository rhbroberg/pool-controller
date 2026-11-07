'use strict';

var utils = require('../utils/writer.js');
const activity = require('./ActivityService');
const heating = require('../protocol/heating');
const log4js = require('log4js');
var logger = log4js.getLogger();

const DEFAULT_SETPOINT_F = 80;

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
// { filter, spaFilter, waterMode, enabled: { heater1, heatpump }, heaterFiring, temperatures: { pool, spa } }
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
        devices: devices
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
