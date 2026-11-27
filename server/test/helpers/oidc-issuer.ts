'use strict';
// A tiny OpenID Connect service for the sign-in tests: discovery, an authorize endpoint that
// signs in whichever person the test chose, a token endpoint that checks the client secret and
// PKCE, and the key that signs its ID tokens.
import crypto from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import jwt from 'jsonwebtoken';

const KEY_ID = 'test-key';

export type IssuerPerson = {
    sub: string;
    email: string;
    emailVerified?: boolean;
    name?: string;
};

export type TestIssuer = {
    clientId: string;
    clientSecret: string;
    person: IssuerPerson | null;
    people?: IssuerPerson[];
    tokenRequests: number;
    base: string;
    stop: () => Promise<void>;
};

var startIssuer = async ({
    clientId = 'pool-test',
    clientSecret = 'pool-test-secret'
}: { clientId?: string; clientSecret?: string } = {}): Promise<TestIssuer> => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const codes = new Map<string, {
        person: IssuerPerson;
        nonce: string | null;
        challenge: string | null;
        redirectUri: string | null;
        clientId: string | null;
    }>();
    const issuer: Partial<TestIssuer> & {
        clientId: string;
        clientSecret: string;
        person: IssuerPerson | null;
        tokenRequests: number;
    } = { clientId, clientSecret, person: null, tokenRequests: 0 };

    const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || '/', issuer.base || 'http://127.0.0.1');
        const json = (status: number, body: unknown) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        if (url.pathname === '/.well-known/openid-configuration') {
            json(200, {
                issuer: issuer.base,
                authorization_endpoint: `${issuer.base}/authorize`,
                token_endpoint: `${issuer.base}/token`,
                jwks_uri: `${issuer.base}/jwks`,
                response_types_supported: ['code'],
                subject_types_supported: ['public'],
                id_token_signing_alg_values_supported: ['RS256'],
                code_challenge_methods_supported: ['S256'],
                token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic']
            });
        } else if (url.pathname === '/jwks') {
            json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KEY_ID, alg: 'RS256', use: 'sig' }] });
        } else if (url.pathname === '/authorize' && issuer.people && !url.searchParams.has('pick')) {
            // for trying sign-in in a browser: a page asking who to sign in as
            const choice = (pick: string, label: string) => {
                const next = new URL(url);
                next.searchParams.set('pick', pick);
                return `<p><a href="${next.href.replace(/&/g, '&amp;')}">${label}</a></p>`;
            };
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><title>Test ID</title><h1>Sign in to Test ID as</h1>${
                issuer.people.map((person, index) => choice(String(index), `${person.name} &lt;${person.email}&gt;`)).join('')
            }${choice('cancel', 'Cancel')}`);
        } else if (url.pathname === '/authorize') {
            const redirectUri = url.searchParams.get('redirect_uri');
            if (!redirectUri) {
                json(400, { error: 'invalid_request' });
                return;
            }
            const back = new URL(redirectUri);
            const state = url.searchParams.get('state');
            if (state) {
                back.searchParams.set('state', state);
            }
            if (issuer.people) {
                issuer.person = issuer.people[Number(url.searchParams.get('pick'))] || null;
            }
            if (!issuer.person) {
                back.searchParams.set('error', 'access_denied');
            } else {
                const code = crypto.randomUUID();
                codes.set(code, {
                    person: issuer.person,
                    nonce: url.searchParams.get('nonce'),
                    challenge: url.searchParams.get('code_challenge'),
                    redirectUri: url.searchParams.get('redirect_uri'),
                    clientId: url.searchParams.get('client_id')
                });
                back.searchParams.set('code', code);
            }
            res.writeHead(302, { Location: back.href });
            res.end();
        } else if (url.pathname === '/token' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk: Buffer | string) => { body += chunk; });
            req.on('end', () => {
                issuer.tokenRequests += 1;
                const form = new URLSearchParams(body);
                const basic = (req.headers.authorization || '').replace(/^Basic /, '');
                const [basicId, basicSecret] = basic ? Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent) : [];
                const id = form.get('client_id') || basicId;
                const secret = form.get('client_secret') || basicSecret;
                const code = form.get('code') || '';
                const grant = codes.get(code);
                codes.delete(code);
                const challenge = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
                if (id !== clientId || secret !== clientSecret) {
                    json(401, { error: 'invalid_client' });
                } else if (!grant || grant.redirectUri !== form.get('redirect_uri') || grant.challenge !== challenge || grant.clientId !== id) {
                    json(400, { error: 'invalid_grant' });
                } else {
                    const { sub, email, emailVerified = true, name } = grant.person;
                    const idToken = jwt.sign({ sub, email, email_verified: emailVerified, name, nonce: grant.nonce },
                        privateKey.export({ format: 'pem', type: 'pkcs8' }),
                        { algorithm: 'RS256', keyid: KEY_ID, issuer: issuer.base, audience: clientId, expiresIn: '5m' });
                    json(200, { access_token: crypto.randomUUID(), token_type: 'Bearer', expires_in: 300, id_token: idToken });
                }
            });
        } else {
            json(404, { error: 'not_found' });
        }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    issuer.base = `http://127.0.0.1:${port}`;
    issuer.stop = () => new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
    });
    return issuer as TestIssuer;
};

export { startIssuer };
