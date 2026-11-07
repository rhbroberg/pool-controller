'use strict';
// Which body the heaters drive toward, and when an enabled one calls for heat.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const heating = require('../protocol/heating');

describe('heating rules', () => {
    it('drives toward the spa while the spa filter runs, whatever the flow', () => {
        for (const waterMode of ['pool', 'spa', 'spillover']) {
            assert.equal(heating.targetBody({ filter: true, spaFilter: true, waterMode }), 'spa');
            assert.equal(heating.targetBody({ filter: false, spaFilter: true, waterMode }), 'spa');
        }
    });

    it('drives toward the pool while the filter runs in pool or spillover flow, the spa in spa flow', () => {
        assert.equal(heating.targetBody({ filter: true, spaFilter: false, waterMode: 'pool' }), 'pool');
        assert.equal(heating.targetBody({ filter: true, spaFilter: false, waterMode: 'spillover' }), 'pool');
        assert.equal(heating.targetBody({ filter: true, spaFilter: false, waterMode: 'spa' }), 'spa');
    });

    it('has no target while no pump runs', () => {
        assert.equal(heating.targetBody({ filter: false, spaFilter: false, waterMode: 'pool' }), undefined);
    });

    it('calls for heat only below the setpoint, and only with both known', () => {
        assert.equal(heating.callsForHeat(79, 80), true);
        assert.equal(heating.callsForHeat(80, 80), false);
        assert.equal(heating.callsForHeat(81, 80), false);
        assert.equal(heating.callsForHeat(undefined, 80), false);
        assert.equal(heating.callsForHeat(79, null), false);
    });

    it('accepts whole-degree setpoints within the controller range', () => {
        assert.equal(heating.isSetpoint(heating.SETPOINT_MIN_F), true);
        assert.equal(heating.isSetpoint(heating.SETPOINT_MAX_F), true);
        assert.equal(heating.isSetpoint(heating.SETPOINT_MIN_F - 1), false);
        assert.equal(heating.isSetpoint(heating.SETPOINT_MAX_F + 1), false);
        assert.equal(heating.isSetpoint(80.5), false);
    });
});
