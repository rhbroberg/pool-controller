// What the dashboard says about equipment, water flow and readings.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EQUIPMENT, tileState, waterModeOf, measurement, weatherSummary, passwordProblem, passwordAcceptable, displayName, eventKindOf, signInOutcome, methodNames, aboutLine, TASKS, taskOn, scheduledPreheat, scheduleText } from '../public/js/model.js';

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

describe('weather', () => {
    const weather = (today, extra = {}) => ({ configured: true, location: { zipCode: '32801', placeName: 'Orlando, FL' }, today, fetchedAt: new Date(), stale: false, ...extra });

    it('shows today’s condition and high and low', () => {
        assert.deepEqual(weatherSummary(weather({ high: 87.6, low: 71.2, condition: 'sunny', precipitationProbability: 10 })), {
            title: 'Sunny', icon: 'sun', highLow: '88° / 71°', place: 'Orlando, FL', rain: null, isStale: false
        });
    });

    it('mentions a real chance of rain and an out-of-date forecast', () => {
        const summary = weatherSummary(weather({ high: 75, low: 60, condition: 'rain', precipitationProbability: 80 }, { stale: true }));
        assert.equal(summary.title, 'Rain');
        assert.equal(summary.icon, 'cloudRain');
        assert.equal(summary.rain, '80% chance of rain');
        assert.equal(summary.isStale, true);
    });

    it('shows nothing without a zip code or before the first forecast', () => {
        assert.equal(weatherSummary(null), null);
        assert.equal(weatherSummary({ configured: false, location: null, today: null }), null);
        assert.equal(weatherSummary(weather(null)), null);
    });

    it('copes with a missing temperature or an unknown condition', () => {
        const summary = weatherSummary(weather({ high: null, low: 60, condition: null }));
        assert.equal(summary.highLow, '--° / 60°');
        assert.equal(summary.title, 'Today');
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

describe('sign-in services', () => {
    const outcome = (query) => signInOutcome(new URLSearchParams(query));

    it('reads a ticket to trade for a token', () => {
        assert.deepEqual(outcome('ticket=abc'), { ticket: 'abc' });
    });

    it('explains each way a sign-in can stop short', () => {
        assert.match(outcome('status=pending&provider=Google').message, /sign in with Google was sent to the pool’s admin/);
        assert.equal(outcome('status=denied&provider=Google').failed, true);
        assert.match(outcome('status=refused').message, /invited/);
        assert.equal(outcome('status=cancelled').title, 'Sign-In Cancelled');
        assert.equal(outcome('status=linked&provider=Google').linked, true);
        assert.equal(outcome('error=The service said no').message, 'The service said no');
        assert.equal(outcome('').failed, true);
    });

    it('names how an account signs in', () => {
        assert.deepEqual(methodNames(['password', 'google', 'gone'], [{ id: 'google', displayName: 'Google' }]), ['Password', 'Google', 'gone']);
        assert.deepEqual(methodNames(undefined), []);
    });
});

describe('about line', () => {
    it('names the web, server and API builds', () => {
        assert.equal(aboutLine('a1b2c3d', { commit: 'e4f5a6b-dirty', apiVersion: '1.0.0' }), 'Web a1b2c3d · Server e4f5a6b-dirty · API 1.0.0');
    });

    it('shows a dash for a build it doesn’t know', () => {
        assert.equal(aboutLine(null, null), 'Web — · Server — · API —');
        assert.equal(aboutLine('a1b2c3d', { service: 'pool-controller', version: '1.0.0' }), 'Web a1b2c3d · Server — · API —');
    });
});

describe('tasks', () => {
    const scheduled = (readyAt, startAt) => ({
        pool: { on: true },
        spaPreheat: { on: false, scheduled: { readyAt: readyAt.toISOString(), startAt: startAt.toISOString(), leadMinutes: 90, leadFrom: 'rate' } },
        spaParty: { on: false },
        dark: true
    });

    it('lists pool, spa preheat and spa party, each on as the server says', () => {
        assert.deepEqual(TASKS.map((task) => task.id), ['pool', 'spaPreheat', 'spaParty']);
        const now = new Date(2026, 10, 12, 15, 0);
        const tasks = scheduled(new Date(2026, 10, 12, 19, 30), new Date(2026, 10, 12, 18, 0));
        assert.equal(taskOn(tasks, 'pool'), true);
        assert.equal(taskOn(tasks, 'spaPreheat'), false);
        assert.equal(taskOn(null, 'pool'), false);
        assert.ok(scheduledPreheat(tasks));
        const text = scheduleText(scheduledPreheat(tasks), now);
        assert.match(text.ready, /^Ready by 7:30/);
        assert.match(text.start, /^Starts about 6:00/);
    });

    it('says when a preheat is ready on another day, and when it is starting now', () => {
        const now = new Date(2026, 10, 12, 18, 30);
        const tasks = scheduled(new Date(2026, 10, 13, 7, 0), new Date(2026, 10, 12, 18, 0));
        const text = scheduleText(scheduledPreheat(tasks), now);
        assert.match(text.ready, /^Ready by Fri 7:00/);
        assert.equal(text.start, 'Starting now');
    });

    it('has no schedule once the preheat is on', () => {
        const tasks = scheduled(new Date(), new Date());
        tasks.spaPreheat.on = true;
        assert.equal(scheduledPreheat(tasks), null);
    });
});
