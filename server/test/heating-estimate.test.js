'use strict';
// Learning how the water warms from history, and what it says about the time to the setpoint:
// scan history for windows, preview a model, save it, and see the estimate in GET /heating.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startServer, commission, account, reading, eventually } = require('./helpers/server');
const { START, TRUTH, simulate, cyclePlan, DAY } = require('./helpers/heating-history');

const DAYS = 120;
const BATCH = 5000;
const SIMULATED_FROM = Date.parse('2026-01-01T00:00:00Z');

describe('heating estimates', () => {
    let server;
    let api;
    let admin;
    let viewer;
    let connection;
    let scan;
    let windows;

    const near = (actual, expected, tolerance, label) =>
        assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`);

    const findWindows = async (body) => {
        const started = await api('POST', '/heating/model/scan', { token: admin, body });
        assert.equal(started.status, 202, started.text);
        return eventually(async () => {
            const current = await api('GET', '/heating/model/scan', { token: admin });
            return current.status === 200 && ['finished', 'failed'].includes(current.body.state) ? current.body : undefined;
        }, { message: 'the scan to finish', timeoutMs: 30000 });
    };

    before(async () => {
        // a settle period of three seconds, so both the wait and what follows can be seen
        server = await startServer({
            database: 'PoolRestTest-heating-estimate',
            args: ['--no-jobs'],
            env: { POOL_ESTIMATE_SETTLE_MINUTES: '0.05' }
        });
        api = server.api;
        admin = await commission(api);
        viewer = await account(api, admin, 'watcher', 'viewer');
        connection = await mongoose.createConnection(server.uri).asPromise();
        const events = connection.db.collection('events');
        const history = simulate({ days: DAYS, plan: cyclePlan, noise: 0.01 }).map((event) => ({
            _id: new mongoose.Types.ObjectId(),
            source: 'panel',
            eventType: event.type,
            timestamp: new Date(event.t),
            status: event.status
        }));
        for (let from = 0; from < history.length; from += BATCH) {
            await events.insertMany(history.slice(from, from + BATCH));
        }
        // the simulator's own days, which a scan leaves out
        await events.insertOne({ _id: new mongoose.Types.ObjectId(), source: 'panel', eventType: 'info', timestamp: new Date(SIMULATED_FROM + DAY), status: [{ name: 'pool temp', value: 99 }] });
        assert.equal((await api('PUT', '/system/settings', { token: admin, body: { timeZone: 'UTC' } })).status, 200);
    });

    after(async () => {
        await connection.close();
        await server.stop();
    });

    it('has no model to begin with, and says where a scan starts and stops', async () => {
        const model = await api('GET', '/heating/model');
        assert.equal(model.status, 200);
        assert.equal(model.body.model, null);
        assert.equal(Date.parse(model.body.defaultRange.from), START);
        assert.ok(Date.parse(model.body.defaultRange.to) <= SIMULATED_FROM, 'the simulator’s days are left out');
    });

    it('is for admins to change', async () => {
        assert.equal((await api('POST', '/heating/model/scan', { body: {} })).status, 401);
        assert.equal((await api('POST', '/heating/model/scan', { token: viewer, body: {} })).status, 403);
        assert.equal((await api('GET', '/heating/model/scan', { token: viewer })).status, 403);
        assert.equal((await api('GET', '/heating/model/scan/windows', { token: viewer })).status, 403);
        assert.equal((await api('POST', '/heating/model/preview', { token: viewer, body: { scanId: 'x' } })).status, 403);
        assert.equal((await api('PUT', '/heating/model', { token: viewer, body: { previewId: 'x' } })).status, 403);
    });

    it('chooses how the estimate is shown, for every app', async () => {
        assert.equal((await api('GET', '/system/settings', { token: admin })).body.heatingEstimateDisplay, 'remaining');
        assert.equal((await api('PUT', '/system/settings', { token: admin, body: { heatingEstimateDisplay: 'soon' } })).status, 400);
        const changed = await api('PUT', '/system/settings', { token: admin, body: { heatingEstimateDisplay: 'readyAt' } });
        assert.equal(changed.status, 200, changed.text);
        assert.equal(changed.body.heatingEstimateDisplay, 'readyAt');
        assert.equal((await api('PUT', '/system/settings', { token: viewer, body: { heatingEstimateDisplay: 'remaining' } })).status, 403);
        await api('PUT', '/system/settings', { token: admin, body: { heatingEstimateDisplay: 'remaining' } });
    });

    it('has no scan before one is run, and checks the range it is given', async () => {
        assert.equal((await api('GET', '/heating/model/scan', { token: admin })).status, 404);
        assert.equal((await api('GET', '/heating/model/scan/windows', { token: admin })).status, 409);
        assert.equal((await api('POST', '/heating/model/preview', { token: admin, body: { scanId: 'x' } })).status, 409);
        assert.equal((await api('POST', '/heating/model/scan', { token: admin, body: { from: 'yesterday' } })).status, 400);
        const backwards = { from: new Date(START + DAY).toISOString(), to: new Date(START).toISOString() };
        assert.equal((await api('POST', '/heating/model/scan', { token: admin, body: backwards })).status, 400);
    });

    it('finds the windows in history, leaving out the simulator’s days by default', async () => {
        scan = await findWindows({});
        assert.equal(scan.state, 'finished', scan.error);
        assert.equal(Date.parse(scan.from), START);
        assert.ok(Date.parse(scan.to) <= SIMULATED_FROM);
        assert.ok(scan.scanned > 30000, `${scan.scanned} events scanned`);
        assert.ok(scan.summary.suitable > 100, `${scan.summary.suitable} suitable windows`);
        for (const kind of ['heater', 'heatpump', 'both', 'cooling']) {
            assert.ok(scan.summary.bodies.pool[kind].suitable > 0, `suitable ${kind} windows`);
        }
        assert.equal(scan.summary.bodies.spa.heater.windows, 0, 'nothing for the spa');

        const listed = await api('GET', '/heating/model/scan/windows', { token: admin });
        assert.equal(listed.status, 200);
        assert.equal(listed.body.scanId, scan.id);
        windows = listed.body.windows;
        assert.equal(windows.length, scan.summary.windows);
        const window = windows.find((each) => each.suitable && each.sources === 'heatpump');
        assert.equal(window.body, 'pool');
        assert.ok(window.hours > 0.5 && window.hours <= 4.01);
        assert.equal(typeof window.slope, 'number');
        assert.ok(windows.every((each) => Date.parse(each.start) < SIMULATED_FROM), 'none of the simulator’s days');
    });

    it('can be asked about a range, and wont scan two at once', async () => {
        const week = { from: new Date(START).toISOString(), to: new Date(START + 7 * DAY).toISOString() };
        const first = await api('POST', '/heating/model/scan', { token: admin, body: week });
        assert.equal(first.status, 202, first.text);
        const second = await api('POST', '/heating/model/scan', { token: admin, body: week });
        assert.ok([202, 409].includes(second.status));
        const done = await eventually(async () => {
            const current = (await api('GET', '/heating/model/scan', { token: admin })).body;
            return ['finished', 'failed'].includes(current.state) && current.id !== scan.id ? current : undefined;
        }, { message: 'the week to be scanned', timeoutMs: 30000 });
        assert.equal(done.state, 'finished', done.error);
        assert.ok(done.summary.windows < scan.summary.windows);
        // the full scan is the one the rest of the test uses
        scan = await findWindows({});
        windows = (await api('GET', '/heating/model/scan/windows', { token: admin })).body.windows;
    });

    let preview;
    it('previews a model without keeping it, beside the one in use', async () => {
        const response = await api('POST', '/heating/model/preview', { token: admin, body: { scanId: scan.id } });
        assert.equal(response.status, 200, response.text);
        preview = response.body;
        assert.ok(preview.previewId);
        assert.equal(preview.current, null);
        const pool = preview.bodies.pool;
        assert.equal(pool.available, true);
        near(pool.heater, TRUTH.heater, 0.4, 'heater');
        near(pool.heatPump.base, TRUTH.pumpBase, 0.4, 'heat pump');
        near(pool.loss, TRUTH.loss, 0.012, 'loss');
        near(pool.solar, TRUTH.solar, 0.4, 'sun');
        assert.ok(pool.rSquared > 0.5);
        assert.ok(pool.windows.total > 100);
        assert.equal(preview.bodies.spa.available, false);
        assert.match(preview.bodies.spa.reason, /at least/);
        assert.ok(preview.samples.length > 0);
        const sample = preview.samples.find((each) => each.body === 'pool' && each.sources === 'heatpump' && each.airTemperature === 80);
        assert.equal(sample.status, 'ready');
        assert.ok(sample.minutes > 0);

        const model = await api('GET', '/heating/model');
        assert.equal(model.body.model, null, 'a preview is not saved');
    });

    it('leaves out the windows it is told to, and the kinds it is not asked for', async () => {
        const exclude = windows.filter((each) => each.suitable && each.sources === 'heater').map((each) => each.id);
        const without = await api('POST', '/heating/model/preview', { token: admin, body: { scanId: scan.id, excludeWindowIds: exclude } });
        assert.equal(without.status, 200, without.text);
        assert.equal(without.body.excludedWindows, exclude.length);
        assert.ok(without.body.bodies.pool.windows.heater === 0);

        const cooling = await api('POST', '/heating/model/preview', { token: admin, body: { scanId: scan.id, includeSources: ['cooling'] } });
        assert.equal(cooling.body.bodies.pool.available, false);
        // nothing to keep from that one
        assert.equal((await api('PUT', '/heating/model', { token: admin, body: { previewId: cooling.body.previewId } })).status, 400);

        assert.equal((await api('POST', '/heating/model/preview', { token: admin, body: { scanId: scan.id, includeSources: ['sun'] } })).status, 400);
        assert.equal((await api('POST', '/heating/model/preview', { token: admin, body: { scanId: 'someone-elses' } })).status, 409);
    });

    it('shows no estimate until there is a model to make one from', async () => {
        await api('PUT', '/heating/setpoints/pool/heater1/84', { token: admin });
        await api('PUT', '/devices/filter/true', { token: admin });
        await eventually(async () => (await reading(api, 'filter')) === true, { message: 'the filter to run' });
        const heating = await eventually(async () => {
            const body = (await api('PUT', '/devices/heater1/true', { token: admin })).status === 200 && (await api('GET', '/heating')).body;
            return body && body.devices.heater1.callingForHeat && body.devices.heater1.temperature !== null ? body : undefined;
        }, { message: 'the heater to call for heat' });
        assert.ok(heating.estimate, 'an estimate while it heats');
        assert.ok(['noModel', 'noReading'].includes(heating.estimate.status), heating.estimate.status);
    });

    it('saves exactly what was previewed, and every estimate uses it', async () => {
        const saved = await api('PUT', '/heating/model', { token: admin, body: { previewId: preview.previewId } });
        assert.equal(saved.status, 200, saved.text);
        assert.equal(saved.body.model.bodies.pool.heater, preview.bodies.pool.heater);
        assert.equal(saved.body.model.bodies.pool.loss, preview.bodies.pool.loss);
        assert.equal(saved.body.model.createdBy, 'owner');
        assert.deepEqual(saved.body.model.range, preview.range);

        // the anonymous reader sees it too
        const model = await api('GET', '/heating/model');
        assert.equal(model.body.model.id, saved.body.model.id);
        // once saved, a preview is spent
        assert.equal((await api('PUT', '/heating/model', { token: admin, body: { previewId: preview.previewId } })).status, 404);
        assert.equal((await api('PUT', '/heating/model', { token: admin, body: { previewId: 'never-existed' } })).status, 404);

        const next = await api('POST', '/heating/model/preview', { token: admin, body: { scanId: scan.id } });
        assert.equal(next.body.current.id, saved.body.model.id, 'a new preview comes beside the model in use');
        const activity = await eventually(async () => {
            const response = await api('GET', '/events?types=action&limit=20', { token: admin });
            return response.body.events.find((event) => /heating estimate model/.test(event.summary));
        }, { message: 'the save in the event log' });
        assert.ok(activity);
    });

    it('estimates the time to the setpoint while a heat source is calling for heat', async () => {
        // the water has not settled for the first few seconds after the pump starts
        await api('PUT', '/devices/filter/false', { token: admin });
        await eventually(async () => (await reading(api, 'filter')) === false, { message: 'the filter to stop' });
        assert.equal((await api('GET', '/heating')).body.estimate, null, 'nothing to estimate with the pump off');
        await api('PUT', '/devices/filter/true', { token: admin });
        const settling = await eventually(async () => {
            const body = (await api('GET', '/heating')).body;
            return body.estimate && body.estimate.status === 'settling' ? body.estimate : undefined;
        }, { message: 'the estimate to wait for the water to settle', timeoutMs: 5000, intervalMs: 50 });
        assert.equal(settling.model.windows > 100, true);
        assert.equal(typeof settling.rate.net, 'number');

        const estimate = await eventually(async () => {
            const body = (await api('GET', '/heating')).body;
            return body.estimate && body.estimate.status !== 'settling' ? body.estimate : undefined;
        }, { message: 'the settled estimate', timeoutMs: 15000 });
        assert.equal(estimate.status, 'ready', JSON.stringify(estimate));
        assert.equal(estimate.body, 'pool');
        assert.equal(estimate.setpoint, 84);
        assert.deepEqual(estimate.sources, ['heater1']);
        assert.ok(estimate.minutes > 0, `${estimate.minutes} minutes`);
        near(Date.parse(estimate.readyAt) - Date.now(), estimate.minutes * 60000, 20000, 'the time it will be ready');
        assert.equal(estimate.display, 'remaining');
        assert.equal(estimate.timeZone, 'UTC');
        assert.ok(estimate.rate.heater > 0 && estimate.rate.heatPump === 0);
        assert.equal(estimate.model.windows > 100, true);
        assert.ok(estimate.temperature < 84);

        // a higher setpoint takes longer; the estimate follows it
        await api('PUT', '/heating/setpoints/pool/heater1/90', { token: admin });
        const longer = (await api('GET', '/heating')).body.estimate;
        assert.ok(longer.minutes > estimate.minutes - 1, `${longer.minutes} vs ${estimate.minutes}`);
        assert.equal(longer.setpoint, 90);

        // and the display setting is the server's, for every app
        await api('PUT', '/system/settings', { token: admin, body: { heatingEstimateDisplay: 'readyAt' } });
        assert.equal((await api('GET', '/heating')).body.estimate.display, 'readyAt');
        await api('PUT', '/system/settings', { token: admin, body: { heatingEstimateDisplay: 'remaining' } });
    });

    it('is forgotten with the rest of the history in a factory reset', async () => {
        const reset = await api('POST', '/system/factory-reset', { token: admin });
        assert.equal(reset.status, 200, reset.text);
        const model = await eventually(async () => {
            const response = await api('GET', '/heating/model');
            return response.body.model === null ? response : undefined;
        }, { message: 'the model to be forgotten' });
        assert.equal(model.status, 200);
    });
});
