'use strict';
// Accounts that expire and are archived, the dates each account keeps, and guests: made with a
// generated name, let in once by the code in their link to set a password, and then signing in
// with it like anyone else.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, commission, account, sleep } = require('./helpers/server');

const DAY_MS = 24 * 60 * 60 * 1000;

describe('guests and expiring accounts', () => {
    let server: any;
    let api: any;
    let admin: any;

    const users = async (archived?: string) => (await api('GET', `/users${archived ? `?archived=${archived}` : ''}`, { token: admin })).body;
    const named = async (name: string, archived = 'include') => (await users(archived)).find((user: any) => user.email === name);

    before(async () => {
        server = await startServer({ database: 'PoolRestTest-guests', args: ['--no-jobs'] });
        api = server.api;
        admin = await commission(api);
    });

    after(async () => {
        await server.stop();
    });

    it('keeps when an account was made and first and last signed in', async () => {
        await account(api, admin, 'dated', 'viewer');
        const first = await named('dated');
        assert.ok(Date.parse(first.createdAt) <= Date.now());
        assert.ok(first.firstSignInAt, 'the helper signed it in');
        assert.equal(first.firstSignInAt, first.lastSignInAt);
        assert.equal(first.expiresAt, null);
        assert.equal(first.archivedAt, null);
        assert.equal(first.guest, false);

        await sleep(20);
        await api('POST', '/users/login', { body: { email: 'dated', password: 'dated-password' } });
        const again = await named('dated');
        assert.equal(again.firstSignInAt, first.firstSignInAt);
        assert.ok(Date.parse(again.lastSignInAt) > Date.parse(first.lastSignInAt));
    });

    it('makes a guest with a two-word name, a code instead of a password, and a week to live', async () => {
        const created = await api('POST', '/users/guests', { token: admin });
        assert.equal(created.status, 200, created.text);
        const guest = created.body;
        assert.match(guest.email, /^[a-z]+-[a-z]+$/);
        assert.equal(guest.role, 'user');
        assert.equal(guest.guest, true);
        assert.equal(guest.mustChangeCredentials, true);
        assert.deepEqual(guest.methods, [], 'it has no password yet');
        assert.ok(guest.setupCode && guest.setupCode.length >= 16);
        const week = Date.parse(guest.expiresAt) - Date.now();
        assert.ok(week > 7 * DAY_MS - 60000 && week <= 7 * DAY_MS, `expires in ${week} ms`);

        const listed = await named(guest.email);
        assert.equal(listed.setupCode, guest.setupCode, 'an admin can show its QR code again');

        const operator = await account(api, admin, 'nosy', 'user');
        assert.equal((await api('POST', '/users/guests', { token: operator })).status, 403);
    });

    it('lets a guest in once with its code to set a password, then only with the password', async () => {
        const guest = (await api('POST', '/users/guests', { token: admin, body: { expiresAt: null } })).body;
        assert.equal(guest.expiresAt, null, 'null for no expiry');

        const wrong = await api('POST', '/users/login/guest', { body: { email: guest.email, code: 'not-the-code-at-all' } });
        assert.equal(wrong.status, 401);
        const notGuest = await api('POST', '/users/login/guest', { body: { email: 'dated', code: guest.setupCode } });
        assert.equal(notGuest.status, 401);

        const login = await api('POST', '/users/login/guest', { body: { email: guest.email, code: guest.setupCode } });
        assert.equal(login.status, 200, login.text);
        assert.equal(login.body.mustChangeCredentials, true);
        const blocked = await api('PUT', '/devices/filter/true', { token: login.body.token });
        assert.equal(blocked.status, 403, 'nothing but setting a password until it has one');
        assert.equal(blocked.body.message, 'set a password first');

        const set = await api('PUT', '/users/me/credentials', { token: login.body.token, body: { email: guest.email, password: 'guest-password' } });
        assert.equal(set.status, 200, set.text);
        assert.ok(!set.body.mustChangeCredentials);

        const reused = await api('POST', '/users/login/guest', { body: { email: guest.email, code: guest.setupCode } });
        assert.equal(reused.status, 409, 'the code has done its job');
        const password = await api('POST', '/users/login', { body: { email: guest.email, password: 'guest-password' } });
        assert.equal(password.status, 200);
        assert.ok(!password.body.mustChangeCredentials);
        assert.equal((await named(guest.email)).setupCode, null, 'the QR code now only names the guest');
    });

    it('sets, changes and clears an expiry, but never on an admin', async () => {
        const later = new Date(Date.now() + DAY_MS).toISOString();
        const created = await api('POST', '/users', { token: admin, body: { email: 'temp', password: 'temp-password', role: 'viewer', expiresAt: later } });
        assert.equal(created.status, 200, created.text);
        assert.equal(created.body.expiresAt, later);

        const past = await api('POST', '/users', { token: admin, body: { email: 'late', password: 'late-password', role: 'viewer', expiresAt: '2020-01-01T00:00:00Z' } });
        assert.equal(past.status, 400);
        const boss = await api('POST', '/users', { token: admin, body: { email: 'boss', password: 'boss-password', role: 'admin', expiresAt: later } });
        assert.equal(boss.status, 400, 'admins don’t expire');

        const cleared = await api('PUT', '/users/temp', { token: admin, body: { expiresAt: null } });
        assert.equal(cleared.body.expiresAt, null);
        await api('PUT', '/users/temp', { token: admin, body: { expiresAt: later } });
        const promoted = await api('PUT', '/users/temp', { token: admin, body: { role: 'admin' } });
        assert.equal(promoted.body.expiresAt, null, 'made an admin, it no longer expires');
    });

    it('archives an account once it expires, signing it out, and leaves it out of the list', async () => {
        const soon = new Date(Date.now() + 1500).toISOString();
        await api('POST', '/users', { token: admin, body: { email: 'brief', password: 'brief-password', role: 'user', expiresAt: soon } });
        const login = await api('POST', '/users/login', { body: { email: 'brief', password: 'brief-password' } });
        assert.equal(login.status, 200);
        assert.equal((await api('GET', '/users/me', { token: login.body.token })).status, 200);

        await sleep(1700);
        const refused = await api('GET', '/users/me', { token: login.body.token });
        assert.equal(refused.status, 401, 'its token stops working');
        const again = await api('POST', '/users/login', { body: { email: 'brief', password: 'brief-password' } });
        assert.equal(again.status, 401);
        assert.equal(again.body.message, 'this account has expired');

        assert.ok(!(await users()).some((user: any) => user.email === 'brief'), 'archived accounts are left out by default');
        const archived = await named('brief', 'only');
        assert.ok(archived.archivedAt);
        assert.ok((await users('include')).some((user: any) => user.email === 'dated'), 'include lists the rest too');
        assert.equal((await api('PUT', '/users/brief', { token: admin, body: { role: 'viewer' } })).status, 409);
    });

    it('archives expired accounts on schedule, as the accounts job', async () => {
        const soon = new Date(Date.now() + 500).toISOString();
        await api('POST', '/users/guests', { token: admin, body: { expiresAt: soon } });
        await sleep(700);
        const run = await api('POST', '/system/jobs/accounts/run', { token: admin });
        assert.equal(run.status, 200, run.text);
        assert.match(run.body.lastSummary, /^archived 1 expired account$/);
    });

    it('removes every archived account at once', async () => {
        const before = (await users('only')).length;
        assert.ok(before >= 2);
        const removed = await api('DELETE', '/users/archived', { token: admin });
        assert.equal(removed.status, 200, removed.text);
        assert.equal(removed.body.message, `removed ${before} archived accounts`);
        assert.deepEqual(await users('only'), []);
        assert.ok(await named('dated'), 'accounts still in use stay');
    });

    it('keeps archived and guests out of the names an admin can give', async () => {
        for (const name of ['archived', 'guests']) {
            const taken = await api('POST', '/users', { token: admin, body: { email: name, password: 'some-password', role: 'viewer' } });
            assert.equal(taken.status, 400, name);
        }
    });
});