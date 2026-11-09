'use strict';
// Long history: rollups, resolution-aware history, the calendar's availability, retention, the
// time zone setting and the jobs that keep it all up to date. 400 days of synthetic readings go
// straight into the database, then everything is driven through the REST API.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startServer, commission, account } = require('./helpers/server');
const tz = require('../utils/timezone');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NEW_YORK = 'America/New_York';
const LONDON = 'Europe/London';
const HISTORY_DAYS = 400;
// water readings stop for these days ago, though the filter keeps running
const GAP = { from: 100, to: 110 };

/**
 * readings every half hour, stored only when they change, as the server does: pool temperature
 * swinging daily, salt once a day, the filter on twelve hours a day and the heater an hour on
 * even days; plus a user action long ago and one recently
 **/
var generate = (now) => {
    const start = Math.floor((now - HISTORY_DAYS * DAY_MS) / HOUR_MS) * HOUR_MS;
    const end = Math.floor((now - HOUR_MS) / HOUR_MS) * HOUR_MS;
    const events = [];
    const add = (eventType, t, name, value) => events.push({
        _id: new mongoose.Types.ObjectId(), source: 'test', eventType, timestamp: new Date(t), status: [{ name, value }]
    });
    let pool;
    let filter;
    let heater;
    let aux14;
    for (let t = start; t < end; t += HOUR_MS / 2) {
        const daysAgo = (now - t) / DAY_MS;
        const inGap = daysAgo >= GAP.from && daysAgo < GAP.to;
        const hour = new Date(t).getUTCHours();
        const dayNumber = Math.floor(t / DAY_MS);
        const nextPool = Math.round(78 + 6 * Math.sin(2 * Math.PI * t / DAY_MS) + 3 * Math.sin(2 * Math.PI * t / (9 * DAY_MS)));
        if (!inGap && nextPool !== pool) {
            pool = nextPool;
            add('info', t, 'pool temp', pool);
        }
        if (!inGap && hour === 12 && new Date(t).getUTCMinutes() === 0) {
            add('info', t, 'salt', dayNumber % 2 === 0 ? 3100 : 3200);
        }
        const nextFilter = hour >= 12 ? 1 : 0;
        if (nextFilter !== filter) {
            filter = nextFilter;
            add('status', t, 'filter', filter);
        }
        const nextHeater = dayNumber % 2 === 0 && hour === 14 ? 1 : 0;
        if (nextHeater !== heater) {
            heater = nextHeater;
            add('status', t, 'heater1', heater);
        }
        // weekly, plus one day in the gap when the pool has no temperature
        const onTheHour = hour === 16 && new Date(t).getUTCMinutes() === 0;
        const weeklySpa = dayNumber % 7 === 0 && !inGap;
        const spaOnly = inGap && Math.floor(daysAgo) === GAP.from + 3;
        if (onTheHour && (weeklySpa || spaOnly)) {
            add('info', t, 'spa temp', 101);
        }
        // the spa filter runs through the weekly reading and the next morning, when the
        // temperature merely holds; the gap's reading is taken while it is off
        const spaRunning = !inGap && ((dayNumber % 7 === 0 && hour >= 15 && hour < 18) || (dayNumber % 7 === 1 && hour >= 10 && hour < 12));
        const nextAux = spaRunning ? 1 : 0;
        if (nextAux !== aux14) {
            aux14 = nextAux;
            add('status', t, 'aux14', aux14);
        }
    }
    events.push({ _id: new mongoose.Types.ObjectId(), eventType: 'action', source: 'rest', user: 'old-timer', message: 'Turned Lights on', timestamp: new Date(now - 390 * DAY_MS), status: [] });
    events.push({ _id: new mongoose.Types.ObjectId(), eventType: 'action', source: 'rest', user: 'recent', message: 'Turned Lights off', timestamp: new Date(now - 10 * DAY_MS), status: [] });
    return events;
};

