'use strict';
// The pushes the apps subscribe to over socket.io: readings the moment the controller reports a
// change, and heating once what it depends on changes.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer, commission, account, eventually } = require('./helpers/server');

describe('live updates', () => {
    let server;
    let socket;
    let token;
    const received = [];

    // the first push of `kind` after this point that satisfies `matches`
    const next = (kind, matches = () => true, timeoutMs = 10000) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off(kind, listener);
            reject(new Error(`no ${kind} push within ${timeoutMs}ms`));
        }, timeoutMs);
        const listener = (payload) => {
            if (matches(payload)) {
                clearTimeout(timer);
                socket.off(kind, listener);
                resolve(payload);
            }
        };
        socket.on(kind, listener);
    });

    before(async () => {
        server = await startServer({ database: 'PoolRestTest-live' });
        token = await account(server.api, await commission(server.api), 'operator', 'user');
        // the apps connect straight over a WebSocket, without the polling transport first
        socket = io(`http://127.0.0.1:${server.port}`, { transports: ['websocket'], reconnection: false });
        socket.onAny((kind, payload) => received.push({ kind, payload }));
        await new Promise((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('connect_error', reject);
        });
    });

    after(async () => {
        if (socket) {
            socket.close();
        }
        await server.stop();
    });

    it('pushes every switch, as GET /status reports them, when one changes', async () => {
        const lightsOn = (payload) => payload.readings.some((entry) => entry.name === 'lights' && entry.value);
        const pushed = next('readings', lightsOn);
        assert.equal((await server.api('PUT', '/devices/lights/true', { token })).status, 200);
        const { readings } = await pushed;

        const names = readings.map((entry) => entry.name);
        assert.ok(names.includes('filter') && names.includes('lights') && names.includes('pool'), names.join(', '));
        assert.ok(readings.every((entry) => entry.category === 'status' && !Number.isNaN(Date.parse(entry.timestamp))));
        assert.ok(names.every((name) => !name.startsWith('unknown')), 'unidentified bits are left out');

        const status = (await server.api('GET', '/status')).body;
        const lights = status.find((entry) => entry.name === 'lights');
        assert.equal(Boolean(lights.value), true, 'the push matches what GET /status now says');
    });

    it('pushes heating after a change it depends on', async () => {
        const pushed = next('heating');
        await server.api('PUT', '/devices/filter/true', { token });
        const heating = await pushed;
        assert.ok(heating.devices && heating.devices.heater1, JSON.stringify(heating));
        assert.equal(typeof heating.minimum, 'number');
    });

    it('pushes a display reading when it changes', async () => {
        // the display may first report the mode it was already in
        const heaterMode = (payload) => payload.readings.some((entry) => entry.name === 'heater1 mode' && entry.value === 1);
        const pushed = next('readings', heaterMode);
        await eventually(async () => (await server.api('PUT', '/devices/heater1/true', { token })).status === 200,
            { message: 'the heater mode to be known' });
        const { readings } = await pushed;
        const mode = readings.find((entry) => entry.name === 'heater1 mode');
        assert.equal(mode.category, 'info');
        assert.equal(mode.value, 1);
    });

    // as in the Docker setup, where Caddy hands the page's WebSocket to the web service
    it('reaches the page through the web service, with the page’s own client', { skip: !globalThis.WebSocket && 'needs a WebSocket' }, async () => {
        const { createWebServer } = await import('../../web/server.js');
        const { LiveConnection, liveUrl } = await import('../../web/public/js/live.js');
        const web = createWebServer({ apiUrl: `http://127.0.0.1:${server.port}`, commit: 'test' });
        await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
        const pushes = [];
        let joined;
        const live = new LiveConnection(liveUrl({ protocol: 'http:', host: `127.0.0.1:${web.address().port}` }), {
            onEvent: (name, data) => pushes.push({ name, data }),
            onStateChange: (isLive) => isLive && joined()
        });
        try {
            await new Promise((resolve, reject) => {
                joined = resolve;
                setTimeout(() => reject(new Error('the page never joined')), 10000).unref();
                live.start();
            });
            await server.api('PUT', '/devices/lights/false', { token });
            await eventually(() => pushes.some((push) => push.name === 'readings' &&
                push.data.readings.some((entry) => entry.name === 'lights' && !entry.value)), { message: 'the push to reach the page' });
        } finally {
            live.stop();
            web.closeAllConnections();
            await new Promise((resolve) => web.close(resolve));
        }
    });

    it('sends nothing while nothing changes', async () => {
        const statusPushes = () => received.filter((message) => message.kind === 'readings' &&
            message.payload.readings.some((entry) => entry.category === 'status')).length;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const before = statusPushes();
        await new Promise((resolve) => setTimeout(resolve, 2000));
        assert.equal(statusPushes(), before, 'status frames that change nothing are not pushed');
    });
});
