// Live updates: reading socket.io's packets, keeping the connection, and the store applying pushes.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { LiveConnection, parsePacket, liveUrl, LIVE_PATH } from '../public/js/live.js';
import { StatusStore, LIVE_REFRESH_SECONDS, REFRESH_SECONDS } from '../public/js/store.js';
import { EQUIPMENT } from '../public/js/model.js';
import { ApiError } from '../public/js/api.js';
import * as prefs from '../public/js/prefs.js';

const OPEN = '0{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}';
const filter = EQUIPMENT.find((control) => control.name === 'filter');

/** WebSockets the test drives: what the page sends is recorded, what the server sends is pushed */
const fakeSockets = () => {
    const sockets = [];
    class FakeSocket {
        constructor(url) {
            this.url = url;
            this.sent = [];
            this.closed = false;
            sockets.push(this);
        }
        send(text) {
            this.sent.push(text);
        }
        close() {
            this.closed = true;
        }
        receive(text) {
            this.onmessage({ data: text });
        }
        hangUp() {
            this.onclose();
        }
    }
    return { sockets, FakeSocket };
};

/** timers the test fires by hand */
const fakeTimers = () => {
    const pending = new Map();
    let next = 1;
    return {
        setTimer: (fn, ms) => {
            const id = next++;
            pending.set(id, { fn, ms });
            return id;
        },
        clearTimer: (id) => pending.delete(id),
        waits: () => [...pending.values()].map((timer) => timer.ms),
        fire: (ms) => {
            const [id, timer] = [...pending.entries()].find(([, entry]) => entry.ms === ms) || [];
            assert.ok(timer, `a ${ms}ms timer is pending`);
            pending.delete(id);
            timer.fn();
        }
    };
};

const connection = (options = {}) => {
    const { sockets, FakeSocket } = fakeSockets();
    const timers = fakeTimers();
    const events = [];
    const states = [];
    const live = new LiveConnection('ws://pool.local/socket.io/?EIO=4&transport=websocket', {
        WebSocketImpl: FakeSocket,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        onEvent: (name, data) => events.push([name, data]),
        onStateChange: (isLive) => states.push(isLive),
        ...options
    });
    return { live, sockets, timers, events, states };
};

const join = (socket) => {
    socket.receive(OPEN);
    socket.receive('40{"sid":"def"}');
};

describe('live update packets', () => {
    it('reads the session opening, pings, joining, events and refusals', () => {
        assert.deepEqual(parsePacket(OPEN), { type: 'open', pingInterval: 25000, pingTimeout: 20000 });
        assert.deepEqual(parsePacket('2'), { type: 'ping' });
        assert.deepEqual(parsePacket('1'), { type: 'close' });
        assert.deepEqual(parsePacket('40{"sid":"x"}'), { type: 'connect' });
        assert.deepEqual(parsePacket('41'), { type: 'disconnect' });
        assert.deepEqual(parsePacket('44{"message":"not authorized"}'), { type: 'refused', reason: 'not authorized' });
        assert.deepEqual(parsePacket('42["readings",{"readings":[]}]'), { type: 'event', name: 'readings', data: { readings: [] } });
        assert.deepEqual(parsePacket('4212["heating",{"minimum":65}]'), { type: 'event', name: 'heating', data: { minimum: 65 } }, 'with an acknowledgement id');
    });

    it('ignores what it doesn’t understand', () => {
        ['', '6', '42not json', '42{"a":1}', '42/admin,["x"]', '0garbage', undefined].forEach((text) => {
            assert.equal(parsePacket(text), null, String(text));
        });
    });

    it('reaches the live updates where the page came from, securely when the page is', () => {
        assert.equal(liveUrl({ protocol: 'https:', host: 'pool.example.com' }), `wss://pool.example.com${LIVE_PATH}`);
        assert.equal(liveUrl({ protocol: 'http:', host: 'localhost:8080' }), `ws://localhost:8080${LIVE_PATH}`);
    });
});

