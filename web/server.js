// Serves the web front end and forwards its REST calls to the pool server, so the page and the
// API share an origin and the pool server needs no CORS support.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_BASE = '/rhbroberg/pool-api/1.0.0';
const DEFAULT_PORT = 80;
const DEFAULT_API_URL = 'http://localhost:3000';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
// the API, and the pool server's Swagger UI and the spec it loads
const PROXIED_PREFIXES = [`${API_BASE}/`, '/docs', '/api-docs'];
// longer than the slowest API call (a history window), shorter than a browser gives up
const PROXY_TIMEOUT_MS = 30000;
// tells the page the pool server, rather than this service, could not be reached
export const UNREACHABLE_HEADER = 'x-pool-web-unreachable';

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json'
};

/** the git commit this service was built from; an image has no .git, so its build passes it in */
export const describeCommit = () => {
    if (process.env.POOL_GIT_COMMIT) {
        return process.env.POOL_GIT_COMMIT;
    }
    try {
        return execFileSync('git', ['describe', '--always', '--dirty'],
            { cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown';
    } catch {
        return 'unknown';
    }
};

const isProxied = (pathname) => PROXIED_PREFIXES.some((prefix) => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix));

const sendJson = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
};

const serveFile = (req, res, pathname, publicDir) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { code: 405, message: 'only GET and HEAD are served here' }, { Allow: 'GET, HEAD' });
        return;
    }
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        sendJson(res, 400, { code: 400, message: 'the path is not valid' });
        return;
    }
    // normalizing the absolute path resolves any .. against the root, never above it
    const file = path.join(publicDir, path.normalize(decoded === '/' ? '/index.html' : decoded));
    if (!file.startsWith(publicDir + path.sep)) {
        sendJson(res, 404, { code: 404, message: 'not found' });
        return;
    }
    fs.stat(file, (statError, stats) => {
        if (statError || !stats.isFile()) {
            sendJson(res, 404, { code: 404, message: 'not found' });
            return;
        }
        res.writeHead(200, {
            'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
            'Content-Length': stats.size,
            // small files on a local network; always revalidate so an upgrade shows at once
            'Cache-Control': 'no-cache',
            'Last-Modified': stats.mtime.toUTCString(),
            'X-Content-Type-Options': 'nosniff'
        });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        fs.createReadStream(file).pipe(res);
    });
};

const proxy = (req, res, target) => {
    const transport = target.protocol === 'https:' ? https : http;
    const headers = { ...req.headers, host: target.host };
    const forwardedFor = req.socket.remoteAddress;
    if (forwardedFor) {
        headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${forwardedFor}` : forwardedFor;
    }
    // the pool server builds sign-in callback addresses from where the browser reached the page;
    // a proxy in front of this one, such as Caddy, has already said
    if (!headers['x-forwarded-host'] && req.headers.host) {
        headers['x-forwarded-host'] = req.headers.host;
        headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';
    }
    const basePath = target.pathname.replace(/\/$/, '');
    const upstream = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: basePath + req.url,
        headers
    }, (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
    });
    upstream.setTimeout(PROXY_TIMEOUT_MS, () => {
        upstream.destroy(new Error(`no answer within ${PROXY_TIMEOUT_MS / 1000} seconds`));
    });
    upstream.on('error', (error) => {
        if (res.headersSent) {
            res.destroy();
            return;
        }
        sendJson(res, 502, { code: 502, message: `can’t reach the pool server at ${target.host} (${error.code || error.message})` },
            { [UNREACHABLE_HEADER]: '1' });
    });
    req.pipe(upstream);
};

/**
 * the web service: files from publicDir, the API forwarded to apiUrl, and /config.json telling
 * the page which pool server that is and which commit this service was built from
 **/
export const createWebServer = ({ apiUrl = DEFAULT_API_URL, publicDir = PUBLIC_DIR, commit = describeCommit() } = {}) => {
    const target = new URL(apiUrl);
    const root = path.resolve(publicDir);
    return http.createServer((req, res) => {
        const { pathname } = new URL(req.url, 'http://localhost');
        if (isProxied(pathname)) {
            proxy(req, res, target);
        } else if (pathname === '/config.json') {
            sendJson(res, 200, { apiServer: target.host, webCommit: commit });
        } else {
            serveFile(req, res, pathname, root);
        }
    });
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const port = Number(process.env.PORT || DEFAULT_PORT);
    const apiUrl = process.env.POOL_API_URL || DEFAULT_API_URL;
    const server = createWebServer({ apiUrl });
    server.on('error', (error) => {
        if (error.code === 'EACCES') {
            console.error(`port ${port} needs more privileges here; set PORT to use another, such as PORT=8080`);
        } else if (error.code === 'EADDRINUSE') {
            console.error(`port ${port} is already in use; set PORT to use another`);
        } else {
            console.error(error);
        }
        process.exit(1);
    });
    server.listen(port, () => {
        console.log(`pool web front end on http://localhost:${port}, forwarding the API to ${apiUrl}`);
    });
    ['SIGTERM', 'SIGINT'].forEach((signal) => {
        process.once(signal, () => {
            server.close(() => process.exit(0));
            // keep-alive connections would otherwise hold the process open
            server.closeAllConnections();
        });
    });
}
