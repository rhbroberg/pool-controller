// The web service: its files, its forwarding of the API, and the API client talking through it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createWebServer, API_BASE, UNREACHABLE_HEADER } from '../server.js';
import { Client, ApiError } from '../public/js/api.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
});

/** stands in for the pool server, recording what reaches it */
const startUpstream = async () => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, headers: req.headers, body });
            const reply = (status, payload) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload));
            };
            if (req.url.startsWith(`${API_BASE}/status`)) {
                reply(200, [{ name: 'filter', category: 'status', value: 1, timestamp: '2026-01-02T03:04:05.000Z' }]);
            } else if (req.url.startsWith(`${API_BASE}/users/me`)) {
                reply(401, { code: 401 });
            } else if (req.url.startsWith(`${API_BASE}/devices/`)) {
                reply(403, { code: 403, message: 'the viewer role cannot do that' });
            } else if (req.url.startsWith(`${API_BASE}/users/login`)) {
                reply(200, { email: JSON.parse(body).email, token: 'token-1', role: 'admin' });
            } else {
                reply(200, { echoed: req.url });
            }
        });
    });
    const port = await listen(upstream);
    return { upstream, port, seen };
};

describe('web service', () => {
    let upstream;
    let web;
    let base;

    before(async () => {
        upstream = await startUpstream();
        web = createWebServer({ apiUrl: `http://127.0.0.1:${upstream.port}` });
        base = `http://127.0.0.1:${await listen(web)}`;
    });

    after(async () => {
        await close(web);
        await close(upstream.upstream);
    });

    it('serves the page at the root', async () => {
        const response = await fetch(`${base}/`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.match(await response.text(), /<div id="app">/);
    });

    it('serves scripts as JavaScript modules can be loaded', async () => {
        const response = await fetch(`${base}/js/app.js`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/javascript/);
    });

    it('answers 404 for files it does not have, and never serves files above public/', async () => {
        assert.equal((await fetch(`${base}/missing.js`)).status, 404);
        assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 404);
        assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
    });

    it('serves files only to GET and HEAD', async () => {
        assert.equal((await fetch(`${base}/index.html`, { method: 'POST' })).status, 405);
        assert.equal((await fetch(`${base}/index.html`, { method: 'HEAD' })).status, 200);
    });

    it('tells the page which pool server it forwards to', async () => {
        const config = await (await fetch(`${base}/config.json`)).json();
        assert.deepEqual(config, { apiServer: `127.0.0.1:${upstream.port}` });
    });

    it('forwards API requests with their method, query, headers and body', async () => {
        const response = await fetch(`${base}${API_BASE}/users/login?x=1`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-auth': 'abc' },
            body: JSON.stringify({ email: 'rick', password: 'secret' })
        });
        assert.equal(response.status, 200);
        const last = upstream.seen[upstream.seen.length - 1];
        assert.equal(last.method, 'POST');
        assert.equal(last.url, `${API_BASE}/users/login?x=1`);
        assert.equal(last.headers['x-auth'], 'abc');
        assert.equal(last.headers.host, `127.0.0.1:${upstream.port}`);
        assert.deepEqual(JSON.parse(last.body), { email: 'rick', password: 'secret' });
    });

    it('tells the pool server where the browser reached the page, for sign-in callbacks', async () => {
        await fetch(`${base}${API_BASE}/auth/providers`);
        const direct = upstream.seen[upstream.seen.length - 1];
        assert.equal(direct.headers['x-forwarded-host'], base.replace('http://', ''));
        assert.equal(direct.headers['x-forwarded-proto'], 'http');

        await fetch(`${base}${API_BASE}/auth/providers`, { headers: { 'x-forwarded-host': 'pool.example.com', 'x-forwarded-proto': 'https' } });
        const proxied = upstream.seen[upstream.seen.length - 1];
        assert.equal(proxied.headers['x-forwarded-host'], 'pool.example.com', 'a proxy in front has the final say');
        assert.equal(proxied.headers['x-forwarded-proto'], 'https');
    });

    it('forwards the pool server’s Swagger UI', async () => {
        const response = await fetch(`${base}/docs/`);
        assert.deepEqual(await response.json(), { echoed: '/docs/' });
    });

    it('says the pool server is unreachable, rather than failing itself, when it is down', async () => {
        const orphan = createWebServer({ apiUrl: 'http://127.0.0.1:9' });
        const orphanBase = `http://127.0.0.1:${await listen(orphan)}`;
        try {
            const response = await fetch(`${orphanBase}${API_BASE}/status`);
            assert.equal(response.status, 502);
            assert.equal(response.headers.get(UNREACHABLE_HEADER), '1');
            assert.match((await response.json()).message, /can’t reach the pool server/);
        } finally {
            await close(orphan);
        }
    });

    describe('API client', () => {
        it('reads status with dates and numbers', async () => {
            const [reading] = await new Client(base).fetchStatus();
            assert.equal(reading.value, 1);
            assert.ok(reading.timestamp instanceof Date);
            assert.equal(reading.timestamp.toISOString(), '2026-01-02T03:04:05.000Z');
        });

        it('sends a JSON content type on every request, which the server’s validator needs', async () => {
            await new Client(base).fetchStatus();
            const last = upstream.seen[upstream.seen.length - 1];
            assert.equal(last.headers['content-type'], 'application/json');
        });

        it('reports a refused token as unauthorized', async () => {
            await assert.rejects(new Client(base).fetchAccount('stale'), (error) => error instanceof ApiError && error.kind === 'unauthorized');
        });

        it('reports a refusal with the server’s message, capitalized', async () => {
            await assert.rejects(new Client(base).setDevice('filter', true, 'token'), (error) => {
                assert.equal(error.kind, 'server');
                assert.equal(error.status, 403);
                assert.equal(error.message, 'The viewer role cannot do that');
                return true;
            });
        });

        it('reports a pool server that is down as unreachable', async () => {
            const orphan = createWebServer({ apiUrl: 'http://127.0.0.1:9' });
            const orphanBase = `http://127.0.0.1:${await listen(orphan)}`;
            try {
                await assert.rejects(new Client(orphanBase).fetchStatus(), (error) => error.kind === 'unreachable');
            } finally {
                await close(orphan);
            }
        });

        it('reports a web service that is down as unreachable', async () => {
            await assert.rejects(new Client('http://127.0.0.1:9').fetchStatus(), (error) => error.kind === 'unreachable');
        });

        it('builds history queries with ISO dates and names', async () => {
            const from = Date.parse('2026-01-01T00:00:00Z');
            const to = Date.parse('2026-01-02T00:00:00Z');
            await new Client(base).fetchHistory(['pool temp', 'ambient'], from, to).catch(() => {});
            const url = new URL(upstream.seen[upstream.seen.length - 1].url, 'http://x');
            assert.equal(url.pathname, `${API_BASE}/history`);
            assert.equal(url.searchParams.get('names'), 'pool temp,ambient');
            assert.equal(url.searchParams.get('from'), '2026-01-01T00:00:00.000Z');
            assert.equal(url.searchParams.get('to'), '2026-01-02T00:00:00.000Z');
        });

        it('leaves out event filters that are not set', async () => {
            await new Client(base).fetchEvents({ types: ['status', 'action'], ascending: false, limit: 50 }).catch(() => {});
            const url = new URL(upstream.seen[upstream.seen.length - 1].url, 'http://x');
            assert.equal(url.searchParams.get('types'), 'status,action');
            assert.equal(url.searchParams.get('order'), 'desc');
            assert.equal(url.searchParams.has('user'), false);
            assert.equal(url.searchParams.has('cursor'), false);
        });
    });
});