describe('live connection', () => {
    it('joins once the session opens, then hands on events', () => {
        const { live, sockets, events, states } = connection();
        live.start();
        assert.equal(sockets.length, 1);
        sockets[0].receive(OPEN);
        assert.deepEqual(sockets[0].sent, ['40']);
        assert.equal(live.isLive, false, 'not until the server welcomes it');
        sockets[0].receive('40{"sid":"def"}');
        assert.deepEqual(states, [true]);
        sockets[0].receive('42["readings",{"readings":[{"name":"filter","value":1}]}]');
        assert.deepEqual(events, [['readings', { readings: [{ name: 'filter', value: 1 }] }]]);
    });

    it('answers pings, and gives up on a server it stops hearing from', () => {
        const { live, sockets, timers, states } = connection();
        live.start();
        join(sockets[0]);
        sockets[0].receive('2');
        assert.deepEqual(sockets[0].sent, ['40', '3']);
        assert.deepEqual(timers.waits(), [45000], 'a ping interval and timeout of silence');
        timers.fire(45000);
        assert.equal(sockets[0].closed, true);
        assert.deepEqual(states, [true, false]);
    });

    it('reconnects after losing the server, waiting longer each time until it joins again', () => {
        const { live, sockets, timers, states } = connection();
        live.start();
        join(sockets[0]);
        sockets[0].hangUp();
        assert.deepEqual(states, [true, false]);
        timers.fire(1000);
        assert.equal(sockets.length, 2);
        sockets[1].hangUp();
        timers.fire(2000);
        sockets[2].hangUp();
        timers.fire(4000);
        join(sockets[3]);
        assert.deepEqual(states, [true, false, true]);
        sockets[3].hangUp();
        assert.ok(timers.waits().includes(1000), 'joining resets the wait');
    });

    it('gives up on a refusal or a server leaving, and retries', () => {
        const { live, sockets, timers } = connection();
        live.start();
        join(sockets[0]);
        sockets[0].receive('44{"message":"no"}');
        assert.equal(sockets[0].closed, true);
        timers.fire(1000);
        join(sockets[1]);
        sockets[1].receive('1');
        assert.equal(sockets[1].closed, true);
    });

    it('hangs up a session that never opens', () => {
        const { live, sockets, timers } = connection();
        live.start();
        timers.fire(10000);
        assert.equal(sockets[0].closed, true);
        assert.deepEqual(timers.waits(), [1000]);
    });

    it('stays away once stopped, ignoring a closing socket', () => {
        const { live, sockets, timers, states } = connection();
        live.start();
        join(sockets[0]);
        live.stop();
        assert.equal(sockets[0].closed, true);
        sockets[0].hangUp();
        sockets[0].receive('42["readings",{"readings":[]}]');
        assert.deepEqual(timers.waits(), []);
        assert.deepEqual(states, [true, false]);
        assert.equal(sockets.length, 1);
    });

    it('hands on no events until the server welcomes it', () => {
        const { live, sockets, events } = connection();
        live.start();
        sockets[0].receive(OPEN);
        sockets[0].receive('42["readings",{"readings":[]}]');
        assert.deepEqual(events, []);
    });

    it('keeps the silence timeout the server set, and a shorter one until it says', () => {
        const { live, sockets, timers } = connection();
        live.start();
        assert.deepEqual(timers.waits(), [10000], 'waiting for the session to open');
        sockets[0].receive('2');
        assert.deepEqual(timers.waits(), [10000], 'a ping before the opening keeps the opening timeout');
        sockets[0].receive('0{"pingInterval":1000,"pingTimeout":500}');
        assert.deepEqual(timers.waits(), [1500]);
        sockets[0].receive('2');
        assert.deepEqual(timers.waits(), [1500]);
    });

    it('waits at most 30 seconds between tries', () => {
        const { live, sockets, timers } = connection();
        live.start();
        for (const wait of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
            sockets.at(-1).hangUp();
            assert.deepEqual(timers.waits(), [wait]);
            timers.fire(wait);
        }
    });

    it('opens one connection however often it’s started', () => {
        const { live, sockets } = connection();
        live.start();
        live.start();
        assert.equal(sockets.length, 1);
    });

    it('tries again when the WebSocket can’t be made or can’t send', () => {
        let fail = true;
        const { sockets, FakeSocket } = fakeSockets();
        class Flaky extends FakeSocket {
            constructor(url) {
                if (fail) {
                    throw new Error('blocked');
                }
                super(url);
            }
            send(text) {
                if (text === '40') {
                    throw new Error('closed');
                }
                super.send(text);
            }
        }
        const { live, timers } = connection({ WebSocketImpl: Flaky });
        live.start();
        assert.deepEqual(timers.waits(), [1000]);
        fail = false;
        timers.fire(1000);
        assert.equal(sockets.length, 1);
        sockets[0].receive(OPEN);
        assert.equal(sockets[0].closed, true, 'a failed send hangs up');
        assert.deepEqual(timers.waits(), [2000]);
    });

    it('calls the browser’s timers unbound, as browsers insist', () => {
        const saved = globalThis.setTimeout;
        const strict = function (fn, ms) {
            if (this !== undefined && this !== globalThis) {
                throw new TypeError('Illegal invocation');
            }
            return saved(fn, ms);
        };
        globalThis.setTimeout = strict;
        const { sockets, FakeSocket } = fakeSockets();
        try {
            const live = new LiveConnection('ws://pool.local/', { WebSocketImpl: FakeSocket });
            live.start();
            assert.equal(sockets.length, 1);
            live.stop();
        } finally {
            globalThis.setTimeout = saved;
        }
    });

    it('does nothing where the browser has no WebSocket', () => {
        const { live, sockets } = connection({ WebSocketImpl: null });
        live.start();
        assert.equal(sockets.length, 0);
        assert.equal(live.isLive, false);
    });
});

