'use strict';
// Simple rules standing in for what history hasn't taught the model: how fast each heat source
// warms each body of water, in °F per hour, as an admin sets them. A body of water without a
// model is timed by its rules alone, with nothing lost to the air; a model that has no rate for
// a source borrows that source's rule. A later model that learns the rate takes over from it.

const BODIES = ['pool', 'spa'];
const SOURCES = ['heater', 'heatPump'];
// rough figures for a residential pool and spa; an admin sets this installation's own
const DEFAULT_RULES = {
    pool: { heater: 1, heatPump: 0.5 },
    spa: { heater: 20, heatPump: 4 }
};
const MIN_RATE = 0.1;
const MAX_RATE = 120;
// the device names estimates use, for each rule
const DEVICE = { heater: 'heater1', heatPump: 'heatpump' };

var defaults = () => JSON.parse(JSON.stringify(DEFAULT_RULES));

/** rules as stored, filled in from the defaults where they say nothing */
var complete = (stored) => {
    const rules = defaults();
    BODIES.forEach((body) => SOURCES.forEach((source) => {
        const value = stored && stored[body] ? stored[body][source] : undefined;
        if (typeof value === 'number' && Number.isFinite(value)) {
            rules[body][source] = value;
        }
    }));
    return rules;
};

/**
 * the change asked for, as { body: { source: rate } }, or a message saying what's wrong with it
 **/
var validate = (changes) => {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
        return { problem: 'heatingRules must be an object such as { "spa": { "heater": 20 } }' };
    }
    const valid = {};
    for (const [body, rates] of Object.entries(changes)) {
        if (!BODIES.includes(body) || !rates || typeof rates !== 'object') {
            return { problem: `heating rules are for ${BODIES.join(' and ')}, each with ${SOURCES.join(' and ')}` };
        }
        for (const [source, rate] of Object.entries(rates)) {
            if (!SOURCES.includes(source)) {
                return { problem: `heating rules are for the ${SOURCES.join(' and ')}` };
            }
            if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) {
                return { problem: `a heating rule must be ${MIN_RATE} to ${MAX_RATE}°F per hour` };
            }
            valid[body] = Object.assign(valid[body] || {}, { [source]: rate });
        }
    }
    return { valid };
};

/**
 * the model to time `bodyModel`'s water with, and which sources' rules it borrowed:
 * { model, ruled: ['heater1', 'heatpump'], fromRules } where fromRules is true when the body has
 * no model at all
 **/
var effectiveModel = (bodyModel, rules) => {
    const heatPumpRule = (rate) => ({ base: rate, slope: 0 });
    if (!bodyModel || !bodyModel.available) {
        return {
            model: { heater: rules.heater, heatPump: heatPumpRule(rules.heatPump), loss: 0, solar: 0 },
            ruled: [DEVICE.heater, DEVICE.heatPump],
            fromRules: true
        };
    }
    const model = Object.assign({}, bodyModel);
    const ruled = [];
    if (typeof model.heater !== 'number') {
        model.heater = rules.heater;
        ruled.push(DEVICE.heater);
    }
    if (!model.heatPump) {
        model.heatPump = heatPumpRule(rules.heatPump);
        ruled.push(DEVICE.heatPump);
    }
    return { model, ruled, fromRules: false };
};

/**
 * 'history' when the sources at work were all learned, 'rule' when the body has no model, and
 * 'mixed' when a source at work borrowed its rule; with which of `devices` did
 **/
var basisFor = (effective, devices) => {
    const ruled = devices.filter((device) => effective.ruled.includes(device));
    if (effective.fromRules) {
        return { basis: 'rule', ruleSources: ruled };
    }
    return { basis: ruled.length > 0 ? 'mixed' : 'history', ruleSources: ruled };
};

module.exports = { BODIES, SOURCES, DEFAULT_RULES, MIN_RATE, MAX_RATE, complete, validate, effectiveModel, basisFor };
