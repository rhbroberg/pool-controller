// What the dashboard says about equipment, water flow and readings.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EQUIPMENT, tileState, waterModeOf, measurement, passwordProblem, passwordAcceptable, displayName, eventKindOf } from '../public/js/model.js';

const control = (name) => EQUIPMENT.find((c) => c.name === name);
const reading = (name, value) => ({ name, category: 'status', value, timestamp: new Date() });

describe('equipment tiles', () => {
    it('shows on and off for plain switches, and running only while on', () => {
        assert.deepEqual(tileState(control('filter'), true, undefined, null), { running: true, text: 'On', targetSetpoint: null });
        assert.deepEqual(tileState(control('filter'), false, undefined, null), { running: false, text: 'Off', targetSetpoint: null });
    });

    it('says what a pending change is waiting for', () => {
        assert.equal(tileState(control('filter'), false, true, null).text, 'Turning On…');
        assert.equal(tileState(control('heater1'), false, true, null).text, 'To Auto…');
    });

    it('uses the heater’s Auto and Manual Off', () => {
        assert.equal(tileState(control('heater1'), false, undefined, null).text, 'Manual Off');
    });

    it('tells heating apart from enabled, and shows the setpoint being driven toward', () => {
        const heating = { enabled: true, heating: true, callingForHeat: true, body: 'pool', setpoint: 84, temperature: 70 };
        assert.deepEqual(tileState(control('heater1'), true, undefined, heating), { running: true, text: 'Heating pool', targetSetpoint: 84 });
        const waiting = { ...heating, heating: false };
        assert.deepEqual(tileState(control('valve4'), true, undefined, waiting), { running: false, text: 'Waiting · pool', targetSetpoint: 84 });
        const reached = { ...heating, heating: false, callingForHeat: false, body: 'spa', temperature: 102 };
        assert.equal(tileState(control('heater1'), true, undefined, reached).text, 'Spa at setpoint');
    });

    it('says when no pump runs, so no water reaches the heaters', () => {
        const idle = { enabled: true, heating: false, callingForHeat: false, body: null, setpoint: null, temperature: null };
        assert.equal(tileState(control('heater1'), true, undefined, idle).text, 'Auto · pump off');
    });

    it('hides the setpoint while a change is pending', () => {
        const heating = { enabled: true, heating: true, callingForHeat: true, body: 'pool', setpoint: 84, temperature: 70 };
        assert.equal(tileState(control('heater1'), true, false, heating).targetSetpoint, null);
    });

    it('asks before starting super chlorination only', () => {
        assert.ok(control('superchlorinate').confirmOn);
        assert.equal(control('superchlorinate').confirmOff, undefined);
        assert.equal(control('filter').confirmOn, undefined);
    });

    it('uses this panel’s names for its aux outputs', () => {
        assert.equal(displayName('aux14'), 'Spa Filter');
        assert.equal(displayName('valve4'), 'Heat Pump');
        assert.equal(displayName('valve3'), 'Valve3');
    });
});

describe('water flow', () => {
    it('is spillover, then spa, then pool, and unknown before the pool switch is reported', () => {
        assert.equal(waterModeOf([]), null);
        assert.equal(waterModeOf([reading('pool', 1)]), 'pool');
        assert.equal(waterModeOf([reading('pool', 0), reading('spa', 1)]), 'spa');
        assert.equal(waterModeOf([reading('spa', 1), reading('spillover', 1)]), 'spillover');
    });

    it('accepts true and false as well as 1 and 0', () => {
        assert.equal(waterModeOf([reading('pool', false), reading('spa', true)]), 'spa');
    });
});

describe('measurements', () => {
    it('dims a temperature while its pump is off', () => {
        const readings = [{ name: 'pool temp', category: 'info', value: 81, timestamp: new Date() }, reading('filter', 0)];
        assert.deepEqual(measurement(readings, 'pool temp'), { name: 'pool temp', title: 'Pool', value: '81°F', isDimmed: true });
        assert.equal(measurement([...readings.slice(0, 1), reading('filter', 1)], 'pool temp').isDimmed, false);
    });

    it('keeps a slot for readings that have not arrived', () => {
        assert.equal(measurement([], 'salt').value, '-- ppm');
        assert.equal(measurement([], 'ambient').value, '--°F');
        assert.equal(measurement([], 'ambient').isDimmed, false);
    });
});

describe('passwords', () => {
    it('explains a short or mismatched password once something is typed', () => {
        assert.equal(passwordProblem('', ''), null);
        assert.match(passwordProblem('abc', ''), /at least 6/);
        assert.match(passwordProblem('abcdef', 'abcdeg'), /match/);
        assert.equal(passwordAcceptable('abcdef', 'abcdef'), true);
        assert.equal(passwordAcceptable('abcdef', ''), false);
    });
});

describe('event kinds', () => {
    it('groups the server’s failure types as communication errors', () => {
        assert.equal(eventKindOf('failed').id, 'protocolErrors');
        assert.equal(eventKindOf('unrecognized').id, 'protocolErrors');
        assert.equal(eventKindOf('action').id, 'actions');
    });
});