/** stands in for LiveConnection: the store sets its callbacks, and the test calls them */
const fakeLive = () => ({
    starts: 0,
    stops: 0,
    onEvent: null,
    onStateChange: null,
    start() { this.starts += 1; },
    stop() { this.stops += 1; }
});

const reading = (name, value, category = 'status') => ({ name, category, value, timestamp: new Date('2026-01-02T03:04:05Z') });

const fakeClient = (readings) => {
    const client = {
        readings,
        statusRequests: 0,
        calls: [],
        fetchStatus: async () => {
            client.statusRequests += 1;
            return client.readings;
        },
        fetchHeating: async () => ({ minimum: 65 }),
        fetchWeather: async () => null,
        setDevice: async (name, on) => client.calls.push(['setDevice', name, on])
    };
    return client;
};

describe('status store with live updates', () => {
    beforeEach(() => prefs.remove('credentials'));

    it('applies pushed readings, keeping the ones a push doesn’t carry', async () => {
        const live = fakeLive();
        const store = new StatusStore(fakeClient([reading('pool temp', 80, 'info'), reading('filter', 0)]), { live });
        await store.refresh();
        live.onEvent('readings', { readings: [{ name: 'filter', category: 'status', value: true, timestamp: '2026-01-02T04:00:00.000Z' },
            { name: 'lights', category: 'status', value: false, timestamp: '2026-01-02T04:00:00.000Z' }] });
        assert.deepEqual(store.readings.map((entry) => [entry.name, entry.value]), [['pool temp', 80], ['filter', 1], ['lights', 0]]);
        assert.ok(store.reading('filter').timestamp instanceof Date);
        assert.equal(store.isOn(filter), true);
    });

    it('keeps a push over the answer to a refresh that asked before it', async () => {
        const live = fakeLive();
        let answer;
        const client = fakeClient([reading('filter', 0)]);
        client.fetchStatus = () => new Promise((resolve) => { answer = resolve; });
        const store = new StatusStore(client, { live });
        const refreshing = store.refresh();
        live.onEvent('readings', { readings: [reading('filter', 1)] });
        answer([reading('filter', 0)]);
        await refreshing;
        assert.equal(store.isOn(filter), true);
        assert.equal(store.connection, 'connected');
    });

    it('counts a push as hearing from the server after losing it', async () => {
        const live = fakeLive();
        const client = fakeClient([reading('filter', 0)]);
        const store = new StatusStore(client, { live });
        client.fetchStatus = async () => { throw new ApiError('unreachable'); };
        await store.refresh();
        assert.equal(store.connection, 'disconnected');
        live.onEvent('readings', { readings: [reading('filter', 1)] });
        assert.equal(store.connection, 'connected');
        assert.equal(store.connectionFailure, null);
        assert.ok(store.lastRefresh);
    });

    it('shows changes as the live updates come and go', async () => {
        const live = fakeLive();
        const store = new StatusStore(fakeClient([]), { live });
        const notified = [];
        store.subscribe((changed) => notified.push(changed.isLive));
        live.onStateChange(true);
        await Promise.resolve();
        live.onStateChange(false);
        await Promise.resolve();
        assert.deepEqual(notified, [true, false]);
    });

    it('applies pushed heating, and ignores pushes it doesn’t know', async () => {
        const live = fakeLive();
        const store = new StatusStore(fakeClient([]), { live });
        live.onEvent('heating', { minimum: 70, devices: {} });
        assert.equal(store.heating.minimum, 70);
        live.onEvent('weather', { today: {} });
        live.onEvent('readings', 'not readings');
        assert.deepEqual(store.readings, []);
    });

    it('polls less often while live, and refreshes at once on joining or losing the live updates', async () => {
        const live = fakeLive();
        const waits = [];
        let wake;
        const client = fakeClient([reading('filter', 0)]);
        const store = new StatusStore(client, {
            live,
            pollSleep: (ms) => new Promise((resolve) => {
                waits.push(ms);
                wake = resolve;
                store.wakePoll = resolve;
            })
        });
        store.startPolling();
        assert.equal(live.starts, 1);
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepEqual(waits, [REFRESH_SECONDS * 1000]);

        live.onStateChange(true);
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(client.statusRequests, 2, 'joining catches up on anything missed');
        assert.deepEqual(waits, [REFRESH_SECONDS * 1000, LIVE_REFRESH_SECONDS * 1000]);
        assert.equal(store.isLive, true);

        live.onStateChange(false);
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(client.statusRequests, 3);
        assert.equal(waits.at(-1), REFRESH_SECONDS * 1000);

        store.stopPolling();
        assert.equal(live.stops, 2, 'once on starting over, once on stopping');
        wake();
    });

    it('confirms a change from the push rather than by polling', async () => {
        const live = fakeLive();
        const client = fakeClient([reading('filter', 0)]);
        const store = new StatusStore(client, { live, confirmationPollMs: 1000 });
        store.save({ email: 'rick', token: 't', role: 'user' });
        await store.refresh();
        live.onStateChange(true);
        const requests = client.statusRequests;

        const change = store.setControl(filter, true);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(store.pendingState('filter'), true);
        live.onEvent('readings', { readings: [reading('filter', true)] });
        await change;

        assert.equal(client.statusRequests, requests, 'no polling needed');
        assert.equal(store.pendingState('filter'), undefined);
        assert.equal(store.confirmedChanges, 1);
        assert.equal(store.errorMessage, null);
    });

    it('still polls to confirm a change when no push comes', async () => {
        const live = fakeLive();
        const client = fakeClient([reading('filter', 0)]);
        const store = new StatusStore(client, { live, confirmationPollMs: 2 });
        store.save({ email: 'rick', token: 't', role: 'user' });
        await store.refresh();
        live.onStateChange(true);

        const change = store.setControl(filter, true);
        client.readings = [reading('filter', 1)];
        await change;
        assert.equal(store.confirmedChanges, 1);
    });
});
