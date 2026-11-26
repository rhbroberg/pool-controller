'use strict';
// A server with no controller attached: reads still answer, and setpoints use the stand-in that
// keeps them in memory until the server can read the controller's own.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, commission } = require('./helpers/server');

describe('without a controller', () => {
    let server;
    let api;
    let token;

    before(async () => {
        server = await startServer({ database: 'PoolRestTest-standalone', driver: 'none' });
        api = server.api;
        token = await commission(api);
    });

    after(async () => {
        await server.stop();
    });

    it('starts every setpoint at 80°F, kept by the server', async () => {
        const heating = await api('GET', '/heating');
        assert.equal(heating.status, 200);
        assert.equal(heating.body.setpointsReachController, false);
        assert.deepEqual(heating.body.setpoints, {
            pool: { heater1: 80, heatpump: 80 },
            spa: { heater1: 80, heatpump: 80 }
        });
        assert.equal(heating.body.target, null);
        assert.equal(heating.body.devices.heater1.enabled, null, 'unknown until the controller reports it');
    });

    it('keeps a changed setpoint', async () => {
        assert.equal((await api('PUT', '/heating/setpoints/pool/heatpump/86', { token })).status, 200);
        assert.equal((await api('GET', '/heating/setpoints/pool/heatpump')).body.setpoint, 86);
        const unchanged = await api('PUT', '/heating/setpoints/pool/heatpump/86', { token });
        assert.equal(unchanged.body.previousSetpoint, 86);
    });

    it('has nothing to report before the controller speaks', async () => {
        const status = await api('GET', '/status');
        assert.equal(status.status, 200);
        assert.deepEqual(status.body, []);
        assert.equal((await api('GET', '/panel/display')).status, 404);
    });

    it('refuses changes that need the controller to have reported its state', async () => {
        assert.equal((await api('PUT', '/water/mode/spa', { token })).status, 400);
        assert.equal((await api('PUT', '/devices/heater1/true', { token })).status, 400);
    });
});
