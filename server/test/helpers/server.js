'use strict';
// Starts the real server as a child process with its own port and database, and talks to its
// REST API the way a client would. Each test file gets its own server so files can run at once.
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const mongoose = require('mongoose');

const SERVER_DIR = path.join(__dirname, '..', '..');
const CAPTURE = path.join(SERVER_DIR, '..', 'test-data', 'sample-various-bin');
const API_BASE = '/rhbroberg/pool-api/1.0.0';
const MONGO_HOST = process.env.TEST_MONGO_HOST || 'mongodb://127.0.0.1:27017';
const STARTUP_MS = 20000;

var freePort = () => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
    });
});

var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * resolves with check()'s first truthy result, retrying until timeoutMs passes
 **/
var eventually = async (check, { timeoutMs = 10000, intervalMs = 150, message = 'condition' } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        try {
            last = await check();
            if (last) {
                return last;
            }
        } catch (e) {
            last = e;
        }
        await sleep(intervalMs);
    }
    throw new Error(`timed out waiting for ${message}; last saw ${last instanceof Error ? last.message : JSON.stringify(last)}`);
};

var dropDatabase = async (uri) => {
    const connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 3000 }).asPromise();
    try {
        await connection.dropDatabase();
    } finally {
        await connection.close();
    }
};

/**
 * starts a server on an empty database named `database`, replaying the sample capture through
 * `driver` (sim by default; none for a server with no controller attached)
 **/
var startServer = async ({ database, driver = 'sim', args: extraArgs = [], env: extraEnv = {} }) => {
    const port = await freePort();
    const uri = `${MONGO_HOST}/${database}`;
    await dropDatabase(uri);

    const args = ['server.js', '-d', driver, ...extraArgs];
    if (driver !== 'none') {
        args.push('-f', CAPTURE);
    }
    const child = spawn(process.execPath, args, {
        cwd: SERVER_DIR,
        env: { ...process.env, NODE_ENV: 'test', PORT: String(port), MONGODB_URI: uri, JWT_SECRET: 'rest-api-tests', ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

    const base = `http://127.0.0.1:${port}${API_BASE}`;
    const api = async (method, route, { token, body } = {}) => {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
        if (token) {
            headers['x-auth'] = token;
        }
        const response = await fetch(base + route, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await response.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch {
            json = undefined;
        }
        return { status: response.status, body: json, text };
    };

    try {
        await eventually(async () => (await api('GET', '/system/info')).status === 200,
            { timeoutMs: STARTUP_MS, message: 'the server to start' });
    } catch (e) {
        child.kill('SIGKILL');
        throw new Error(`${e.message}\n--- server output ---\n${output}`);
    }

    const stop = async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
            return exited;
        }
        child.kill('SIGTERM');
        const result = await Promise.race([exited, sleep(5000).then(() => undefined)]);
        if (!result) {
            child.kill('SIGKILL');
            return exited;
        }
        await dropDatabase(uri).catch(() => {});
        return result;
    };

    return { api, base, port, uri, stop, exited, output: () => output };
};

/**
 * renames the default admin/admin account, returning a token with every privilege
 **/
var commission = async (api, name = 'owner', password = 'owner-password') => {
    const login = await api('POST', '/users/login', { body: { email: 'admin', password: 'admin' } });
    if (login.status !== 200) {
        throw new Error(`default admin login failed with ${login.status}: ${login.text}`);
    }
    const renamed = await api('PUT', '/users/me/credentials', { token: login.body.token, body: { email: name, password } });
    if (renamed.status !== 200) {
        throw new Error(`commissioning failed with ${renamed.status}: ${renamed.text}`);
    }
    return renamed.body.token;
};

/**
 * creates an account with `role` and signs it in, returning its token
 **/
var account = async (api, adminToken, name, role, password = `${name}-password`) => {
    const created = await api('POST', '/users', { token: adminToken, body: { email: name, password, role } });
    if (created.status !== 200) {
        throw new Error(`creating ${name} failed with ${created.status}: ${created.text}`);
    }
    const login = await api('POST', '/users/login', { body: { email: name, password } });
    return login.body.token;
};

/**
 * the latest value of one reading from GET /status; switches, which it reports as 1 or 0, as
 * true or false
 **/
var reading = async (api, name) => {
    const status = await api('GET', '/status');
    const found = (status.body || []).find((entry) => entry.name === name);
    if (!found) {
        return undefined;
    }
    return found.category === 'status' ? Boolean(found.value) : found.value;
};

module.exports = { startServer, commission, account, reading, eventually, sleep };
