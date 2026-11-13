'use strict';
// The admin's heating rules standing in for what history hasn't taught the model.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../heating/rules');
const { timeToReach } = require('../heating/estimate');

describe('heating rules for estimates', () => {
    const spaRules = { heater: 20, heatPump: 4 };

    it('times a body with no model by its rules alone, losing nothing to the air', () => {
        const effective = rules.effectiveModel({ available: false, reason: 'needs at least 5 windows; has 1' }, spaRules);
        assert.equal(effective.fromRules, true);
        assert.deepEqual(rules.basisFor(effective, ['heater1', 'heatpump']), { basis: 'rule', ruleSources: ['heater1', 'heatpump'] });
        const both = timeToReach(effective.model, { temperature: 80, airTemperature: 40, sources: [{ name: 'heater1', setpoint: 104 }, { name: 'heatpump', setpoint: 104 }] });
        assert.equal(both.status, 'ready');
        assert.ok(Math.abs(both.hours - 24 / 24) < 1e-9, `${both.hours} hours at 24°F an hour`);
        const pumpOnly = timeToReach(effective.model, { temperature: 100, airTemperature: 40, sources: [{ name: 'heatpump', setpoint: 102 }] });
        assert.ok(Math.abs(pumpOnly.hours - 0.5) < 1e-9);
        assert.deepEqual(rules.basisFor(effective, ['heatpump']).ruleSources, ['heatpump']);
    });

    it('fills in only the source the model has no rate for', () => {
        const learned = { available: true, heater: null, heatPump: { base: 0.55, slope: 0, referenceAirTemperature: 60 }, loss: 0.012, solar: 0.4 };
        const effective = rules.effectiveModel(learned, { heater: 1, heatPump: 0.5 });
        assert.equal(effective.fromRules, false);
        assert.equal(effective.model.heater, 1);
        assert.equal(effective.model.heatPump.base, 0.55, 'the learned heat pump stays');
        assert.equal(effective.model.loss, 0.012);
        assert.deepEqual(rules.basisFor(effective, ['heatpump']), { basis: 'history', ruleSources: [] });
        assert.deepEqual(rules.basisFor(effective, ['heater1', 'heatpump']), { basis: 'mixed', ruleSources: ['heater1'] });
        assert.equal(learned.heater, null, 'the saved model is left alone');
    });

    it('fills stored rules in from the defaults, and checks a change', () => {
        const complete = rules.complete({ spa: { heater: 30 } });
        assert.equal(complete.spa.heater, 30);
        assert.equal(complete.spa.heatPump, rules.DEFAULT_RULES.spa.heatPump);
        assert.deepEqual(complete.pool, rules.DEFAULT_RULES.pool);

        assert.deepEqual(rules.validate({ pool: { heatPump: 0.8 } }), { valid: { pool: { heatPump: 0.8 } } });
        assert.ok(rules.validate({ spa: { heater: 0 } }).problem);
        assert.ok(rules.validate({ spa: { solar: 2 } }).problem);
        assert.ok(rules.validate({ hottub: { heater: 2 } }).problem);
        assert.ok(rules.validate([]).problem);
    });
});
