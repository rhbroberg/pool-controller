import { errorMessageOf } from '../types/domain';
import type { HeatingEstimateStatus } from '../types/domain';
'use strict';

var utils = require('../utils/writer');
const activity = require('./ActivityService');
const heating = require('../protocol/heating');
const heatingModels = require('./HeatingModelService');
const settings = require('./SettingsService');
const { timeToReach, currentRate } = require('../heating/estimate');
const heatingRules = require('../heating/rules');
const sun = require('../heating/sun');
const log4js = require('log4js');
var logger = log4js.getLogger();

const DEFAULT_SETPOINT_F = 80;
const HOUR_MS = 3600 * 1000;
const MINUTE_MS = 60 * 1000;
// the sensor is in the plumbing: after the pump starts it shows what sat there before for a while
const DEFAULT_SETTLE_MINUTES = 15;

// used when there is no controller path (no serial Settings menu, no simulator): every setpoint
// starts at 80, and a change lasts until the server restarts
var memorySetpoints = () => {
    const values: any = {};
    heating.BODIES.forEach((body: any) => {
        values[body] = {};
        heating.DEVICES.forEach((device: any) => {
            values[body][device] = DEFAULT_SETPOINT_F;
        });
    });
    return {
        reachesController: false,
        get: (body: any, device: any) => values[body][device],
        set: (body: any, device: any, degrees: any) => {
            values[body][device] = degrees;
        }
    };
};

var setpoints = memorySetpoints();
// { filter, spaFilter, waterMode, enabled: { heater1, heatpump }, heaterFiring, temperatures: { pool, spa }, ambient }
var stateSource = () => ({ enabled: {} as Record<string, any>, temperatures: {} as Record<string, any>, heaterFiring: false as boolean });
var changeListeners = [] as Array<() => void>;

/**
 * replaces the stand-in setpoints with a driver's own, such as the simulator's or the
 * Settings-menu store that talks to a live AquaLogic panel
 *
 * store  { reachesController, get(body, device), set(body, device, degrees) }
 **/
export function registerSetpoints(store: any) {
    setpoints = store;
};

export function registerStateSource(source: any) {
    stateSource = source;
};

/** told after a setpoint change so live updates can push GET /heating */
export function onChange(listener: () => void) {
    changeListeners.push(listener);
};

var notifyChanged = () => {
    changeListeners.forEach((listener) => {
        try {
            listener();
        } catch (e: any) {
            logger.warn(`heating onChange listener: ${errorMessageOf(e)}`);
        }
    });
};

// the body the pumps have been driving toward and since when; unknown (null) until it changes
// once after the server started, as the pump may have been running for hours already
var targetSeen: any;
var targetSince = null as any;

var settleMs = () => {
    const minutes = Number(process.env.POOL_ESTIMATE_SETTLE_MINUTES);
    return (Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_SETTLE_MINUTES) * MINUTE_MS;
};

/**
 * to be told when the switches change, so the moment a pump starts is known
 **/
