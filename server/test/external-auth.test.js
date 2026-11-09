'use strict';
// Signing in through an OpenID Connect service: approving, denying and inviting newcomers,
// linking a service to an existing account, and turning password sign-in off.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, commission } = require('./helpers/server');
const { startIssuer } = require('./helpers/oidc-issuer');

const alice = { sub: 'alice-1', email: 'alice@example.com', name: 'Alice Example' };
const bob = { sub: 'bob-1', email: 'bob@example.com', name: 'Bob Example' };
const carol = { sub: 'carol-1', email: 'Carol@Example.com', name: 'Carol Example' };
const mallory = { sub: 'mallory-1', email: 'carol@example.com', emailVerified: false, name: 'Not Carol' };
const owner = { sub: 'owner-1', email: 'owner@example.com', name: 'Pool Owner' };

describe('external sign-in', () => {
    let server;
    let issuer;
    let api;
    let adminToken;

    /**
     * follows the redirects of a sign-in through the fake service as a browser would; resolves
     * with where it ended up and the outcome's parameters
     **/
    const signIn = async (person, { provider = 'test', client = 'web', link, formPost = false } = {}) => {
        issuer.person = person;
        const query = new URLSearchParams({ client });
        if (link) {
            query.set('link', link);
        }
        let location = `${server.base}/auth/${provider}/start?${query}`;
        for (let hop = 0; hop < 5; hop++) {
            const callback = new URL(location);
            // as Apple does, the service's answer arrives as a form rather than in the address
            const response = formPost && callback.pathname.endsWith('/callback')
                ? await fetch(`${callback.origin}${callback.pathname}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: callback.searchParams.toString(),
                    redirect: 'manual'
                })
                : await fetch(location, { redirect: 'manual' });
            assert.equal(response.status, 302, `${location} answered ${response.status}: ${await response.text()}`);
            if (location.startsWith(server.base)) {
                assert.equal(response.headers.get('cache-control'), 'no-store');
            }
            location = response.headers.get('location');
            if (location.startsWith('poolstatus:')) {
                return { location, params: Object.fromEntries(new URL(location).searchParams) };
            }
            const marker = '#/signin/complete?';
            if (location.includes(marker)) {
                return { location, params: Object.fromEntries(new URLSearchParams(location.split(marker)[1])) };
            }
        }
        throw new Error(`too many redirects, last ${location}`);
    };

    const exchange = (ticket) => api('POST', '/users/login/external', { body: { ticket } });

    const requests = async () => (await api('GET', '/users/requests', { token: adminToken })).body;

    before(async () => {
        issuer = await startIssuer();
        server = await startServer({ database: 'PoolRestTest-external-auth', env: { OIDC_ALLOW_INSECURE: '1' } });
        api = server.api;
        adminToken = await commission(api);
    });

    after(async () => {
        await server.stop();
        await issuer.stop();
    });

    describe('before any service is set up', () => {
        it('offers only passwords', async () => {
            const choices = await api('GET', '/auth/providers');
            assert.equal(choices.status, 200);
            assert.deepEqual(choices.body, { passwordSignIn: true, providers: [] });
        });

        it('sends a sign-in with an unknown service back with an error', async () => {
            const { params } = await signIn(alice, { provider: 'nowhere' });
            assert.match(params.error, /isn't available/);
        });
    });

    describe('setting up a service', () => {
        it('only admins see or change the sign-in settings', async () => {
            assert.equal((await api('GET', '/system/sign-in')).status, 401);
            const viewer = await api('POST', '/users', { token: adminToken, body: { email: 'looker', password: 'looker-password', role: 'viewer' } });
            assert.equal(viewer.status, 200);
            const login = await api('POST', '/users/login', { body: { email: 'looker', password: 'looker-password' } });
            assert.equal((await api('GET', '/system/sign-in', { token: login.body.token })).status, 403);
        });

        it('refuses an issuer whose discovery document cannot be read', async () => {
            const added = await api('POST', '/system/sign-in/providers', {
                token: adminToken,
                body: { id: 'broken', displayName: 'Broken', issuer: 'http://127.0.0.1:9/nothing', clientId: 'x', clientSecret: 'y' }
            });
            assert.equal(added.status, 400);
            assert.match(added.body.message, /openid-configuration/);
        });

        it('refuses ids that are not short and URL-safe', async () => {
            const added = await api('POST', '/system/sign-in/providers', {
                token: adminToken,
                body: { id: 'Not OK!', displayName: 'Bad', issuer: issuer.base, clientId: 'x' }
            });
            assert.equal(added.status, 400);
        });

        it('adds a service and reports the address to register with it', async () => {
            const added = await api('POST', '/system/sign-in/providers', {
                token: adminToken,
                body: { id: 'test', displayName: 'Test ID', issuer: issuer.base, clientId: issuer.clientId, clientSecret: issuer.clientSecret }
            });
            assert.equal(added.status, 200, added.text);
            assert.equal(added.body.redirectUri, `${server.base}/auth/test/callback`);
            assert.equal(added.body.hasClientSecret, true);
            assert.equal(added.body.clientSecret, undefined, 'the secret is never sent back');
            assert.equal(added.body.trustEmail, false);

            const again = await api('POST', '/system/sign-in/providers', {
                token: adminToken,
                body: { id: 'test', displayName: 'Again', issuer: issuer.base, clientId: 'x' }
            });
            assert.equal(again.status, 409);

            const choices = await api('GET', '/auth/providers');
            assert.deepEqual(choices.body.providers, [{ id: 'test', displayName: 'Test ID' }]);
        });
    });

    describe('newcomers', () => {
        it('someone without an account becomes a request', async () => {
            const { params } = await signIn(alice);
            assert.deepEqual(params, { status: 'pending', provider: 'Test ID' });
            await signIn(alice);

            const list = await requests();
            assert.equal(list.length, 1);
            assert.equal(list[0].email, 'alice@example.com');
            assert.equal(list[0].name, 'Alice Example');
            assert.equal(list[0].providerName, 'Test ID');
            assert.equal(list[0].status, 'pending');
            assert.equal(list[0].attempts, 2);
        });

        it('an approved request signs in with the role it was given', async () => {
            const [request] = await requests();
            assert.equal((await api('POST', `/users/requests/${request.id}/approve`, { token: adminToken, body: { role: 'owner' } })).status, 400);
            const approved = await api('POST', `/users/requests/${request.id}/approve`, { token: adminToken, body: { role: 'user' } });
            assert.equal(approved.status, 200, approved.text);
            assert.deepEqual(approved.body, {
                email: 'alice@example.com', role: 'user', mustChangeCredentials: false, methods: ['test'], displayName: 'Alice Example'
            });
            assert.deepEqual(await requests(), []);

            const { params } = await signIn(alice);
            assert.ok(params.ticket, JSON.stringify(params));
            const login = await exchange(params.ticket);
            assert.equal(login.status, 200);
            assert.equal(login.body.role, 'user');
            assert.ok(login.body.token);
            assert.equal((await api('PUT', '/heating/setpoints/pool/heater1/84', { token: login.body.token })).status, 200);
            assert.equal((await api('GET', '/users', { token: login.body.token })).status, 403);

            assert.equal((await exchange(params.ticket)).status, 401, 'a ticket works once');
            assert.equal((await exchange('made-up')).status, 401);
        });

        it('an account from a service has no password to sign in with', async () => {
            const login = await api('POST', '/users/login', { body: { email: 'alice@example.com', password: '' } });
            assert.equal(login.status, 401);
        });

        it('a denied person is refused without asking again, until forgotten', async () => {
            await signIn(bob);
            const [request] = await requests();
            const denied = await api('POST', `/users/requests/${request.id}/deny`, { token: adminToken });
            assert.equal(denied.status, 200);
            assert.equal(denied.body.status, 'denied');

            assert.equal((await signIn(bob)).params.status, 'denied');
            assert.equal((await requests())[0].attempts, 1, 'a denied request is not counted again');

            assert.equal((await api('DELETE', `/users/requests/${request.id}`, { token: adminToken })).status, 200);
            assert.equal((await signIn(bob)).params.status, 'pending');
        });

        it('refuses newcomers outright when the server is invitation-only', async () => {
            const changed = await api('PUT', '/system/sign-in', { token: adminToken, body: { signInRequests: 'refuse' } });
            assert.equal(changed.status, 200);
            assert.equal(changed.body.signInRequests, 'refuse');
            const before = (await requests()).length;
            assert.equal((await signIn({ sub: 'stranger', email: 'who@example.com' })).params.status, 'refused');
            assert.equal((await requests()).length, before);
            await api('PUT', '/system/sign-in', { token: adminToken, body: { signInRequests: 'ask' } });
        });

        it('a cancelled sign-in at the service says so', async () => {
            assert.deepEqual((await signIn(null)).params, { status: 'cancelled' });
        });

        it('a callback that does not match a sign-in under way is an error', async () => {
            const response = await fetch(`${server.base}/auth/test/callback?code=abc&state=forged`, { redirect: 'manual' });
            assert.equal(response.status, 302);
            const outcome = new URLSearchParams(response.headers.get('location').split('#/signin/complete?')[1]);
            assert.match(outcome.get('error'), /That sign-in has expired/);
        });
    });

    describe('invitations', () => {
        it('only redeem from a service trusted for email addresses', async () => {
            const invited = await api('POST', '/users/invitations', { token: adminToken, body: { email: 'carol@example.com', role: 'viewer' } });
            assert.equal(invited.status, 200, invited.text);
            assert.equal(invited.body.createdBy, 'owner');
            assert.equal((await api('POST', '/users/invitations', { token: adminToken, body: { email: 'CAROL@example.com', role: 'viewer' } })).status, 409);
            assert.equal((await api('POST', '/users/invitations', { token: adminToken, body: { email: 'not-an-address', role: 'viewer' } })).status, 400);

            assert.equal((await signIn(carol)).params.status, 'pending', 'the service is not yet trusted for email');
        });

        it('an unverified address does not redeem an invitation', async () => {
            const trusted = await api('PUT', '/system/sign-in/providers/test', { token: adminToken, body: { trustEmail: true } });
            assert.equal(trusted.status, 200);
            assert.equal(trusted.body.trustEmail, true);
            assert.equal((await signIn(mallory)).params.status, 'pending');
        });

        it('a verified address redeems it once, with the invited role', async () => {
            const { params } = await signIn(carol);
            assert.ok(params.ticket, JSON.stringify(params));
            const login = await exchange(params.ticket);
            assert.equal(login.body.email, 'Carol@Example.com');
            assert.equal(login.body.role, 'viewer');
            assert.deepEqual((await api('GET', '/users/invitations', { token: adminToken })).body, []);
            assert.ok(!(await requests()).some((request) => request.email === carol.email), 'the earlier request is gone');
        });

        it('can be withdrawn', async () => {
            const invited = await api('POST', '/users/invitations', { token: adminToken, body: { email: 'dave@example.com', role: 'user' } });
            assert.equal((await api('DELETE', `/users/invitations/${invited.body.id}`, { token: adminToken })).status, 200);
            assert.equal((await api('DELETE', `/users/invitations/${invited.body.id}`, { token: adminToken })).status, 404);
        });
    });

    describe('linking and password sign-in', () => {
        it('password sign-in stays on until an admin can sign in through a service', async () => {
            const off = await api('PUT', '/system/sign-in', { token: adminToken, body: { passwordSignIn: false } });
            assert.equal(off.status, 409);
        });

        it('an account links a service, then signs in with it', async () => {
            const started = await api('POST', '/users/me/identities/test', { token: adminToken, body: { client: 'web' } });
            assert.equal(started.status, 200, started.text);
            const link = new URL(started.body.url).searchParams.get('link');
            const { params } = await signIn(owner, { link });
            assert.deepEqual(params, { status: 'linked', provider: 'Test ID' });

            const me = await api('GET', '/users/me', { token: adminToken });
            assert.deepEqual(me.body.methods, ['password', 'test']);

            const login = await exchange((await signIn(owner)).params.ticket);
            assert.equal(login.body.email, 'owner');
            assert.equal(login.body.role, 'admin');
        });

        it('a link code works once', async () => {
            const started = await api('POST', '/users/me/identities/test', { token: adminToken, body: {} });
            const link = new URL(started.body.url).searchParams.get('link');
            await signIn(owner, { link });
            assert.match((await signIn(owner, { link })).params.error, /expired/);
        });

        it('a service account already in use cannot be linked to another account', async () => {
            const alicesLogin = await exchange((await signIn(alice)).params.ticket);
            const started = await api('POST', '/users/me/identities/test', { token: alicesLogin.body.token, body: {} });
            const link = new URL(started.body.url).searchParams.get('link');
            assert.match((await signIn(owner, { link })).params.error, /already signs in as owner/);
        });

        it('turns password sign-in off, and keeps a way in for an admin', async () => {
            const off = await api('PUT', '/system/sign-in', { token: adminToken, body: { passwordSignIn: false } });
            assert.equal(off.status, 200, off.text);
            assert.equal(off.body.passwordSignIn, false);
            assert.equal((await api('POST', '/users/login', { body: { email: 'owner', password: 'owner-password' } })).status, 403);
            assert.equal((await api('GET', '/auth/providers')).body.passwordSignIn, false);

            assert.equal((await api('PUT', '/system/sign-in/providers/test', { token: adminToken, body: { enabled: false } })).status, 409);
            assert.equal((await api('DELETE', '/system/sign-in/providers/test', { token: adminToken })).status, 409);

            assert.equal((await api('PUT', '/system/sign-in', { token: adminToken, body: { passwordSignIn: true } })).status, 200);
            assert.equal((await api('POST', '/users/login', { body: { email: 'owner', password: 'owner-password' } })).status, 200);
        });

        it('an account cannot unlink its only way to sign in', async () => {
            const alicesLogin = await exchange((await signIn(alice)).params.ticket);
            assert.equal((await api('DELETE', '/users/me/identities/test', { token: alicesLogin.body.token })).status, 409);

            const unlinked = await api('DELETE', '/users/me/identities/test', { token: adminToken });
            assert.equal(unlinked.status, 200);
            assert.deepEqual(unlinked.body.methods, ['password']);
        });
    });

    describe('services that post their answer', () => {
        it('are understood as well as ones that redirect', async () => {
            const { params } = await signIn(alice, { formPost: true });
            assert.ok(params.ticket, JSON.stringify(params));
            assert.equal((await exchange(params.ticket)).body.email, 'alice@example.com');
        });
    });

    describe('the iOS app', () => {
        it('is sent back to its own address with the ticket', async () => {
            const { location, params } = await signIn(alice, { client: 'ios' });
            assert.match(location, /^poolstatus:\/\/signin\?ticket=/);
            assert.equal((await exchange(params.ticket)).body.email, 'alice@example.com');
        });
    });

    describe('turning a service off', () => {
        it('stops its sign-ins and hides it from the sign-in page', async () => {
            assert.equal((await api('PUT', '/system/sign-in/providers/test', { token: adminToken, body: { enabled: false } })).status, 200);
            assert.deepEqual((await api('GET', '/auth/providers')).body.providers, []);
            assert.match((await signIn(alice)).params.error, /isn't available/);

            const settings = await api('GET', '/system/sign-in', { token: adminToken });
            assert.equal(settings.body.providers[0].enabled, false);
            assert.equal((await api('DELETE', '/system/sign-in/providers/test', { token: adminToken })).status, 200);
        });

        it('records what admins did in the event log', async () => {
            const events = await api('GET', '/events?types=action&limit=100');
            const summaries = events.body.events.map((event) => event.summary).join('\n');
            assert.match(summaries, /Added Test ID for signing in/);
            assert.match(summaries, /Approved alice@example.com \(Test ID\) as user/);
            assert.match(summaries, /Signed in with Test ID/);
        });
    });
});
