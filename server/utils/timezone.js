'use strict';
// Calendar days in an IANA time zone, using only Intl, so day buckets start at the pool's own
// midnight through daylight saving changes.

const DAY_MS = 24 * 60 * 60 * 1000;
const formatters = new Map();

var formatter = (timeZone) => {
    if (!formatters.has(timeZone)) {
        formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        }));
    }
    return formatters.get(timeZone);
};

var isValidTimeZone = (timeZone) => {
    if (typeof timeZone !== 'string' || timeZone.length === 0) {
        return false;
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone });
        return true;
    } catch {
        return false;
    }
};

// the wall clock in timeZone at `ms`
var wallClock = (ms, timeZone) => {
    const parts = {};
    for (const { type, value } of formatter(timeZone).formatToParts(new Date(ms))) {
        parts[type] = value;
    }
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second) };
};

// how far timeZone's wall clock is ahead of UTC at `ms`
var offsetAt = (ms, timeZone) => {
    const clock = wallClock(ms, timeZone);
    return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) - Math.floor(ms / 1000) * 1000;
};

// the instant the wall clock in timeZone reads midnight starting year-month-day
var midnightOf = (year, month, day, timeZone) => {
    const asUtc = Date.UTC(year, month - 1, day);
    // the offset at midnight can differ from the one at the first guess across a DST change
    const guess = asUtc - offsetAt(asUtc, timeZone);
    return asUtc - offsetAt(guess, timeZone);
};

var startOfDay = (ms, timeZone) => {
    const clock = wallClock(ms, timeZone);
    return midnightOf(clock.year, clock.month, clock.day, timeZone);
};

// the start of the local day `days` after the local day starting at dayStart
var addDays = (dayStart, days, timeZone) => {
    // noon is inside the same local day however long a DST day is
    const clock = wallClock(dayStart + DAY_MS / 2, timeZone);
    const date = new Date(Date.UTC(clock.year, clock.month - 1, clock.day + days));
    return midnightOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), timeZone);
};

// YYYY-MM-DD of the local day containing ms
var dayKey = (ms, timeZone) => {
    const clock = wallClock(ms, timeZone);
    return `${clock.year}-${String(clock.month).padStart(2, '0')}-${String(clock.day).padStart(2, '0')}`;
};

// counts local days from 1970-01-01, for lining up multi-day buckets
var dayNumber = (ms, timeZone) => {
    const clock = wallClock(ms, timeZone);
    return Math.round(Date.UTC(clock.year, clock.month - 1, clock.day) / DAY_MS);
};

module.exports = { DAY_MS, isValidTimeZone, wallClock, startOfDay, addDays, dayKey, dayNumber };
