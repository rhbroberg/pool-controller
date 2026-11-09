// The status store: connection state, sign-in and confirming equipment changes.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StatusStore } from '../public/js/store.js';
import { ApiError } from '../public/js/api.js';
import { EQUIPMENT } from '../public/js/model.js';
import * as prefs from '../public/js/prefs.js';

const filter = EQUIPMENT.find((control) => control.name === 'filter');
const switchReading = (name, value) => ({ name, category: 'status', value, timestamp: new Date() });

/** a client whose status the test controls; requests are recorded */
const fakeClient = (overrides = {}) => {
    const client = {
        calls: [],
        readings: [switchReading('pool', 1), switchReading('filter', 0)],
        fetchStatus: async () => client.readings,
        fetchHeating: async () => null,
        setDevice: async (name, on, token) => {
            client.calls.push(['setDevice', name, on, token]);
        },
        setWaterMode: async (mode, token) => {
            client.calls.push(['setWaterMode', mode, token]);
        },
        signIn: async (email) => ({ email, token: `token-for-${email}`, role: 'user' }),
        changeCredentials: async (email) => ({ email, token: `renamed-${email}`, role: 'admin' }),
        fetchAccount: async () => ({ email: 'rick', role: 'viewer' }),
        signOut: async () => {},
        ...overrides
    };
    return client;
};

const newStore = (client) => new StatusStore(client, { confirmationPollMs: 5 });

