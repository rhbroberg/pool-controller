'use strict';
// A pool that follows the heating model exactly, for tests: events as the server stores them, from
// known numbers the fit should get back.
const sun = require('../../heating/sun');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = Date.UTC(2020, 5, 1);

// the same pool every time: the numbers the fit should get back
const TRUTH = { heater: 1.2, pumpBase: 0.9, pumpSlope: 0.02, loss: 0.015, solar: 0.5 };
const sunAt = sun.forTimeZone('UTC');

// deterministic noise
var random = (seed) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
};

/**
 * a pool following the model: each day the pump runs at 8:00 for four hours with a heat source,
 * then four hours with nothing, and at 22:00 for three more hours to see the night. Readings
 * are whole degrees reported every five minutes.
 *   plan(day) => { heater, pump, air }
 **/
var simulate = ({ days, plan, spa = false, truth = TRUTH, noise = 0, seed = 7, initial = 80 }) => {
    const rnd = random(seed);
    const events = [];
    let temperature = initial;
    const switches = {};
    const set = (t, name, value) => {
        if (switches[name] !== value) {
            switches[name] = value;
            events.push({ t, type: 'status', status: [{ name, value }] });
        }
    };
    for (let minute = 0; minute < days * 24 * 60; minute += 1) {
        const t = START + minute * MINUTE;
        const day = Math.floor((t - START) / DAY);
        const hour = ((t - START) % DAY) / HOUR;
        const { heater, pump, air } = plan(day);
        const morning = hour >= 8 && hour < 12;
        const afternoon = hour >= 12 && hour < 16;
        const night = hour >= 22 && hour < 25;
        const running = morning || afternoon || night;
        set(t, spa ? 'aux14' : 'filter', running ? 1 : 0);
        set(t, 'heater1', morning && heater ? 1 : 0);
        set(t, 'valve4', morning && pump ? 1 : 0);
        const warming = (morning && heater ? truth.heater : 0) +
            (morning && pump ? Math.max(0, truth.pumpBase + truth.pumpSlope * (air - 60)) : 0);
        temperature += (warming - truth.loss * (temperature - air) + truth.solar * sunAt(t)) / 60 + (rnd() - 0.5) * noise;
        if (minute % 5 === 0) {
            events.push({
                t,
                type: 'info',
                status: [{ name: spa ? 'spa temp' : 'pool temp', value: Math.round(temperature) }, { name: 'ambient', value: Math.round(air) }]
            });
        }
    }
    return events;
};

// the days cycle through each source and a range of air temperatures
var cyclePlan = (day) => {
    const sources = [{ heater: 1, pump: 0 }, { heater: 0, pump: 1 }, { heater: 1, pump: 1 }, { heater: 0, pump: 1 }];
    return Object.assign({ air: 48 + (day * 7) % 45 }, sources[day % sources.length]);
};

module.exports = { START, TRUTH, sunAt, simulate, cyclePlan, MINUTE, HOUR, DAY };
