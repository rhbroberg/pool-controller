'use strict';
// What the learned model says about warming a body of water: how fast it is heating right now,
// and how long until it reaches the setpoint.
//
// With the heat sources on, the water is pulled toward the temperature where the heat going in
// equals the heat lost,
//
//     T∞ = air + G / k          G: what the sources and the sun add, k: the loss rate
//
// and approaches it exponentially, so the time from T0 to a setpoint S is
//
//     t = ln((T∞ − T0) / (T∞ − S)) / k
//
// If S is at or above T∞ the setpoint is out of reach at that air temperature. Each source stops
// at its own setpoint, so when they differ this works in stages: all of them until the lowest
// setpoint, then the rest. The sun fades toward evening, so the time is worked out again with
// the sun averaged over the time it came to, until it settles.

const { REFERENCE_AIR_F } = require('./fit');

// a setpoint that would take longer than this isn't worth promising
const LONGEST_HOURS = 72;
const STAGES = 4;
const PASSES = 4;
const CONVERGED_HOURS = 0.02;

var heaterRate = (model) => typeof model.heater === 'number' ? model.heater : null;

var pumpRate = (model, air) => model.heatPump
    ? Math.max(0, model.heatPump.base + model.heatPump.slope * (air - REFERENCE_AIR_F))
    : null;

var sourceRate = (model, name, air) => name === 'heater1' ? heaterRate(model) : pumpRate(model, air);

/**
 * how much each source warms the water at this air temperature, and what is lost, in °F per hour:
 * { heater, heatPump, solar, loss, net }; a source the model has no windows for is null and counts
 * as nothing in the net
 *
 *   sun  0 to 1, how much sun is on the water now
 **/
var currentRate = (model, { temperature, airTemperature, heater, heatPump, sun = 0 }) => {
    const added = {
        heater: heater ? heaterRate(model) : 0,
        heatPump: heatPump ? pumpRate(model, airTemperature) : 0
    };
    const solar = (model.solar || 0) * sun;
    const loss = -(model.loss || 0) * (temperature - airTemperature);
    return {
        heater: added.heater,
        heatPump: added.heatPump,
        solar,
        loss,
        net: (added.heater || 0) + (added.heatPump || 0) + solar + loss
    };
};

var onePass = (model, temperature, airTemperature, sources, sunnyness) => {
    const loss = model.loss || 0;
    const solar = (model.solar || 0) * sunnyness;
    let t = temperature;
    let hours = 0;
    let reached;
    for (let stage = 0; stage < STAGES; stage++) {
        const active = sources.filter((source) => source.setpoint > t);
        if (active.length === 0) {
            break;
        }
        const added = active.reduce((sum, source) => sum + sourceRate(model, source.name, airTemperature), solar);
        const target = Math.min(...active.map((source) => source.setpoint));
        const limit = loss > 0 ? airTemperature + added / loss : Infinity;
        if (added <= 0 || target >= limit - 0.05) {
            return { status: 'unreachable', reachesAtMost: Number.isFinite(limit) ? Math.max(t, limit) : t };
        }
        hours += loss > 0 ? Math.log((limit - t) / (limit - target)) / loss : (target - t) / added;
        t = target;
        reached = target;
        if (hours > LONGEST_HOURS) {
            return { status: 'unreachable', reachesAtMost: t, tooSlow: true };
        }
    }
    if (reached === undefined) {
        return { status: 'atSetpoint' };
    }
    return { status: 'ready', hours, setpoint: Math.max(...sources.map((source) => source.setpoint)) };
};

/**
 * how long until the sources reach their setpoints, from `temperature` in `airTemperature`:
 *
 *   sources  [{ name: 'heater1' | 'heatpump', setpoint }]
 *   sun      (hours) => the average sun, 0 to 1, over that many hours from now
 *
 * returns { status: 'atSetpoint' } when none has anything left to do, { status: 'ready', hours,
 * setpoint } with the highest setpoint reached, { status: 'unreachable', reachesAtMost } when
 * the air is too cold for it, or { status: 'insufficientData', missing } when the model has
 * nothing for a source that is on
 **/
var timeToReach = (model, { temperature, airTemperature, sources, sun = () => 0 }) => {
    const missing = sources.find((source) => sourceRate(model, source.name, airTemperature) === null);
    if (missing) {
        return { status: 'insufficientData', missing: missing.name };
    }
    let result = onePass(model, temperature, airTemperature, sources, sun(1));
    for (let pass = 1; pass < PASSES && result.status === 'ready'; pass++) {
        const next = onePass(model, temperature, airTemperature, sources, sun(Math.max(result.hours, 0.25)));
        const settled = next.status === 'ready' && Math.abs(next.hours - result.hours) < CONVERGED_HOURS;
        result = next;
        if (settled) {
            break;
        }
    }
    return result;
};

module.exports = { timeToReach, currentRate, heaterRate, pumpRate, LONGEST_HOURS };
