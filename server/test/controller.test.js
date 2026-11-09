'use strict';
// Reading and changing the pool through the REST API, against the simulated controller.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const jsyaml = require('js-yaml');
const { startServer, commission, account, reading, eventually } = require('./helpers/server');

const spec = jsyaml.safeLoad(fs.readFileSync(path.join(__dirname, '../api/openapi.yaml'), 'utf8'));

describe('controller', () => {
    let server;
    let api;
    let token;

    // waits for GET /status to report `name` as `value`
    const statusShows = (name, value) => eventually(async () => (await reading(api, name)) === value,
        { message: `${name} to read ${value}` });

    // the server refuses a change until the controller has reported the state it would change
    const whenReady = (method, route) => eventually(async () => {
        const response = await api(method, route, { token });
        return response.status === 200 ? response : undefined;
    }, { message: `${method} ${route} to be accepted` });

    before(async () => {
        server = await startServer({ database: 'PoolRestTest-controller' });
        api = server.api;
        const admin = await commission(api);
        token = await account(api, admin, 'operator', 'user');
    });

    after(async () => {
        await server.stop();
    });

    describe('identity and status', () => {
        it('identifies itself without touching the database or controller', async () => {
            const info = await api('GET', '/system/info');
            assert.equal(info.status, 200);
            assert.equal(info.body.service, 'pool-controller');
            assert.match(info.body.version, /^\d+\.\d+\.\d+/);
            assert.equal(info.body.apiVersion, spec.info.version);
            assert.match(info.body.commit, /^([0-9a-f]{7,}(-dirty)?|unknown)$/);
            assert.ok(!Number.isNaN(Date.parse(info.body.startedAt)));
        });

        it('reports the latest value of every reading', async () => {
            const status = await eventually(async () => {
                const response = await api('GET', '/status');
                const names = (response.body || []).map((entry) => entry.name);
                return names.includes('filter') && names.includes('pool temp') ? response : undefined;
            }, { message: 'status and temperature readings' });
            for (const entry of status.body) {
                assert.ok(['status', 'info'].includes(entry.category), `${entry.name} has category ${entry.category}`);
                assert.ok(!entry.name.startsWith('unknown'), 'unidentified bits are left out');
            }
            assert.equal(new Set(status.body.map((entry) => entry.name)).size, status.body.length, 'one entry per reading');
        });

        it('shows what the panel last displayed', async () => {
            const display = await eventually(async () => {
                const response = await api('GET', '/panel/display');
                return response.status === 200 ? response : undefined;
            }, { message: 'panel display' });
            assert.equal(display.body.lines.length, 2);
        });
    });

    describe('equipment', () => {
        it('turns the lights on and off, confirmed by the controller', async () => {
            const on = await api('PUT', '/devices/lights/true', { token });
            assert.equal(on.status, 200);
            assert.equal(on.body.previousValue, 'false');
            await statusShows('lights', true);

            await api('PUT', '/devices/lights/false', { token });
            await statusShows('lights', false);
        });

        it('accepts the panel names for labelled outputs', async () => {
            await api('PUT', '/devices/yardlights/true', { token });
            await statusShows('aux3', true);
            await api('PUT', '/devices/aux3/false', { token });
            await statusShows('aux3', false);
        });

        it('sends nothing when the equipment is already in that state', async () => {
            const again = await api('PUT', '/devices/lights/false', { token });
            assert.equal(again.status, 200);
            assert.equal(again.body.previousValue, 'false');
        });

        it('rejects buttons the controller does not have', async () => {
            const unknown = await api('PUT', '/devices/jacuzzi/true', { token });
            assert.equal(unknown.status, 400);
            const spillover = await api('PUT', '/devices/spillover/true', { token });
            assert.equal(spillover.status, 400, 'spillover is set through the water flow mode');
        });

        it('reads one device', async () => {
            const device = await api('GET', '/devices/filter');
            assert.equal(device.status, 200);
        });
    });

    describe('water flow', () => {
        it('steps through the modes to the one requested', async () => {
            const spillover = await whenReady('PUT', '/water/mode/spillover');
            assert.equal(spillover.body.mode, 'spillover');
            await statusShows('spillover', true);

            await api('PUT', '/water/mode/pool', { token });
            await statusShows('spillover', false);
            await statusShows('spa', false);
        });

        it('reports the mode it already is in without pressing anything', async () => {
            const same = await api('PUT', '/water/mode/pool', { token });
            assert.equal(same.status, 200);
            assert.equal(same.body.previousMode, 'pool');
        });

        it('rejects modes the controller does not have', async () => {
            assert.equal((await api('PUT', '/water/mode/waterfall', { token })).status, 400);
        });
    });

    describe('heating', () => {
        it('lists every setpoint and the limits', async () => {
            const heating = await api('GET', '/heating');
            assert.equal(heating.status, 200);
            assert.equal(heating.body.units, 'fahrenheit');
            assert.equal(heating.body.minimum, 65);
            assert.equal(heating.body.maximum, 104);
            assert.equal(heating.body.setpointsReachController, true, 'the simulator keeps its own setpoints');
            for (const body of ['pool', 'spa']) {
                for (const device of ['heater1', 'heatpump']) {
                    assert.equal(typeof heating.body.setpoints[body][device], 'number');
                }
            }
        });

        it('sets and reads back a setpoint, recording the change', async () => {
            const set = await api('PUT', '/heating/setpoints/spa/heatpump/99', { token });
            assert.equal(set.status, 200);
            assert.equal(set.body.setpoint, 99);
            assert.equal(typeof set.body.previousSetpoint, 'number');

            const read = await api('GET', '/heating/setpoints/spa/heatpump');
            assert.equal(read.body.setpoint, 99);

            const events = await api('GET', '/events?types=action&limit=1');
            assert.match(events.body.events[0].summary, /spa heat pump setpoint .* to 99°F/);
        });

        it('rejects setpoints outside the controller range and unknown names', async () => {
            assert.equal((await api('PUT', '/heating/setpoints/pool/heater1/64', { token })).status, 400);
            assert.equal((await api('PUT', '/heating/setpoints/pool/heater1/105', { token })).status, 400);
            assert.equal((await api('PUT', '/heating/setpoints/lake/heater1/80', { token })).status, 400);
            assert.equal((await api('GET', '/heating/setpoints/pool/boiler')).status, 400);
        });

        it('has no target while no pump runs', async () => {
            await api('PUT', '/devices/filter/false', { token });
            await api('PUT', '/devices/aux14/false', { token });
            await statusShows('filter', false);
            await statusShows('aux14', false);
            const heating = await api('GET', '/heating');
            assert.equal(heating.body.target, null);
            assert.equal(heating.body.devices.heater1.body, null);
        });

        it('heats the pool while the filter runs', async () => {
            await api('PUT', '/heating/setpoints/pool/heater1/104', { token });
            await api('PUT', '/devices/filter/true', { token });
            await statusShows('filter', true);
            await whenReady('PUT', '/devices/heater1/true');

            const pool = await eventually(async () => {
                const heating = (await api('GET', '/heating')).body;
                return heating.devices.heater1.heating ? heating : undefined;
            }, { message: 'the heater to fire for the pool' });
            assert.equal(pool.target, 'pool');
            assert.equal(pool.devices.heater1.enabled, true);
            assert.equal(pool.devices.heater1.callingForHeat, true);
            assert.equal(pool.devices.heater1.setpoint, 104);
        });

        it('drives toward the spa setpoint while the spa filter runs, idling once it is reached', async () => {
            await api('PUT', '/devices/aux14/true', { token });
            const spa = await eventually(async () => {
                const heating = (await api('GET', '/heating')).body;
                return heating.target === 'spa' && heating.devices.heater1.temperature !== null ? heating : undefined;
            }, { message: 'the spa to become the target with a known temperature' });
            assert.equal(spa.devices.heatpump.setpoint, spa.setpoints.spa.heatpump);

            // a setpoint below the water temperature: enabled, but not calling for heat
            await api('PUT', '/heating/setpoints/spa/heater1/65', { token });
            const idle = await eventually(async () => {
                const heater = (await api('GET', '/heating')).body.devices.heater1;
                return !heater.heating && !heater.callingForHeat ? heater : undefined;
            }, { message: 'the heater to stop at its setpoint' });
            assert.equal(idle.enabled, true, 'it stays enabled while idle');
            assert.equal(idle.body, 'spa');

            // and it starts again once the setpoint is above the water
            await api('PUT', '/heating/setpoints/spa/heater1/104', { token });
            await eventually(async () => (await api('GET', '/heating')).body.devices.heater1.heating,
                { message: 'the heater to fire again' });
        });

        it('counts the heat pump as heating while enabled and below its setpoint', async () => {
            await api('PUT', '/heating/setpoints/spa/heatpump/104', { token });
            await whenReady('PUT', '/devices/valve4/true');
            const pump = await eventually(async () => {
                const device = (await api('GET', '/heating')).body.devices.heatpump;
                return device.enabled && device.heating ? device : undefined;
            }, { message: 'the heat pump to run' });
            assert.equal(pump.body, 'spa');

            await api('PUT', '/heating/setpoints/spa/heatpump/65', { token });
            const idle = (await api('GET', '/heating')).body.devices.heatpump;
            assert.equal(idle.enabled, true);
            assert.equal(idle.heating, false);
        });

        it('keeps the older heater route working', async () => {
            const heater = await api('GET', '/temperature/heater/spa');
            assert.equal(heater.status, 200);
            assert.equal(heater.body.state, 'on');
            assert.equal(typeof heater.body.setPoint, 'number');
        });
    });

    describe('panel keys', () => {
        it('queues a navigation key', async () => {
            const press = await api('PUT', '/panel/keys/menu', { token });
            assert.equal(press.status, 200);
            assert.equal(press.body.key, 'menu');
        });

        it('rejects keys the panel does not have', async () => {
            assert.equal((await api('PUT', '/panel/keys/enter', { token })).status, 400);
        });
    });

    describe('history and the event log', () => {
        it('returns readings over a time window', async () => {
            const to = new Date(Date.now() + 1000).toISOString();
            const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            const history = await api('GET', `/history?names=pool%20temp,filter&from=${from}&to=${to}`);
            assert.equal(history.status, 200);
            assert.deepEqual(history.body.series.map((series) => series.name), ['pool temp', 'filter']);
            const filter = history.body.series[1];
            assert.ok(filter.points.length > 0, 'the filter changed during the tests');
            assert.ok(history.body.earliest);
        });

        it('rejects a window that ends before it starts, and no names', async () => {
            const backwards = await api('GET', '/history?names=filter&from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z');
            assert.equal(backwards.status, 400);
            assert.equal((await api('GET', '/history?names=')).status, 400);
        });

        it('pages through the event log with a cursor', async () => {
            const first = await api('GET', '/events?types=action&limit=2');
            assert.equal(first.status, 200);
            assert.equal(first.body.events.length, 2);
            assert.ok(first.body.next);
            const second = await api('GET', `/events?types=action&limit=2&cursor=${encodeURIComponent(first.body.next)}`);
            assert.equal(second.status, 200);
            const ids = new Set(first.body.events.map((event) => event.id));
            assert.ok(second.body.events.every((event) => !ids.has(event.id)), 'pages do not repeat events');
            assert.ok(first.body.events[0].timestamp >= second.body.events[0].timestamp, 'newest first');
        });

        it('filters the event log by account and sorts oldest first', async () => {
            const mine = await api('GET', '/events?types=action&user=operator&order=asc&limit=50');
            assert.equal(mine.status, 200);
            assert.ok(mine.body.events.length > 0);
            assert.ok(mine.body.events.every((event) => event.user === 'operator'));
            const times = mine.body.events.map((event) => event.timestamp);
            assert.deepEqual(times, [...times].sort());
        });

        it('shows the controller’s own changes too', async () => {
            const status = await api('GET', '/events?types=status&limit=5');
            assert.equal(status.status, 200);
            assert.ok(status.body.events.length > 0);
            assert.ok(status.body.events.every((event) => event.type === 'status'));
        });
    });

    describe('older read routes', () => {
        for (const route of ['/devices', '/temperature', '/temperature/pool', '/lighting', '/filtration']) {
            it(`answers GET ${route}`, async () => {
                assert.equal((await api('GET', route)).status, 200);
            });
        }
    });
});