var plan = (explained) => JSON.stringify(explained.queryPlanner ? explained.queryPlanner.winningPlan : explained);

describe('long history', () => {
    let server;
    let api;
    let admin;
    let viewer;
    let db;
    let connection;
    let generated;
    const now = Date.now();

    const history = async (query) => {
        const response = await api('GET', `/history?${new URLSearchParams(query)}`);
        assert.equal(response.status, 200, response.text);
        return response.body;
    };
    const series = (body, name) => body.series.find((each) => each.name === name);

    const runJob = async (name) => {
        for (let attempt = 0; attempt < 30; attempt++) {
            const run = await api('POST', `/system/jobs/${name}/run`, { token: admin });
            assert.equal(run.status, 200, run.text);
            assert.equal(run.body.lastResult, 'ok', run.body.lastError);
            if (!run.body.more) {
                return run.body;
            }
        }
        throw new Error(`${name} never caught up`);
    };

    before(async () => {
        server = await startServer({
            database: 'PoolRestTest-history',
            driver: 'none',
            args: ['--no-jobs'],
            env: { TZ: NEW_YORK, ROLLUP_BUDGET_MS: '120000' }
        });
        api = server.api;
        admin = await commission(api);
        viewer = await account(api, admin, 'watcher', 'viewer');

        connection = await mongoose.createConnection(server.uri).asPromise();
        db = connection.db;
        generated = generate(now);
        for (let i = 0; i < generated.length; i += 5000) {
            await db.collection('events').insertMany(generated.slice(i, i + 5000));
        }
    });

    after(async () => {
        await connection.close();
        await server.stop();
    });

    describe('settings and jobs', () => {
        it('detects the host time zone and keeps a year of raw history by default', async () => {
            const settings = await api('GET', '/system/settings', { token: admin });
            assert.equal(settings.status, 200);
            assert.equal(settings.body.timeZone, NEW_YORK);
            assert.equal(settings.body.timeZoneSource, 'system');
            assert.equal(settings.body.rawRetentionDays, 365);
        });

        it('keeps settings and jobs to admins', async () => {
            assert.equal((await api('GET', '/system/settings', { token: viewer })).status, 403);
            assert.equal((await api('PUT', '/system/settings', { token: viewer, body: { rawRetentionDays: 30 } })).status, 403);
            assert.equal((await api('GET', '/system/jobs', { token: viewer })).status, 403);
            assert.equal((await api('POST', '/system/jobs/rollups/run', { token: viewer })).status, 403);
        });

        it('rejects zones that do not exist and retention out of range', async () => {
            assert.equal((await api('PUT', '/system/settings', { token: admin, body: { timeZone: 'Mars/Olympus' } })).status, 400);
            assert.equal((await api('PUT', '/system/settings', { token: admin, body: { rawRetentionDays: 2 } })).status, 400);
            assert.equal((await api('PUT', '/system/settings', { token: admin, body: {} })).status, 400);
        });

        it('lists the maintenance jobs, which only run when asked with --no-jobs', async () => {
            const jobs = await api('GET', '/system/jobs', { token: admin });
            assert.equal(jobs.status, 200);
            assert.deepEqual(jobs.body.map((job) => job.name), ['rollups', 'retention', 'weather']);
            assert.ok(jobs.body.every((job) => job.scheduled === false && job.nextRunAt === null));
            assert.equal((await api('POST', '/system/jobs/vacuum/run', { token: admin })).status, 404);
        });
    });

    describe('rollups', () => {
        it('summarizes every hour and day of history', async () => {
            const run = await runJob('rollups');
            assert.match(run.lastSummary, /hourly through/);
            const hours = await db.collection('rollups').countDocuments({ name: 'pool temp', res: 3600 });
            const days = await db.collection('rollups').countDocuments({ name: 'pool temp', res: 86400 });
            assert.ok(hours >= (HISTORY_DAYS - GAP.to + GAP.from) * 24 - 48, `${hours} hourly pool rollups`);
            assert.ok(days >= HISTORY_DAYS - 2, `${days} daily pool rollups`);
        });

        it('has nothing more to do on the next run', async () => {
            const run = await runJob('rollups');
            assert.match(run.lastSummary, /rolled up 0 hours and 0 days/);
        });

        it('redoes the stored heating rollups once when the heating rules change', async () => {
            const stored = db.collection('rollups');
            const query = { name: 'heating:pool:heater1', res: 3600 };
            const original = await stored.find(query).sort({ start: -1 }).skip(100).limit(1).next();
            // as the old rules might have had it
            const wrong = original.sum === original.knownMs ? 0 : original.knownMs;
            await stored.updateOne({ _id: original._id }, { $set: { sum: wrong } });
            await db.collection('jobs').updateOne({ _id: 'rollups' }, { $unset: { 'data.heatingRules': '' } });

            await runJob('rollups');
            const redone = await stored.findOne(Object.assign({ start: original.start }, query));
            assert.equal(redone.sum, original.sum);
            assert.match((await runJob('rollups')).lastSummary, /rolled up 0 hours and 0 days/);
        });
    });

    describe('history', () => {
        it('returns a short window exactly as recorded', async () => {
            const from = new Date(now - DAY_MS);
            const to = new Date(now);
            const body = await history({ names: 'pool temp', from: from.toISOString(), to: to.toISOString(), maxPoints: 1000 });
            const pool = series(body, 'pool temp');
            const expected = generated.filter((e) => e.status[0] && e.status[0].name === 'pool temp' && e.timestamp >= from && e.timestamp < to);
            assert.equal(pool.resolution, 0);
            assert.equal(pool.downsampled, false);
            assert.deepEqual(pool.points.map((p) => p.v), expected.map((e) => e.status[0].value));
            assert.equal(typeof pool.before.v, 'number');
        });

        it('returns a year at a graph’s width as daily buckets with their range', async () => {
            const body = await history({ names: 'pool temp,filter', from: new Date(now - 365 * DAY_MS).toISOString(), to: new Date(now).toISOString(), maxPoints: 400 });
            assert.equal(body.timeZone, NEW_YORK);
            for (const each of body.series) {
                assert.ok(each.points.length <= 400, `${each.name} has ${each.points.length} points`);
            }
            const pool = series(body, 'pool temp');
            assert.equal(pool.resolution, 86400);
            assert.ok(pool.points.length > 300);
            for (const point of pool.points) {
                assert.ok(point.min <= point.v && point.v <= point.max, JSON.stringify(point));
                const t = new Date(point.t).getTime();
                assert.equal(tz.startOfDay(t, NEW_YORK), t, `${point.t} starts at New York midnight`);
            }
            // the filter runs half of every day, so it averages about a half
            const filter = series(body, 'filter');
            assert.equal(filter.resolution, 86400);
            assert.ok(filter.points[200].v > 0.45 && filter.points[200].v < 0.55, JSON.stringify(filter.points[200]));
        });

        it('returns a derived heating series exactly when its switches changed few enough times', async () => {
            // in two months the heater and the filter it needs changed about 180 times, which fits
            const body = await history({ names: 'heating:pool:heater1', from: new Date(now - 60 * DAY_MS).toISOString(), to: new Date(now).toISOString(), maxPoints: 400 });
            const heating = series(body, 'heating:pool:heater1');
            assert.equal(heating.resolution, 0);
            assert.ok(heating.points.length >= 50, `${heating.points.length} changes`);
            assert.ok(heating.points.every((p) => p.v === 0 || p.v === 1));
        });

        it('buckets the derived heating series by how long it heated', async () => {
            const body = await history({ names: 'heating:pool:heater1', from: new Date(now - 365 * DAY_MS).toISOString(), to: new Date(now).toISOString(), maxPoints: 300 });
            const heating = series(body, 'heating:pool:heater1');
            assert.equal(heating.resolution, 172800);
            // one hour heated in every two days
            const middle = heating.points.slice(1, -1).map((p) => p.v);
            assert.ok(middle.length > 150);
            assert.ok(middle.every((v) => v > 0.015 && v < 0.025), `two-day averages ${middle.slice(0, 5).join(', ')}`);
        });

        it('returns finer buckets when zoomed in over the same window', async () => {
            const window = { names: 'pool temp', from: new Date(now - 60 * DAY_MS).toISOString(), to: new Date(now - 10 * DAY_MS).toISOString() };
            const coarse = series(await history(Object.assign({ maxPoints: 400 }, window)), 'pool temp');
            const fine = series(await history(Object.assign({ maxPoints: 700 }, window)), 'pool temp');
            assert.equal(coarse.resolution, 21600);
            assert.equal(fine.resolution, 7200);
            assert.ok(fine.points.length > coarse.points.length);
            assert.ok(fine.points.length <= 700 && coarse.points.length <= 400);
        });

        it('honors a requested minimum resolution', async () => {
            const window = { names: 'pool temp', from: new Date(now - 10 * DAY_MS).toISOString(), to: new Date(now).toISOString(), maxPoints: 100, resolution: 21600 };
            assert.equal(series(await history(window), 'pool temp').resolution, 21600);
        });

        it('gives the same buckets however a window is split', async () => {
            const from = now - 6 * DAY_MS;
            const middle = now - 3 * DAY_MS;
            const whole = series(await history({ names: 'pool temp', from: new Date(from).toISOString(), to: new Date(now).toISOString(), maxPoints: 80 }), 'pool temp');
            const first = series(await history({ names: 'pool temp', from: new Date(from).toISOString(), to: new Date(middle).toISOString(), maxPoints: 40 }), 'pool temp');
            assert.equal(whole.resolution, first.resolution);
            const byTime = new Map(whole.points.map((p) => [p.t, p.v]));
            const shared = first.points.filter((p) => byTime.has(p.t) && new Date(p.t).getTime() + whole.resolution * 1000 <= middle);
            assert.ok(shared.length > 10);
            assert.ok(shared.every((p) => byTime.get(p.t) === p.v));
        });

        it('caps the points a request can ask for', async () => {
            const response = await api('GET', `/history?names=pool%20temp&maxPoints=100000`);
            assert.equal(response.status, 400);
        });
    });

    describe('calendar availability', () => {
        it('marks days with pool, spa or salt readings and not the days without', async () => {
            const response = await api('GET', `/history/availability?from=${new Date(now - 200 * DAY_MS).toISOString()}&to=${new Date(now).toISOString()}`);
            assert.equal(response.status, 200);
            const days = new Set(response.body.days.map((day) => day.date));
            const spaDays = new Set(generated.filter((event) => event.status[0] && event.status[0].name === 'spa temp').map((event) => tz.dayKey(event.timestamp.getTime(), NEW_YORK)));
            assert.equal(response.body.timeZone, NEW_YORK);
            assert.ok(response.body.days.every((day) => day.readings > 0));
            for (let ago = GAP.from + 1; ago < GAP.to - 1; ago++) {
                const key = tz.dayKey(now - ago * DAY_MS, NEW_YORK);
                if (spaDays.has(key)) {
                    assert.ok(days.has(key), `${ago} days ago has a spa temperature`);
                } else {
                    assert.ok(!days.has(key), `${ago} days ago has no water readings`);
                }
            }
            for (const ago of [5, 50, 150]) {
                assert.ok(days.has(tz.dayKey(now - ago * DAY_MS, NEW_YORK)), `${ago} days ago has readings`);
            }
            assert.equal(response.body.earliest, tz.dayKey(generated[0].timestamp.getTime(), NEW_YORK));
        });

        it('marks only the temperature that was asked for', async () => {
            const from = new Date(now - 200 * DAY_MS).toISOString();
            const to = new Date(now).toISOString();
            const pool = await api('GET', `/history/availability?names=pool%20temp&from=${from}&to=${to}`);
            const spa = await api('GET', `/history/availability?names=spa%20temp&from=${from}&to=${to}`);
            assert.equal(pool.status, 200);
            assert.equal(spa.status, 200);
            const poolDays = new Set(pool.body.days.map((day) => day.date));
            const spaDays = new Set(spa.body.days.map((day) => day.date));
            const spaOnly = generated.find((event) => {
                const ago = event.status[0] && event.status[0].name === 'spa temp' ? (now - event.timestamp.getTime()) / DAY_MS : -1;
                return ago >= GAP.from && ago < GAP.to;
            });
            assert.ok(spaOnly, 'the gap has a spa temperature and no pool temperature');
            const spaOnlyDay = tz.dayKey(spaOnly.timestamp.getTime(), NEW_YORK);
            assert.ok(!spaDays.has(spaOnlyDay), 'a spa temperature while the spa filter is off is not graphable');
            const running = generated.find((event) => {
                if (!event.status[0] || event.status[0].name !== 'spa temp') {
                    return false;
                }
                const ago = (now - event.timestamp.getTime()) / DAY_MS;
                return ago >= 20 && ago < 80;
            });
            assert.ok(running);
            const runningDay = tz.dayKey(running.timestamp.getTime(), NEW_YORK);
            const heldDay = tz.dayKey(tz.addDays(tz.startOfDay(running.timestamp.getTime(), NEW_YORK), 1, NEW_YORK), NEW_YORK);
            assert.ok(spaDays.has(runningDay), 'the day the spa filter ran with a new temperature');
            assert.ok(spaDays.has(heldDay), 'the next morning the temperature held while the spa filter ran');
            assert.ok(!generated.some((event) => event.status[0] && event.status[0].name === 'spa temp' && tz.dayKey(event.timestamp.getTime(), NEW_YORK) === heldDay));
            const poolOnly = [...poolDays].find((day) => !spaDays.has(day));
            assert.ok(poolOnly, 'a pool temperature does not mark the spa calendar');
            assert.equal((await api('GET', `/history/availability?names=ambient&from=${from}&to=${to}`)).status, 400);
        });

        it('limits how many days one request covers', async () => {
            const response = await api('GET', `/history/availability?from=${new Date(now - 2000 * DAY_MS).toISOString()}`);
            assert.equal(response.status, 400);
        });
    });

    describe('indexes', () => {
        it('drops the old indexes and keeps the ones history needs', async () => {
            const names = (await db.collection('events').indexes()).map((index) => index.name).sort();
            assert.deepEqual(names, ['_id_', 'eventType_statusName_timestamp', 'eventType_timestamp', 'timestamp', 'user_timestamp']);
            const rollupIndexes = (await db.collection('rollups').indexes()).map((index) => index.name).sort();
            assert.deepEqual(rollupIndexes, ['_id_', 'name_res_start']);
        });

        it('answers every history query from an index', async () => {
            const from = new Date(now - 30 * DAY_MS);
            const to = new Date(now);
            const events = db.collection('events');
            const plans = {
                'one reading over a window': await events.find({ eventType: 'info', 'status.name': 'pool temp', timestamp: { $gte: from, $lt: to } }).sort({ timestamp: 1 }).explain(),
                'the value before a window': await events.find({ eventType: 'status', 'status.name': 'filter', timestamp: { $lt: from } }).sort({ timestamp: -1 }).limit(1).explain(),
                'several readings for rollups': await events.find({ eventType: { $in: ['info', 'status'] }, 'status.name': { $in: ['pool temp', 'filter'] }, timestamp: { $gte: from, $lt: to } }).sort({ timestamp: 1 }).explain(),
                'stored rollups': await db.collection('rollups').find({ name: 'pool temp', res: 86400, start: { $gte: from, $lt: to } }).sort({ start: 1 }).explain(),
                'the calendar': await db.collection('rollups').aggregate([{ $match: { name: { $in: ['pool temp', 'salt'] }, res: 86400, start: { $gte: from, $lt: to }, count: { $gt: 0 } } }, { $group: { _id: '$start' } }]).explain(),
                'expired events': await events.find({ timestamp: { $lt: from } }).sort({ timestamp: 1 }).limit(10).explain(),
                'an event log page': await events.find({ eventType: { $in: ['action', 'status'] } }).sort({ timestamp: -1 }).limit(50).explain()
            };
            for (const [query, explained] of Object.entries(plans)) {
                const winning = plan(explained.stages ? explained.stages[0].$cursor : explained);
                assert.match(winning, /IXSCAN/, `${query} uses an index`);
                assert.doesNotMatch(winning, /COLLSCAN/, `${query} scans no collection`);
            }
        });
    });

    describe('retention', () => {
        it('removes raw events of every kind past the retention period', async () => {
            const run = await runJob('retention');
            assert.match(run.lastSummary, /removed \d+ events/);
            const cutoff = new Date(now - 366 * DAY_MS);
            assert.equal(await db.collection('events').countDocuments({ timestamp: { $lt: cutoff } }), 0);
            assert.equal(await db.collection('events').countDocuments({ eventType: 'action', user: 'old-timer' }), 0);
            assert.equal(await db.collection('events').countDocuments({ eventType: 'action', user: 'recent' }), 1);
        });

        it('still graphs the expired span from its rollups', async () => {
            const body = await history({ names: 'pool temp', from: new Date(now - 390 * DAY_MS).toISOString(), to: new Date(now - 380 * DAY_MS).toISOString(), maxPoints: 1000 });
            const pool = series(body, 'pool temp');
            assert.ok(pool.resolution >= 3600, `resolution ${pool.resolution}`);
            assert.ok(pool.points.length > 100, `${pool.points.length} points`);
            assert.ok(new Date(body.earliest).getTime() < now - 380 * DAY_MS, 'history still reaches back past the raw events');
        });

        it('changes how long raw events are kept', async () => {
            const changed = await api('PUT', '/system/settings', { token: admin, body: { rawRetentionDays: 200 } });
            assert.equal(changed.status, 200);
            assert.equal(changed.body.rawRetentionDays, 200);
            await runJob('retention');
            assert.equal(await db.collection('events').countDocuments({ timestamp: { $lt: new Date(now - 201 * DAY_MS) } }), 0);
        });
    });

    describe('changing the time zone', () => {
        it('redoes the daily rollups on the new zone’s midnights, expired days included', async () => {
            const changed = await api('PUT', '/system/settings', { token: admin, body: { timeZone: LONDON } });
            assert.equal(changed.status, 200);
            assert.equal(changed.body.timeZone, LONDON);
            assert.equal(changed.body.timeZoneSource, 'configured');
            assert.equal(changed.body.detectedTimeZone, NEW_YORK);
            await runJob('rollups');

            const body = await history({ names: 'pool temp', from: new Date(now - 395 * DAY_MS).toISOString(), to: new Date(now).toISOString(), maxPoints: 400 });
            const pool = series(body, 'pool temp');
            assert.equal(body.timeZone, LONDON);
            assert.equal(pool.resolution, 86400);
            assert.ok(pool.points.length > 380);
            for (const point of pool.points) {
                const t = new Date(point.t).getTime();
                assert.equal(tz.startOfDay(t, LONDON), t, `${point.t} starts at London midnight`);
            }
            const availability = await api('GET', '/history/availability');
            assert.equal(availability.body.timeZone, LONDON);
        });

        it('goes back to the host’s zone when the setting is cleared', async () => {
            const cleared = await api('PUT', '/system/settings', { token: admin, body: { timeZone: null } });
            assert.equal(cleared.status, 200);
            assert.equal(cleared.body.timeZone, NEW_YORK);
            assert.equal(cleared.body.timeZoneSource, 'system');
        });
    });
});
