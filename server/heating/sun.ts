'use strict';
// How much sun is on the water, as a stand-in: 0 at night and rising to 1 at midday. Open water
// warms in the sun (and a pool with its heater off in the afternoon may rise on its own), so the
// model needs something to put that on. History has no cloud cover or sunrise, so this is the
// same every day: a half sine from about 6:30 to 19:30 local time.

const HOUR_MS = 3600 * 1000;
const SUNRISE = 6.5;
const SUNSET = 19.5;
const SAMPLE_MS = 10 * 60 * 1000;

/** the sun, 0 to 1, at a local hour (0 to 24) */
var atLocalHour = (hour) => hour <= SUNRISE || hour >= SUNSET
    ? 0
    : Math.sin(Math.PI * (hour - SUNRISE) / (SUNSET - SUNRISE));

/** a function giving the sun, 0 to 1, at a time in ms, for the wall clock of a time zone */
var forTimeZone = (timeZone) => {
    let format;
    try {
        format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' });
    } catch {
        format = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', hour: 'numeric', minute: 'numeric' });
    }
    return (ms) => {
        const parts = format.formatToParts(new Date(ms));
        const hour = Number(parts.find((part) => part.type === 'hour').value) % 24;
        const minute = Number(parts.find((part) => part.type === 'minute').value);
        return atLocalHour(hour + minute / 60);
    };
};

/** the average sun over the span, sampled every ten minutes */
var averageOver = (sun, startMs, endMs) => {
    const samples = Math.max(1, Math.ceil((endMs - startMs) / SAMPLE_MS));
    let total = 0;
    for (let i = 0; i < samples; i++) {
        total += sun(startMs + (i + 0.5) * (endMs - startMs) / samples);
    }
    return total / samples;
};

module.exports = { forTimeZone, averageOver, atLocalHour, HOUR_MS };
