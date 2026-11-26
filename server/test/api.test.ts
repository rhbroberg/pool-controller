'use strict';
// How the REST API answers requests it refuses, and the documents it serves describing itself.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, commission, account } = require('./helpers/server');

describe('api', () => {
    let server;
    let api;
    let viewerToken;

    // the { code, message } body every refusal carries, which the iOS app shows
    const refusal = (response, code, message) => {
        assert.equal(response.status, code);
        assert.equal(response.body.code, code);
        assert.match(response.body.message, message);
    };

    before(async () => {
        server = await startServer({ database: 'PoolRestTest-api', driver: 'none' });
        api = server.api;
        const admin = await commission(api);
        viewerToken = await account(api, admin, 'viewer', 'viewer');
    });

    after(async () => {
        await server.stop();
    });

    describe('refusals', () => {
        it('asks a client without a token to sign in', async () => {
            refusal(await api('PUT', '/devices/lights/true'), 401, /sign in/);
        });

        it('names the role that lacks a privilege', async () => {
            refusal(await api('PUT', '/devices/lights/true', { token: viewerToken }), 403, /viewer role/);
        });

        it('names the parameter that is out of range', async () => {
            refusal(await api('GET', '/heating/setpoints/lake/heater1'), 400, /body.*pool, spa/);
            refusal(await api('GET', '/events?limit=many'), 400, /limit/);
        });

        it('refuses a malformed or non-JSON body', async () => {
            const base = server.base;
            const malformed = await fetch(`${base}/users/login`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":'
            });
            assert.equal(malformed.status, 400);
            assert.equal((await malformed.json()).code, 400);
            const text = await fetch(`${base}/users/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'admin' });
            assert.equal(text.status, 415);
            assert.match((await text.json()).message, /application\/json/);
        });

        it('distinguishes an unknown route from an unsupported method', async () => {
            refusal(await api('GET', '/nowhere'), 404, /not found/);
            const response = await fetch(`${server.base}/status`, { method: 'DELETE' });
            assert.equal(response.status, 405);
            assert.equal(response.headers.get('allow'), 'GET');
        });
    });

    describe('query strings', () => {
        it('accepts timestamps and cursors with their colons unencoded, as the iOS app sends them', async () => {
            const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            const to = new Date().toISOString();
            assert.equal((await api('GET', `/history?names=pool%20temp,filter&from=${from}&to=${to}`)).status, 200);
            assert.equal((await api('GET', `/events?limit=1&cursor=${to}|000000000000000000000000`)).status, 200);
        });

        it('accepts a list either comma separated or repeated', async () => {
            const commas = await api('GET', '/history?names=pool%20temp,filter');
            const repeated = await api('GET', '/history?names=pool%20temp&names=filter');
            assert.deepEqual(commas.body.series.map((series) => series.name), ['pool temp', 'filter']);
            assert.deepEqual(repeated.body.series.map((series) => series.name), ['pool temp', 'filter']);
        });
    });

    describe('documentation', () => {
        it('serves the OpenAPI document', async () => {
            const response = await fetch(`http://127.0.0.1:${server.port}/api-docs`);
            assert.equal(response.status, 200);
            const doc = await response.json();
            assert.match(doc.openapi, /^3\./);
            assert.equal(doc.servers[0].url, '/rhbroberg/pool-api/1.0.0');
        });

        it('serves Swagger UI', async () => {
            const response = await fetch(`http://127.0.0.1:${server.port}/docs/`);
            assert.equal(response.status, 200);
            assert.match(await response.text(), /Swagger UI/);
        });
    });
});