export function stateChanged() {
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

var round = (value: any, places: any) => typeof value === 'number' ? Math.round(value * Math.pow(10, places)) / Math.pow(10, places) : null;

/**
 * how long until the water reaches its setpoint, or null while nothing is heating it: the pump is
 * running and a heat source is enabled and calling for heat
 **/
var estimateFor = (state: any, target: any, devices: any) => {
    const calling = heating.DEVICES.filter((device: any) => devices[device].callingForHeat);
    if (!target || calling.length === 0) {
        return null;
    }
    const now = Date.now();
    const temperature = state.temperatures[target];
    const air = state.ambient;
    const sources = calling.map((device: any) => ({ name: device, setpoint: devices[device].setpoint }));
    const estimate: { status: HeatingEstimateStatus; [key: string]: unknown } = {
        status: 'noReading',
        body: target,
        temperature: typeof temperature === 'number' ? temperature : null,
        setpoint: Math.max(...sources.map((source: any) => source.setpoint)),
        airTemperature: typeof air === 'number' ? air : null,
        minutes: null,
        readyAt: null,
        reachesAtMost: null,
        settling: false,
        // history: learned; rule: the body has no model, so the admin's rules timed it; mixed: a
        // source at work borrowed its rule
        basis: 'history',
        ruleSources: [] as any[],
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
    const learned = saved && saved.bodies && saved.bodies[target];
    const effective = heatingRules.effectiveModel(learned, settings.heatingRules()[target]);
    const model = effective.model;
    Object.assign(estimate, heatingRules.basisFor(effective, calling));
    if (!effective.fromRules) {
        estimate.model = {
            calculatedAt: saved.createdAt,
            windows: learned.windows ? learned.windows.total : 0,
            rSquared: round(learned.rSquared, 3),
            rmse: round(learned.rmse, 3),
            airRange: learned.airRange || null,
            notes: learned.notes || []
        };
    }
    // the rules lose nothing to the air, so they don't need it
    if (typeof air !== 'number' && !effective.fromRules) {
        return estimate;
    }
    const airTemperature = typeof air === 'number' ? air : temperature;
    const sunAt = sun.forTimeZone((saved && saved.timeZone) || settings.timeZone());
    const rate = currentRate(model, {
        temperature,
        airTemperature,
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
    // worked out all the same, from a reading that may still be the water that sat in the pipes
    estimate.settling = targetSince !== null && now - targetSince < settleMs();
    const outcome = timeToReach(model, {
        temperature,
        airTemperature,
        sources,
        sun: (hours: any) => sun.averageOver(sunAt, now, now + hours * HOUR_MS)
    });
    estimate.status = outcome.status === 'atSetpoint' ? 'ready' : outcome.status;
    if (outcome.status === 'ready' || outcome.status === 'atSetpoint') {
        estimate.minutes = outcome.status === 'ready' ? Math.max(1, Math.ceil(outcome.hours * 60)) : 0;
        estimate.readyAt = new Date(now + (estimate.minutes as number) * MINUTE_MS).toISOString();
    } else if (outcome.status === 'unreachable') {
        estimate.reachesAtMost = round(outcome.reachesAtMost, 1);
    }
    return estimate;
};

var allSetpoints = () => {
    const all: any = {};
    heating.BODIES.forEach((body: any) => {
        all[body] = {};
        heating.DEVICES.forEach((device: any) => {
            all[body][device] = setpoints.get(body, device);
        });
    });
    return all;
};

var validate = (body: any, device: any) => {
    if (!heating.BODIES.includes(body)) {
        throw new Error(`the body of water must be one of ${heating.BODIES.join(', ')}`);
    }
    if (!heating.DEVICES.includes(device)) {
        throw new Error(`the heating device must be one of ${heating.DEVICES.join(', ')}`);
    }
};

var badRequest = (e: any) => utils.respondWithCode(400, { code: 400, message: errorMessageOf(e) });

/**
 * the setpoint `device` uses for `body`
 **/
export function setpoint(body: any, device: any) {
    return setpoints.get(body, device);
};

/**
 * every setpoint, and what each heating device is doing with them
 *
 * returns Heating
 **/
export async function getHeating() {
    stateChanged();
    const state = stateSource();
    const target = heating.targetBody(state);
    const devices: any = {};
    heating.DEVICES.forEach((device: any) => {
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
export async function getSetpoint(body: any, device: any) {
    try {
        validate(body, device);
    } catch (e) {
        throw badRequest(e);
    }
    return { body: body, device: device, setpoint: setpoints.get(body, device), units: 'fahrenheit' };
};

/**
 * sets the temperature one heating device drives one body of water toward. With the
 * Settings-menu store this opens the panel's Settings row (Spa/Pool × Heater1/Heat Pump)
 * and taps +/−; otherwise the value is kept only in memory.
 *
 * returns SetpointChange
 **/
export async function setSetpoint(body: any, device: any, degrees: any, user: any) {
    const who = user && user.email ? user.email : 'unknown user';
    try {
        validate(body, device);
        if (!heating.isSetpoint(degrees)) {
            throw new Error(`a setpoint must be a whole number from ${heating.SETPOINT_MIN_F} to ${heating.SETPOINT_MAX_F}°F`);
        }
    } catch (e) {
        logger.warn(`REST ${who}: rejected ${body} ${device} setpoint ${degrees}: ${errorMessageOf(e)}`);
        throw badRequest(e);
    }

    const previous = setpoints.get(body, device);
    const what = `${heating.bodyLabels[body]} ${heating.deviceLabels[device]} setpoint`;
    if (previous === degrees) {
        logger.info(`REST ${who}: ${what} already ${degrees}°F`);
        activity.record(user, `Asked for a ${what} of ${degrees}°F; it already was`);
        return { body: body, device: device, setpoint: degrees, previousSetpoint: previous, units: 'fahrenheit' };
    }

    try {
        // the Settings-menu store returns a Promise; the in-memory and simulator stores do not
        await Promise.resolve(setpoints.set(body, device, degrees));
    } catch (e: any) {
        logger.warn(`REST ${who}: could not set ${what} to ${degrees}°F: ${errorMessageOf(e)}`);
        throw utils.respondWithCode(503, {
            code: 503,
            message: `couldn’t set the ${what} on the controller: ${errorMessageOf(e)}`
        });
    }
    logger.info(`REST ${who}: ${what} ${previous} -> ${degrees}°F${setpoints.reachesController ? '' : ' (kept by the server; not sent to the controller)'}`);
    activity.record(user, `Changed the ${what} from ${previous}°F to ${degrees}°F`);
    notifyChanged();
    return { body: body, device: device, setpoint: degrees, previousSetpoint: previous, units: 'fahrenheit' };
};
