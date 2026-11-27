'use strict';
// Starts the real server as a child process with its own port and database, and talks to its
// REST API the way a client would. Each test file gets its own server so files can run at once.
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import mongoose from 'mongoose';
import { errorMessageOf } from '../../types/domain';

const SERVER_DIR = path.join(__dirname, '..', '..');
const CAPTURE = path.join(SERVER_DIR, 'test', 'test-data', 'sample-various-bin');
const API_BASE = '/rhbroberg/pool-api/1.0.0';
const MONGO_HOST = process.env.TEST_MONGO_HOST || 'mongodb://127.0.0.1:27017';
const STARTUP_MS = 20000;

export type ApiResult = {
    status: number;
    body: any;
    text: string;
};

export type ApiClient = (
    method: string,
    route: string,
    opts?: { token?: string; body?: unknown }
) => Promise<ApiResult>;

export type TestServer = {
    api: ApiClient;
    base: string;
    port: number;
    uri: string;
    stop: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    output: () => string;
};

var freePort = (): Promise<number> => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, () => {
        const address = probe.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        probe.close(() => resolve(port));
    });
});

var sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * resolves with check()'s first truthy result, retrying until timeoutMs passes
 **/
var eventually = async <T>(
    check: () => Promise<T | false | null | undefined> | T | false | null | undefined,
    { timeoutMs = 10000, intervalMs = 150, message = 'condition' }: { timeoutMs?: number; intervalMs?: number; message?: string } = {}
): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
        try {
            last = await check();
            if (last) {
                return last as T;
            }
        } catch (e) {
            last = e;
        }
        await sleep(intervalMs);
    }
    throw new Error(`timed out waiting for ${message}; last saw ${last instanceof Error ? last.message : JSON.stringify(last)}`);
};

var dropDatabase = async (uri: string) => {
    const connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 3000 }).asPromise();
    try {
        await connection.dropDatabase();
    } finally {
        await connection.close();
    }
};

/**
 * starts a server on an empty database named `database`, replaying `capture` (the sample capture
 * by default) through `driver` (sim by default; none for a server with no controller attached)
 **/
var startServer = async ({
    database,
    driver = 'sim',
    capture = CAPTURE,
    args: extraArgs = [],
    env: extraEnv = {}
}: {
    database: string;
    driver?: string;
    capture?: string;
    args?: string[];
    env?: Record<string, string>;
}): Promise<TestServer> => {
    const port = await freePort();
    const uri = `${MONGO_HOST}/${database}`;
    await dropDatabase(uri);

    const args = ['--import', 'tsx', 'server.ts', '-d', driver, ...extraArgs];
    if (driver !== 'none') {
        args.push('-f', capture);
    }
    const child: ChildProcess = spawn(process.execPath, args, {
        cwd: SERVER_DIR,
        env: { ...process.env, NODE_ENV: 'test', PORT: String(port), MONGODB_URI: uri, JWT_SECRET: 'rest-api-tests', ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer | string) => { output += chunk; });
    child.stderr?.on('data', (chunk: Buffer | string) => { output += chunk; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.on('exit', (code, signal) => resolve({ code, signal })));

    const base = `http://127.0.0.1:${port}${API_BASE}`;
    const api: ApiClient = async (method, route, { token, body } = {}) => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
        if (token) {
            headers['x-auth'] = token;
        }
        const response = await fetch(base + route, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await response.text();
        let json: any;
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
        throw new Error(`${errorMessageOf(e)}\n--- server output ---\n${output}`);
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
var commission = async (api: ApiClient, name = 'owner', password = 'owner-password') => {
    const login = await api('POST', '/users/login', { body: { email: 'admin', password: 'admin' } });
    if (login.status !== 200) {
        throw new Error(`default admin login failed with ${login.status}: ${login.text}`);
    }
    const renamed = await api('PUT', '/users/me/credentials', { token: login.body.token, body: { email: name, password } });
    if (renamed.status !== 200) {
        throw new Error(`commissioning failed with ${renamed.status}: ${renamed.text}`);
    }
    return renamed.body.token as string;
};

/**
 * creates an account with `role` and signs it in, returning its token
 **/
var account = async (api: ApiClient, adminToken: string, name: string, role: string, password = `${name}-password`) => {
    const created = await api('POST', '/users', { token: adminToken, body: { email: name, password, role } });
    if (created.status !== 200) {
        throw new Error(`creating ${name} failed with ${created.status}: ${created.text}`);
    }
    const login = await api('POST', '/users/login', { body: { email: name, password } });
    return login.body.token as string;
};

/**
 * the latest value of one reading from GET /status; switches, which it reports as 1 or 0, as
 * true or false
 **/
var reading = async (api: ApiClient, name: string) => {
    const status = await api('GET', '/status');
    const found = (status.body || []).find((entry: { name: string; category?: string; value?: unknown }) => entry.name === name);
    if (!found) {
        return undefined;
    }
    return found.category === 'status' ? Boolean(found.value) : found.value;
};

export { startServer, commission, account, reading, eventually, sleep };
