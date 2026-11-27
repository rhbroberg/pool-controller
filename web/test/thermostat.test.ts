import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { thermostatMath } from '../public/js/views/thermostat.js';

const { angleFor, valueForAngle, clamp, ARC_START, ARC_SWEEP } = thermostatMath;

describe('thermostat dial', () => {
    it('maps the ends of the range to the arc ends', () => {
        assert.equal(angleFor(65, 65, 104), ARC_START);
        assert.equal(angleFor(104, 65, 104), ARC_START + ARC_SWEEP);
    });

    it('round-trips mid-range values through the arc', () => {
        for (const degrees of [65, 72, 80, 91, 104]) {
            const angle = angleFor(degrees, 65, 104);
            assert.equal(valueForAngle(angle, 65, 104), degrees);
        }
    });

    it('clamps values into the allowed band', () => {
        assert.equal(clamp(60, 65, 104), 65);
        assert.equal(clamp(110, 65, 104), 104);
        assert.equal(clamp(84, 65, 104), 84);
    });
});
