'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { WindowExtractor } = require('../heating/windows');
const { fitBody } = require('../heating/fit');
const { timeToReach, currentRate } = require('../heating/estimate');
const sun = require('../heating/sun');
const { START, TRUTH, sunAt, simulate, cyclePlan, MINUTE, HOUR } = require('./helpers/heating-history');

var windowsOf = (events, options) => {
    const extractor = new WindowExtractor({}, Object.assign({ sun: sunAt }, options));
    events.forEach((event) => extractor.push(event));
    return extractor.finish(events[events.length - 1].t);
};

var near = (actual, expected, tolerance, label) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`);

test('the extractor finds a window for each run with the right sources and slope', () => {
    const windows = windowsOf(simulate({ days: 2, plan: () => ({ heater: 0, pump: 1, air: 70 }) }), {});
    const heating = windows.filter((window) => window.sources === 'heatpump' && window.suitable);
    assert.ok(heating.length >= 1, 'a heat pump window');
    const expected = TRUTH.pumpBase + TRUTH.pumpSlope * 10;
    assert.ok(heating[0].slope > expected - 0.7 && heating[0].slope < expected + 1, `slope ${heating[0].slope}`);
    assert.ok(windows.some((window) => window.sources === 'cooling' && window.suitable), 'a cooling window');
    assert.equal(windows.filter((window) => window.suitable).every((window) => window.body === 'pool'), true);
});

test('the start of a run, while the sensor still shows what was before, is left out', () => {
    // the water reads 60 for 10 minutes after the pump starts, then jumps to the true 80
    const events = [];
    events.push({ t: START, type: 'info', status: [{ name: 'pool temp', value: 60 }, { name: 'ambient', value: 70 }] });
    events.push({ t: START + 1 * MINUTE, type: 'status', status: [{ name: 'filter', value: 1 }] });
    for (let minute = 5; minute <= 180; minute += 5) {
        events.push({ t: START + minute * MINUTE, type: 'info', status: [{ name: 'pool temp', value: minute < 12 ? 60 : 80 }, { name: 'ambient', value: 70 }] });
    }
    const windows = windowsOf(events, {});
    const window = windows.find((candidate) => candidate.sources === 'cooling' && candidate.suitable);
    assert.ok(window, 'a window');
    near(window.slope, 0, 0.05, 'flat after the settle period');
});

test('a heater that flickers off and on is one run', () => {
    const events = [{ t: START, type: 'info', status: [{ name: 'pool temp', value: 70 }, { name: 'ambient', value: 70 }] }];
    const at = (minute, name, value) => events.push({ t: START + minute * MINUTE, type: 'status', status: [{ name, value }] });
    at(1, 'filter', 1);
    at(2, 'heater1', 1);
    at(60, 'heater1', 0);
    at(61, 'heater1', 1);
    at(180, 'heater1', 0);
    for (let minute = 5; minute <= 190; minute += 5) {
        events.push({ t: START + minute * MINUTE, type: 'info', status: [{ name: 'pool temp', value: 70 + Math.floor(minute / 30) }, { name: 'ambient', value: 70 }] });
    }
    events.sort((a, b) => a.t - b.t);
    const windows = windowsOf(events, {}).filter((window) => window.sources === 'heater');
    assert.equal(windows.length, 1);
    assert.ok(windows[0].hours > 2.5);
});

test('silence from the controller ends a run and forgets the switches', () => {
    const events = [
        { t: START, type: 'info', status: [{ name: 'pool temp', value: 70 }, { name: 'ambient', value: 70 }] },
        { t: START + 1 * MINUTE, type: 'status', status: [{ name: 'filter', value: 1 }] }
    ];
    for (let minute = 5; minute <= 120; minute += 5) {
        events.push({ t: START + minute * MINUTE, type: 'info', status: [{ name: 'pool temp', value: 70 }, { name: 'ambient', value: 70 }] });
    }
    // the server was down; when it comes back the filter's state isn't known and not reported
    events.push({ t: START + 10 * HOUR, type: 'info', status: [{ name: 'pool temp', value: 90 }, { name: 'ambient', value: 70 }] });
    events.push({ t: START + 11 * HOUR, type: 'info', status: [{ name: 'pool temp', value: 90 }, { name: 'ambient', value: 70 }] });
    const windows = windowsOf(events, {});
    assert.ok(windows.every((window) => window.end <= START + 2.1 * HOUR), 'nothing is made of the silence');
});

test('the fit recovers the heater, heat pump, loss and sun of a simulated pool', () => {
    const windows = windowsOf(simulate({ days: 120, plan: cyclePlan, noise: 0.01 }), {}).filter((window) => window.suitable);
    const fit = fitBody(windows);
    assert.equal(fit.available, true);
    near(fit.heater, TRUTH.heater, 0.35, 'heater');
    near(fit.heatPump.base, TRUTH.pumpBase, 0.35, 'heat pump');
    near(fit.loss, TRUTH.loss, 0.012, 'loss');
    near(fit.solar, TRUTH.solar, 0.35, 'sun');
    assert.ok(fit.rSquared > 0.5, `R² ${fit.rSquared}`);
    assert.ok(fit.windows.heater > 0 && fit.windows.heatpump > 0 && fit.windows.both > 0 && fit.windows.cooling > 0);
});

test('a heat pump that weakens in cold air is seen in the heat pump windows', () => {
    const truth = Object.assign({}, TRUTH, { pumpBase: 0.8, pumpSlope: 0.04 });
    const events = simulate({ days: 160, plan: (day) => ({ heater: 0, pump: 1, air: 45 + (day * 11) % 50 }), truth });
    const fit = fitBody(windowsOf(events, {}).filter((window) => window.suitable));
    assert.ok(fit.heatPump.slope > 0.015, `slope ${fit.heatPump.slope}`);
    assert.ok(fit.heatPump.minimumAirTemperature < 60);
});

test('with no heater windows the heater is not made up', () => {
    const events = simulate({ days: 60, plan: (day) => ({ heater: 0, pump: 1, air: 55 + (day * 7) % 35 }) });
    const fit = fitBody(windowsOf(events, {}).filter((window) => window.suitable));
    assert.equal(fit.available, true);
    assert.equal(fit.heater, null);
    assert.ok(fit.heatPump.base > 0.3);
});

test('too few windows is not enough to fit', () => {
    const fit = fitBody([]);
    assert.equal(fit.available, false);
    assert.match(fit.reason, /at least/);
});

test('a window that stands far apart from the rest is set aside', () => {
    const windows = windowsOf(simulate({ days: 120, plan: cyclePlan }), {}).filter((window) => window.suitable);
    const bad = windows.filter((window) => window.sources === 'heatpump').slice(0, 3).map((window) => Object.assign({}, window, { slope: -3 }));
    const rest = windows.filter((window) => !bad.some((other) => other.id === window.id));
    const fit = fitBody(rest.concat(bad));
    assert.ok(fit.outliers >= 3, `${fit.outliers} set aside`);
    near(fit.heatPump.base, TRUTH.pumpBase, 0.4, 'heat pump');
});

var MODEL = { available: true, heater: 2, heatPump: { base: 1, slope: 0.02, referenceAirTemperature: 60 }, loss: 0.02, solar: 0.4 };

test('the time to the setpoint is exact for a model with a known answer', () => {
    // 70 → 80 with 1°F/h in and no loss is ten hours
    const result = timeToReach({ heater: 1, heatPump: null, loss: 0, solar: 0 }, {
        temperature: 70,
        airTemperature: 60,
        sources: [{ name: 'heater1', setpoint: 80 }]
    });
    assert.equal(result.status, 'ready');
    near(result.hours, 10, 1e-9, 'hours');
});

test('losing heat makes it take longer, and a colder day longer still', () => {
    var hours = (air) => timeToReach(MODEL, { temperature: 80, airTemperature: air, sources: [{ name: 'heatpump', setpoint: 84 }] });
    const warm = hours(80);
    const cool = hours(60);
    assert.equal(warm.status, 'ready');
    assert.equal(cool.status, 'ready');
    assert.ok(cool.hours > warm.hours, `${cool.hours} should be more than ${warm.hours}`);
    // the closed form: T∞ = air + G/k, t = ln((T∞−T)/(T∞−S))/k
    const g = 1 + 0.02 * (60 - 60);
    const limit = 60 + g / 0.02;
    near(cool.hours, Math.log((limit - 80) / (limit - 84)) / 0.02, 1e-9, 'closed form');
});

test('a setpoint beyond what the sources can hold against the loss is unreachable', () => {
    const result = timeToReach({ heater: 0.5, heatPump: null, loss: 0.05, solar: 0 }, {
        temperature: 80,
        airTemperature: 50,
        sources: [{ name: 'heater1', setpoint: 90 }]
    });
    // T∞ = 50 + 0.5/0.05 = 60, so it can't even hold 80
    assert.equal(result.status, 'unreachable');
    assert.ok(result.reachesAtMost <= 80);
});

test('two sources with different setpoints work in stages', () => {
    const model = { heater: 1, heatPump: { base: 1, slope: 0, referenceAirTemperature: 60 }, loss: 0, solar: 0 };
    const result = timeToReach(model, {
        temperature: 70,
        airTemperature: 70,
        sources: [{ name: 'heatpump', setpoint: 74 }, { name: 'heater1', setpoint: 78 }]
    });
    // both add 2°F/h for the first four degrees (2h), then the heater alone adds 1°F/h for four (4h)
    assert.equal(result.status, 'ready');
    assert.equal(result.setpoint, 78);
    near(result.hours, 6, 1e-9, 'hours');
});

test('a source already at its setpoint adds nothing to the time', () => {
    const model = { heater: 1, heatPump: { base: 1, slope: 0, referenceAirTemperature: 60 }, loss: 0, solar: 0 };
    assert.equal(timeToReach(model, { temperature: 80, airTemperature: 70, sources: [{ name: 'heatpump', setpoint: 78 }] }).status, 'atSetpoint');
    const result = timeToReach(model, { temperature: 78, airTemperature: 70, sources: [{ name: 'heatpump', setpoint: 78 }, { name: 'heater1', setpoint: 80 }] });
    assert.equal(result.status, 'ready');
    near(result.hours, 2, 1e-9, 'hours');
});

test('a source the model knows nothing of cannot be timed', () => {
    const result = timeToReach({ heater: null, heatPump: { base: 1, slope: 0, referenceAirTemperature: 60 }, loss: 0, solar: 0 }, {
        temperature: 70,
        airTemperature: 70,
        sources: [{ name: 'heater1', setpoint: 80 }]
    });
    assert.deepEqual(result, { status: 'insufficientData', missing: 'heater1' });
});

test('the sun fading toward evening lengthens the time', () => {
    const model = { heater: 0, heatPump: { base: 0.5, slope: 0, referenceAirTemperature: 60 }, loss: 0.01, solar: 1 };
    const request = { temperature: 80, airTemperature: 75, sources: [{ name: 'heatpump', setpoint: 84 }] };
    const noon = timeToReach(model, Object.assign({ sun: () => 1 }, request));
    const dusk = timeToReach(model, Object.assign({ sun: () => 0 }, request));
    assert.ok(dusk.hours > noon.hours);
});

test('the current rate adds each source on, the sun, and takes away the loss', () => {
    const rate = currentRate(MODEL, { temperature: 84, airTemperature: 70, heater: true, heatPump: true, sun: 0.5 });
    near(rate.heater, 2, 1e-9, 'heater');
    near(rate.heatPump, 1.2, 1e-9, 'heat pump');
    near(rate.solar, 0.2, 1e-9, 'sun');
    near(rate.loss, -0.28, 1e-9, 'loss');
    near(rate.net, 2 + 1.2 + 0.2 - 0.28, 1e-9, 'net');
    assert.equal(currentRate(MODEL, { temperature: 84, airTemperature: 70, heater: false, heatPump: false }).heater, 0);
});

test('the sun is zero at night and highest at midday', () => {
    assert.equal(sun.atLocalHour(2), 0);
    assert.equal(sun.atLocalHour(23), 0);
    assert.ok(sun.atLocalHour(13) > 0.99);
    assert.ok(sun.atLocalHour(9) < sun.atLocalHour(12));
    // 17:00 UTC is 13:00 in New York in June
    assert.ok(sun.forTimeZone('America/New_York')(Date.UTC(2020, 5, 1, 17, 0)) > 0.95);
    assert.equal(sun.forTimeZone('Not/AZone')(Date.UTC(2020, 5, 1, 2, 0)), 0);
});
