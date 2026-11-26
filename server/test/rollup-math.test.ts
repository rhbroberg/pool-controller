'use strict';
// The bucket math and local-day calendar behind rollups and history, without a database.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const rollups = require('../service/RollupService');
const { chooseResolution } = require('../service/HistoryService');
const tz = require('../utils/timezone');

const HOUR_MS = 3600 * 1000;
const NEW_YORK = 'America/New_York';

// the history service's activity log opens a database connection, which would keep the run going
after(() => mongoose.disconnect());

describe('time-weighted buckets', () => {
    const start = Date.UTC(2026, 0, 1);
    const edges = [start, start + HOUR_MS];

    it('weights each value by how long it held, starting from the value carried in', () => {
        const [bucket] = rollups.summarize(10, [{ t: start + HOUR_MS / 4, v: 20 }], edges);
        assert.equal(bucket.knownMs, HOUR_MS);
        assert.equal(bucket.sum / bucket.knownMs, 17.5);
        assert.equal(bucket.min, 10);
        assert.equal(bucket.max, 20);
        assert.equal(bucket.count, 1);
        assert.equal(bucket.last, 20);
    });

    it('counts only time with a known value', () => {
        const [bucket] = rollups.summarize(null, [{ t: start + HOUR_MS / 2, v: 4 }], edges);
        assert.equal(bucket.knownMs, HOUR_MS / 2);
        assert.equal(bucket.sum / bucket.knownMs, 4);
    });

    it('stops at now', () => {
        const [bucket] = rollups.summarize(1, [], edges, start + HOUR_MS / 3);
        assert.equal(bucket.knownMs, Math.round(HOUR_MS / 3));
    });

    it('keeps a brief spike as its maximum', () => {
        const [bucket] = rollups.summarize(80, [{ t: start + 1000, v: 95 }, { t: start + 2000, v: 80 }], edges);
        assert.equal(bucket.max, 95);
        assert.ok(bucket.sum / bucket.knownMs < 80.01);
    });

    it('combines halves into the same bucket as summarizing the whole', () => {
        const events = [{ t: start + 600000, v: 3 }, { t: start + 2400000, v: 7 }];
        const whole = rollups.summarize(1, events, edges)[0];
        const halves = rollups.summarize(1, events, [start, start + HOUR_MS / 2, start + HOUR_MS]);
        const combined = rollups.combine(halves, start, start + HOUR_MS);
        assert.equal(combined.sum, whole.sum);
        assert.equal(combined.knownMs, whole.knownMs);
        assert.equal(combined.min, whole.min);
        assert.equal(combined.max, whole.max);
        assert.equal(combined.count, whole.count);
        assert.equal(combined.last, whole.last);
    });

    it('gives no point for a bucket with nothing known', () => {
        assert.equal(rollups.pointOf(rollups.summarize(null, [], edges)[0]), undefined);
    });
});