describe('status store', () => {
    beforeEach(() => prefs.remove('credentials'));

    it('is connected once the server answers, and disconnected when it can’t be reached', async () => {
        const client = fakeClient();
        const store = newStore(client);
        assert.equal(store.connection, 'connecting');
        await store.refresh();
        assert.equal(store.connection, 'connected');
        assert.equal(store.waterMode, 'pool');

        client.fetchStatus = async () => { throw new ApiError('unreachable', { message: 'can’t reach the pool server' }); };
        await store.refresh();
        assert.equal(store.connection, 'disconnected');
        assert.equal(store.connectionFailure, 'Can’t reach the pool server');
        assert.equal(store.readings.length, 2, 'the last readings stay on screen');
    });

    it('stays connected when the server answers with an error', async () => {
        const store = newStore(fakeClient({ fetchStatus: async () => { throw new ApiError('server', { status: 500, message: 'database down' }); } }));
        await store.refresh();
        assert.equal(store.connection, 'connected');
        assert.equal(store.errorMessage, 'Database down');
    });

    it('signs in, remembers the account and knows what its role allows', async () => {
        const store = newStore(fakeClient());
        await store.signIn('rick', 'secret');
        assert.deepEqual(store.credentials, { email: 'rick', token: 'token-for-rick', role: 'user', methods: null });
        assert.equal(store.canControl, true);
        assert.equal(store.isAdmin, false);
        assert.equal(store.hasPassword, true, 'until the server says otherwise');
        assert.deepEqual(prefs.read('credentials'), store.credentials);
    });

    it('signs in with the ticket a service sent back, and knows the account has no password', async () => {
        const client = fakeClient({
            signInWithTicket: async (ticket) => {
                client.calls.push(['signInWithTicket', ticket]);
                return { email: 'alice@example.com', token: 'from-google', role: 'viewer', methods: ['google'] };
            }
        });
        const store = newStore(client);
        await store.signInWithTicket('ticket-1');
        assert.deepEqual(client.calls, [['signInWithTicket', 'ticket-1']]);
        assert.deepEqual(store.credentials, { email: 'alice@example.com', token: 'from-google', role: 'viewer', methods: ['google'] });
        assert.equal(store.hasPassword, false);
        assert.equal(store.connection, 'connected');
    });

    it('holds the default admin aside until it is renamed, without saving its token', async () => {
        const store = newStore(fakeClient({ signIn: async () => ({ email: 'admin', token: 'setup', role: 'admin', mustChangeCredentials: true }) }));
        await store.signIn('admin', 'admin');
        assert.equal(store.credentials, null);
        assert.equal(store.commissioning.token, 'setup');
        assert.equal(prefs.read('credentials', null), null);

        await store.commission('rick', 'poolpass');
        assert.equal(store.commissioning, null);
        assert.deepEqual(store.credentials, { email: 'rick', token: 'renamed-rick', role: 'admin', methods: null });
    });

    it('checks the current password before changing it', async () => {
        const store = newStore(fakeClient({ signIn: async () => { throw new ApiError('unauthorized'); } }));
        store.save({ email: 'rick', token: 't', role: 'user' });
        await assert.rejects(store.changePassword('wrong', 'newpass'), /current password isn’t correct/);
    });

    it('picks up a role an admin changed', async () => {
        const store = newStore(fakeClient());
        store.save({ email: 'rick', token: 't', role: 'admin' });
        await store.refreshAccount();
        assert.equal(store.role, 'viewer');
        assert.equal(store.canControl, false);
    });

    it('marks a change pending until the controller reports it', async () => {
        const client = fakeClient();
        const store = newStore(client);
        store.save({ email: 'rick', token: 't', role: 'user' });
        await store.refresh();

        const change = store.setControl(filter, true);
        assert.equal(store.pendingState('filter'), true);
        await new Promise((resolve) => setTimeout(resolve, 20));
        client.readings = [switchReading('pool', 1), switchReading('filter', 1)];
        await change;

        assert.deepEqual(client.calls, [['setDevice', 'filter', true, 't']]);
        assert.equal(store.pendingState('filter'), undefined);
        assert.equal(store.isOn(filter), true);
        assert.equal(store.confirmedChanges, 1);
        assert.equal(store.errorMessage, null);
    });

    it('signs out when the server no longer accepts the token', async () => {
        const store = newStore(fakeClient({ setDevice: async () => { throw new ApiError('unauthorized'); } }));
        store.save({ email: 'rick', token: 'stale', role: 'user' });
        await store.setControl(filter, true);
        assert.equal(store.credentials, null);
        assert.match(store.errorMessage, /no longer valid/);
    });

    it('rechecks the role when a change is refused', async () => {
        const store = newStore(fakeClient({ setDevice: async () => { throw new ApiError('server', { status: 403 }); } }));
        store.save({ email: 'rick', token: 't', role: 'user' });
        await store.setControl(filter, true);
        assert.equal(store.role, 'viewer');
        assert.equal(store.errorMessage, 'Your account can’t change equipment.');
    });

    it('asks for a water flow mode only when it differs, and only when signed in', async () => {
        const client = fakeClient();
        const store = newStore(client);
        await store.refresh();
        await store.setWaterMode('spa');
        store.save({ email: 'rick', token: 't', role: 'user' });
        await store.setWaterMode('pool');
        assert.deepEqual(client.calls, []);

        const change = store.setWaterMode('spa');
        assert.equal(store.pendingWaterMode, 'spa');
        client.readings = [switchReading('pool', 0), switchReading('spa', 1)];
        await change;
        assert.deepEqual(client.calls, [['setWaterMode', 'spa', 't']]);
        assert.equal(store.pendingWaterMode, null);
        assert.equal(store.waterMode, 'spa');
    });

    it('polls until stopped, waiting longer after losing the server', async () => {
        const waits = [];
        let fail = false;
        const client = fakeClient({ fetchStatus: async () => { if (fail) { throw new ApiError('unreachable'); } return []; } });
        const store = new StatusStore(client, {
            pollSleep: async (ms) => {
                waits.push(ms);
                fail = true;
                if (waits.length === 2) {
                    store.stopPolling();
                }
            }
        });
        store.startPolling();
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(waits, [15000, 30000]);
        assert.equal(store.nextAttempt, null);
    });

    it('lets an admin read and change the server’s settings and run its jobs', async () => {
        const settings = { timeZone: 'America/New_York', timeZoneSource: 'system', rawRetentionDays: 365 };
        const client = fakeClient({
            signIn: async (email) => ({ email, token: 'admin-token', role: 'admin' }),
            fetchSettings: async (token) => {
                client.calls.push(['fetchSettings', token]);
                return settings;
            },
            updateSettings: async (changes, token) => {
                client.calls.push(['updateSettings', changes, token]);
                return { ...settings, ...changes, timeZoneSource: 'configured' };
            },
            fetchJobs: async () => [{ name: 'rollups', lastResult: 'ok' }],
            runJob: async (name, token) => {
                client.calls.push(['runJob', name, token]);
                return { name, lastResult: 'ok', more: false };
            }
        });
        const store = newStore(client);
        await store.signIn('owner', 'secret');
        assert.equal((await store.serverSettings()).timeZone, 'America/New_York');
        const changed = await store.updateServerSettings({ timeZone: 'Europe/London' });
        assert.equal(changed.timeZoneSource, 'configured');
        assert.deepEqual((await store.maintenanceJobs()).map((job) => job.name), ['rollups']);
        assert.equal((await store.runMaintenanceJob('rollups')).more, false);
        assert.deepEqual(client.calls.map((call) => call[0]), ['fetchSettings', 'updateSettings', 'runJob']);
        assert.ok(client.calls.every((call) => call.at(-1) === 'admin-token'));
    });

    it('signs out when the server no longer accepts the token for settings', async () => {
        const store = newStore(fakeClient({ fetchSettings: async () => { throw new ApiError('unauthorized', { status: 401 }); } }));
        await store.signIn('owner', 'secret');
        await assert.rejects(() => store.serverSettings());
        assert.equal(store.credentials, null);
    });

    it('needs a sign-in for the server’s settings', async () => {
        const store = newStore(fakeClient());
        await assert.rejects(() => store.serverSettings(), (error) => error.kind === 'unauthorized');
    });
});
