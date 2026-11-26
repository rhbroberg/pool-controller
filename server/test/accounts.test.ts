'use strict';
// Commissioning, sign-in, roles and account maintenance, then factory reset and restart.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, commission, account } = require('./helpers/server');

describe('accounts', () => {
    let server;
    let api;
    let adminToken;
    let viewerToken;
    let operatorToken;

    before(async () => {
        server = await startServer({ database: 'PoolRestTest-accounts' });
        api = server.api;
    });

    after(async () => {
        await server.stop();
    });

    describe('commissioning', () => {
        it('creates admin/admin on an empty database, which must be renamed', async () => {
            const login = await api('POST', '/users/login', { body: { email: 'admin', password: 'admin' } });
            assert.equal(login.status, 200);
            assert.equal(login.body.role, 'admin');
            assert.equal(login.body.mustChangeCredentials, true);

            const control = await api('PUT', '/devices/filter/true', { token: login.body.token });
            assert.equal(control.status, 403, 'the default admin can do nothing but rename itself');

            const me = await api('GET', '/users/me', { token: login.body.token });
            assert.equal(me.status, 200);
            assert.equal(me.body.email, 'admin');
        });

        it('refuses to keep the name admin', async () => {
            const login = await api('POST', '/users/login', { body: { email: 'admin', password: 'admin' } });
            const same = await api('PUT', '/users/me/credentials', { token: login.body.token, body: { email: 'admin', password: 'another-password' } });
            assert.equal(same.status, 400);
        });

        it('renaming the default admin retires admin/admin', async () => {
            adminToken = await commission(api);
            const old = await api('POST', '/users/login', { body: { email: 'admin', password: 'admin' } });
            assert.equal(old.status, 401);

            const login = await api('POST', '/users/login', { body: { email: 'owner', password: 'owner-password' } });
            assert.equal(login.status, 200);
            assert.equal(login.body.role, 'admin');
            assert.ok(!login.body.mustChangeCredentials);
        });

        it('rejects a wrong password', async () => {
            const login = await api('POST', '/users/login', { body: { email: 'owner', password: 'not-it' } });
            assert.equal(login.status, 401);
        });
    });

    describe('account maintenance', () => {
        it('an admin creates viewer and user accounts', async () => {
            viewerToken = await account(api, adminToken, 'viewer', 'viewer');
            operatorToken = await account(api, adminToken, 'operator', 'user');
            assert.ok(viewerToken && operatorToken);

            const list = await api('GET', '/users', { token: adminToken });
            assert.equal(list.status, 200);
            assert.deepEqual(list.body.map((user) => [user.email, user.role]).sort(),
                [['operator', 'user'], ['owner', 'admin'], ['viewer', 'viewer']]);
            assert.ok(list.body.every((user) => user.password === undefined && user.tokens === undefined),
                'accounts are listed without secrets');
        });

        it('rejects duplicate names, short passwords and unknown roles', async () => {
            const duplicate = await api('POST', '/users', { token: adminToken, body: { email: 'viewer', password: 'whatever-pass', role: 'viewer' } });
            assert.equal(duplicate.status, 409);
            const short = await api('POST', '/users', { token: adminToken, body: { email: 'shorty', password: 'abc', role: 'viewer' } });
            assert.equal(short.status, 400);
            const role = await api('POST', '/users', { token: adminToken, body: { email: 'boss', password: 'boss-password', role: 'owner' } });
            assert.equal(role.status, 400);
        });

        it('reports the signed-in account', async () => {
            const me = await api('GET', '/users/me', { token: operatorToken });
            assert.equal(me.status, 200);
            assert.equal(me.body.email, 'operator');
            assert.equal(me.body.role, 'user');
        });
    });

    describe('roles', () => {
        it('needs a sign-in to change anything', async () => {
            assert.equal((await api('PUT', '/devices/lights/true')).status, 401);
            assert.equal((await api('PUT', '/devices/lights/true', { token: 'not-a-token' })).status, 401);
        });

        it('lets anybody read', async () => {
            assert.equal((await api('GET', '/status')).status, 200);
            assert.equal((await api('GET', '/heating')).status, 200);
        });

        it('keeps viewers read-only', async () => {
            assert.equal((await api('PUT', '/devices/lights/true', { token: viewerToken })).status, 403);
            assert.equal((await api('PUT', '/water/mode/spa', { token: viewerToken })).status, 403);
            assert.equal((await api('PUT', '/heating/setpoints/pool/heater1/85', { token: viewerToken })).status, 403);
            assert.equal((await api('PUT', '/panel/keys/menu', { token: viewerToken })).status, 403);
        });

        it('lets users control equipment but not administer', async () => {
            assert.equal((await api('PUT', '/heating/setpoints/pool/heater1/85', { token: operatorToken })).status, 200);
            assert.equal((await api('GET', '/users', { token: operatorToken })).status, 403);
            assert.equal((await api('POST', '/system/restart', { token: operatorToken })).status, 403);
            assert.equal((await api('POST', '/system/factory-reset', { token: operatorToken })).status, 403);
        });
    });

    describe('passwords and sessions', () => {
        it('a viewer changes its own password', async () => {
            const changed = await api('PUT', '/users/me/credentials', { token: viewerToken, body: { email: 'viewer', password: 'fresh-password' } });
            assert.equal(changed.status, 200);
            assert.ok(changed.body.token);
            viewerToken = changed.body.token;

            assert.equal((await api('POST', '/users/login', { body: { email: 'viewer', password: 'viewer-password' } })).status, 401);
            assert.equal((await api('POST', '/users/login', { body: { email: 'viewer', password: 'fresh-password' } })).status, 200);
        });

        it('an admin changes a role, which takes effect at once', async () => {
            const demoted = await api('PUT', '/users/operator', { token: adminToken, body: { role: 'viewer' } });
            assert.equal(demoted.status, 200);
            assert.equal(demoted.body.role, 'viewer');
            assert.equal((await api('PUT', '/devices/lights/true', { token: operatorToken })).status, 403);
        });

        it('an admin resets a password, signing the account out everywhere', async () => {
            const reset = await api('PUT', '/users/operator', { token: adminToken, body: { password: 'reset-password' } });
            assert.equal(reset.status, 200);
            assert.equal((await api('GET', '/users/me', { token: operatorToken })).status, 401);
            assert.equal((await api('POST', '/users/login', { body: { email: 'operator', password: 'reset-password' } })).status, 200);
        });

        it('keeps at least one admin', async () => {
            const demoteSelf = await api('PUT', '/users/owner', { token: adminToken, body: { role: 'user' } });
            assert.equal(demoteSelf.status, 409);
            assert.equal((await api('PUT', '/users/nobody', { token: adminToken, body: { role: 'user' } })).status, 404);
            assert.equal((await api('PUT', '/users/viewer', { token: adminToken, body: {} })).status, 400);
        });

        it('an admin removes an account', async () => {
            assert.equal((await api('DELETE', '/users/operator', { token: adminToken })).status, 200);
            assert.equal((await api('POST', '/users/login', { body: { email: 'operator', password: 'reset-password' } })).status, 401);
            assert.equal((await api('DELETE', '/users/operator', { token: adminToken })).status, 404);
        });

        it('signing out ends that token only', async () => {
            const second = await api('POST', '/users/login', { body: { email: 'viewer', password: 'fresh-password' } });
            assert.equal((await api('DELETE', '/users/me/token', { token: viewerToken })).status, 200);
            assert.equal((await api('GET', '/users/me', { token: viewerToken })).status, 401);
            assert.equal((await api('GET', '/users/me', { token: second.body.token })).status, 200);
        });

        it('records who did what in the event log', async () => {
            const users = await api('GET', '/events/users');
            assert.equal(users.status, 200);
            assert.ok(users.body.includes('operator'), `event log users: ${JSON.stringify(users.body)}`);
        });
    });

    describe('system', () => {
        it('a factory reset erases accounts and brings back admin/admin', async () => {
            const reset = await api('POST', '/system/factory-reset', { token: adminToken });
            assert.equal(reset.status, 200);

            const events = await api('GET', '/events?types=action&limit=5');
            assert.equal(events.body.events.length, 1, 'only the reset itself is left in the log');
            assert.match(events.body.events[0].summary, /Factory reset/);

            assert.equal((await api('POST', '/users/login', { body: { email: 'owner', password: 'owner-password' } })).status, 401);
            const login = await api('POST', '/users/login', { body: { email: 'admin', password: 'admin' } });
            assert.equal(login.status, 200);
            assert.equal(login.body.mustChangeCredentials, true);
        });

        it('a restart exits the server cleanly for its container to start again', async () => {
            const token = await commission(api, 'second-owner', 'second-password');
            const restart = await api('POST', '/system/restart', { token });
            assert.equal(restart.status, 200);
            const { code } = await server.exited;
            assert.equal(code, 0);
        });
    });
});
