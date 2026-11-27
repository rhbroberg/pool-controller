'use strict';
// The pushes the apps subscribe to over socket.io: readings the moment the controller reports a
// change, and heating once what it depends on changes.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer, commission, account, eventually } = require('./helpers/server');

describe('live updates', () => {
    let server: any;
    let socket: any;
    let token: any;
    const received: any[] = [];

    // the first push of `kind` after this point that satisfies `matches`
    const next = (kind: any, matches: (payload?: any) => boolean = () => true, timeoutMs = 10000) => new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off(kind, listener);
            reject(new Error(`no ${kind} push within ${timeoutMs}ms`));
        }, timeoutMs);
        const listener = (payload: any) => {
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
        socket.onAny((kind: any, payload: any) => received.push({ kind, payload }));
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
        const lightsOn = (payload: any) => payload.readings.some((entry: any) => entry.name === 'lights' && entry.value);
        const pushed = next('readings', lightsOn);
        assert.equal((await server.api('PUT', '/devices/lights/true', { token })).status, 200);
        const { readings } = await pushed;

        const names = readings.map((entry: any) => entry.name);
        assert.ok(names.includes('filter') && names.includes('lights') && names.includes('pool'), names.join(', '));
        assert.ok(readings.every((entry: any) => entry.category === 'status' && !Number.isNaN(Date.parse(entry.timestamp))));
        assert.ok(names.every((name: any) => !name.startsWith('unknown')), 'unidentified bits are left out');

        const status = (await server.api('GET', '/status')).body;
        const lights = status.find((entry: any) => entry.name === 'lights');
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
        const heaterMode = (payload: any) => payload.readings.some((entry: any) => entry.name === 'heater1 mode' && entry.value === 1);
        const pushed = next('readings', heaterMode);
        await eventually(async () => (await server.api('PUT', '/devices/heater1/true', { token })).status === 200,
            { message: 'the heater mode to be known' });
        const { readings } = await pushed;
        const mode = readings.find((entry: any) => entry.name === 'heater1 mode');
        assert.equal(mode.category, 'info');
        assert.equal(mode.value, 1);
    });

    // as in the Docker setup, where Caddy hands the page's WebSocket to the web service
    it('reaches the page through the web service, with the page’s own client', { skip: !globalThis.WebSocket && 'needs a WebSocket' }, async () => {
        const { createWebServer } = require('../../web/server') as any;
        const { LiveConnection, liveUrl } = require('../../web/public/js/live') as any;
        const web = createWebServer({ apiUrl: `http://127.0.0.1:${server.port}`, commit: 'test' });
        await new Promise((resolve: any) => web.listen(0, '127.0.0.1', resolve));
        const pushes: any[] = [];
        let joined: any;
        const live = new LiveConnection(liveUrl({ protocol: 'http:', host: `127.0.0.1:${web.address().port}` }), {
            onEvent: (name: any, data: any) => pushes.push({ name, data }),
            onStateChange: (isLive: any) => isLive && joined()
        });
        try {
            await new Promise((resolve, reject) => {
                joined = resolve;
                setTimeout(() => reject(new Error('the page never joined')), 10000).unref();
                live.start();
            });
            await server.api('PUT', '/devices/lights/false', { token });
            await eventually(() => pushes.some((push: any) => push.name === 'readings' &&
                push.data.readings.some((entry: any) => entry.name === 'lights' && !entry.value)), { message: 'the push to reach the page' });
        } finally {
            live.stop();
            web.closeAllConnections();
            await new Promise((resolve: any) => web.close(resolve));
        }
    });

    it('sends nothing while nothing changes', async () => {
        const statusPushes = () => received.filter((message: any) => message.kind === 'readings' &&
            message.payload.readings.some((entry: any) => entry.category === 'status')).length;
        await new Promise((resolve: any) => setTimeout(resolve, 1500));
        const before = statusPushes();
        await new Promise((resolve: any) => setTimeout(resolve, 2000));
        assert.equal(statusPushes(), before, 'status frames that change nothing are not pushed');
    });
});
