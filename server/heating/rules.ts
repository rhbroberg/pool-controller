'use strict';
// Simple rules standing in for what history hasn't taught the model: how fast each heat source
// warms each body of water, in °F per hour, as an admin sets them. A body of water without a
// model is timed by its rules alone, with nothing lost to the air; a model that has no rate for
// a source borrows that source's rule. A later model that learns the rate takes over from it.

import type { HeatingBodyRules, HeatingRules } from '../types/domain';

const BODIES = ['pool', 'spa'] as const;
const SOURCES = ['heater', 'heatPump'] as const;
type BodyId = typeof BODIES[number];
type SourceId = typeof SOURCES[number];

// rough figures for a residential pool and spa; an admin sets this installation's own
const DEFAULT_RULES: HeatingRules = {
    pool: { heater: 1, heatPump: 0.5 },
    spa: { heater: 20, heatPump: 4 }
};
const MIN_RATE = 0.1;
const MAX_RATE = 120;
// the device names estimates use, for each rule
const DEVICE: Record<SourceId, string> = { heater: 'heater1', heatPump: 'heatpump' };

export interface HeatPumpRate {
    base: number;
    slope: number;
}

export interface BodyHeatingModel {
    available?: boolean;
    heater?: number | null;
    heatPump?: HeatPumpRate | null;
    loss?: number;
    solar?: number;
    [key: string]: unknown;
}

export interface EffectiveModel {
    model: {
        heater: number | null | undefined;
        heatPump: HeatPumpRate | null | undefined;
        loss: number;
        solar: number;
    };
    ruled: string[];
    fromRules: boolean;
}

const defaults = (): HeatingRules => JSON.parse(JSON.stringify(DEFAULT_RULES)) as HeatingRules;

/** rules as stored, filled in from the defaults where they say nothing */
const complete = (stored: Partial<HeatingRules> | null | undefined): HeatingRules => {
    const rules = defaults();
    BODIES.forEach((body) => SOURCES.forEach((source) => {
        const value = stored && stored[body] ? stored[body]![source] : undefined;
        if (typeof value === 'number' && Number.isFinite(value)) {
            rules[body][source] = value;
        }
    }));
    return rules;
};

/**
 * the change asked for, as { body: { source: rate } }, or a message saying what's wrong with it
 **/
const validate = (
    changes: unknown
): { problem: string; valid?: undefined } | { valid: Partial<HeatingRules>; problem?: undefined } => {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
        return { problem: 'heatingRules must be an object such as { "spa": { "heater": 20 } }' };
    }
    const valid: Partial<Record<BodyId, Partial<HeatingBodyRules>>> = {};
    for (const [body, rates] of Object.entries(changes as Record<string, unknown>)) {
        if (!(BODIES as readonly string[]).includes(body) || !rates || typeof rates !== 'object') {
            return { problem: `heating rules are for ${BODIES.join(' and ')}, each with ${SOURCES.join(' and ')}` };
        }
        for (const [source, rate] of Object.entries(rates as Record<string, unknown>)) {
            if (!(SOURCES as readonly string[]).includes(source)) {
                return { problem: `heating rules are for the ${SOURCES.join(' and ')}` };
            }
            if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) {
                return { problem: `a heating rule must be ${MIN_RATE} to ${MAX_RATE}°F per hour` };
            }
            valid[body as BodyId] = Object.assign(valid[body as BodyId] || {}, { [source]: rate });
        }
    }
    return { valid: valid as Partial<HeatingRules> };
};

/**
 * the model to time `bodyModel`'s water with, and which sources' rules it borrowed:
 * { model, ruled: ['heater1', 'heatpump'], fromRules } where fromRules is true when the body has
 * no model at all
 **/
const effectiveModel = (bodyModel: BodyHeatingModel | null | undefined, rules: HeatingBodyRules): EffectiveModel => {
    const heatPumpRule = (rate: number): HeatPumpRate => ({ base: rate, slope: 0 });
    if (!bodyModel || !bodyModel.available) {
        return {
            model: { heater: rules.heater, heatPump: heatPumpRule(rules.heatPump), loss: 0, solar: 0 },
            ruled: [DEVICE.heater, DEVICE.heatPump],
            fromRules: true
        };
    }
    const model = Object.assign({}, bodyModel) as BodyHeatingModel & {
        heater?: number | null;
        heatPump?: HeatPumpRate | null;
        loss?: number;
        solar?: number;
    };
    const ruled: string[] = [];
    if (typeof model.heater !== 'number') {
        model.heater = rules.heater;
        ruled.push(DEVICE.heater);
    }
    if (!model.heatPump) {
        model.heatPump = heatPumpRule(rules.heatPump);
        ruled.push(DEVICE.heatPump);
    }
    return {
        model: {
            heater: model.heater,
            heatPump: model.heatPump,
            loss: model.loss || 0,
            solar: model.solar || 0
        },
        ruled,
        fromRules: false
    };
};

/**
 * 'history' when the sources at work were all learned, 'rule' when the body has no model, and
 * 'mixed' when a source at work borrowed its rule; with which of `devices` did
 **/
const basisFor = (effective: EffectiveModel, devices: string[]): { basis: string; ruleSources: string[] } => {
    const ruled = devices.filter((device) => effective.ruled.includes(device));
    if (effective.fromRules) {
        return { basis: 'rule', ruleSources: ruled };
    }
    return { basis: ruled.length > 0 ? 'mixed' : 'history', ruleSources: ruled };
};

export { BODIES, SOURCES, DEFAULT_RULES, MIN_RATE, MAX_RATE, complete, validate, effectiveModel, basisFor };