describe('heating derived from the switches', () => {
    const t0 = Date.UTC(2026, 0, 1);
    const initials = { heater1: 0, valve4: 0, filter: 1, aux14: 0, spa: 0, spillover: 0 };
    const events = {
        heater1: [{ t: t0 + 1000, v: 1 }, { t: t0 + 5000, v: 0 }],
        aux14: [{ t: t0 + 3000, v: 1 }]
    };

    it('heats the pool until the spa filter turns on, then the spa', () => {
        const pool = rollups.derive('heating:pool:heater1', initials, events);
        const spa = rollups.derive('heating:spa:heater1', initials, events);
        assert.deepEqual(pool.events, [{ t: t0 + 1000, v: 1 }, { t: t0 + 3000, v: 0 }]);
        assert.deepEqual(spa.events, [{ t: t0 + 3000, v: 1 }, { t: t0 + 5000, v: 0 }]);
    });

    it('heats both bodies in spillover', () => {
        const spillover = Object.assign({}, initials, { spillover: 1, heater1: 1 });
        assert.equal(rollups.derive('heating:pool:heater1', spillover, {}).initial, 1);
        assert.equal(rollups.derive('heating:spa:heater1', spillover, {}).initial, 1);
    });

    it('heats only while a pump moves water through the heaters', () => {
        // as on July 2, 2024: the heat pump switched on with the filter, and left on after it stopped
        const minute = 60 * 1000;
        const pump = rollups.derive('heating:pool:valve4', Object.assign({}, initials, { filter: 0 }), {
            filter: [{ t: t0 + 10 * minute, v: 1 }, { t: t0 + 30 * minute, v: 0 }],
            valve4: [{ t: t0 + 10 * minute, v: 1 }, { t: t0 + 38 * minute, v: 0 }, { t: t0 + 107 * minute, v: 1 }, { t: t0 + 111 * minute, v: 0 }]
        });
        assert.equal(pump.initial, 0);
        assert.deepEqual(pump.events, [{ t: t0 + 10 * minute, v: 1 }, { t: t0 + 30 * minute, v: 0 }]);

        const spaFilterOnly = Object.assign({}, initials, { filter: 0, aux14: 1, heater1: 1 });
        assert.equal(rollups.derive('heating:spa:heater1', spaFilterOnly, {}).initial, 1);
        assert.equal(rollups.derive('heating:pool:heater1', spaFilterOnly, {}).initial, 0);
    });

    it('is unknown until the heat source has been seen', () => {
        assert.equal(rollups.derive('heating:pool:valve4', { aux14: 0 }, {}).initial, null);
    });
});

describe('local days', () => {
    it('starts days at local midnight, 23 hours long when the clocks go forward', () => {
        const day = tz.startOfDay(Date.UTC(2026, 2, 8, 15), NEW_YORK);
        assert.equal(new Date(day).toISOString(), '2026-03-08T05:00:00.000Z');
        assert.equal(tz.addDays(day, 1, NEW_YORK) - day, 23 * HOUR_MS);
        assert.equal(tz.dayKey(day, NEW_YORK), '2026-03-08');
    });

    it('and 25 hours long when they go back', () => {
        const day = tz.startOfDay(Date.UTC(2026, 10, 1, 15), NEW_YORK);
        assert.equal(tz.addDays(day, 1, NEW_YORK) - day, 25 * HOUR_MS);
    });

    it('lines up multi-day buckets the same way whatever the window', () => {
        const a = rollups.bucketStart(Date.UTC(2026, 4, 3, 12), 7 * 86400, NEW_YORK);
        const b = rollups.bucketStart(a + 3 * 86400 * 1000, 7 * 86400, NEW_YORK);
        assert.equal(a, b);
        assert.equal(tz.dayKey(a, NEW_YORK) <= '2026-05-03', true);
    });

    it('builds edges that cover the window', () => {
        const from = Date.UTC(2026, 0, 1, 10, 17);
        const edges = rollups.edgesFor(from, from + 5 * HOUR_MS, 3600, NEW_YORK);
        assert.ok(edges[0] <= from);
        assert.ok(edges[edges.length - 1] >= from + 5 * HOUR_MS);
        assert.equal(edges.length, 7);
    });

    it('validates zone names', () => {
        assert.equal(tz.isValidTimeZone('Europe/London'), true);
        assert.equal(tz.isValidTimeZone('Mars/Olympus'), false);
        assert.equal(tz.isValidTimeZone(''), false);
    });
});

describe('choosing a resolution', () => {
    it('picks the shortest bucket that fits the points', () => {
        assert.equal(chooseResolution(24 * HOUR_MS, 1000), 120);
        assert.equal(chooseResolution(365 * 24 * HOUR_MS, 400), 86400);
        assert.equal(chooseResolution(30 * 24 * HOUR_MS, 400), 7200);
    });

    it('never goes finer than asked', () => {
        assert.equal(chooseResolution(24 * HOUR_MS, 1000, 3600), 3600);
    });
});
