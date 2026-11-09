'use strict';
// Signing in through OpenID Connect services (Google, Microsoft, Apple, Auth0, ...): the
// browser or app is sent to the service, which sends it back to /auth/{provider}/callback; the
// server checks who it is and either signs in the account it belongs to, redeems an invitation,
// or records a request for an admin to approve. Accounts then use the same x-auth tokens as
// password sign-in.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const log4js = require('log4js');
const { User, ROLES, DEFAULT_ADMIN_NAME } = require('../models/user');
const { Provider, AccessRequest, Invitation } = require('../models/signIn');
const { Setting } = require('../models/setting');
const utils = require('../utils/writer.js');
const activity = require('./ActivityService');

var logger = log4js.getLogger();

const API_BASE = '/rhbroberg/pool-api/1.0.0';
const SETTINGS_ID = 'server';
// how long someone has to finish signing in at the service
const FLOW_MS = 10 * 60 * 1000;
// how long the page or app has to trade the ticket it was sent back with for a token
const TICKET_MS = 60 * 1000;
const LINK_MS = 5 * 60 * 1000;
// keeps strangers from filling the database with requests
const MAX_PENDING_REQUESTS = 50;
const IOS_CALLBACK = 'poolstatus://signin';
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RESERVED_PROVIDER_IDS = ['password'];
const RESERVED_NAMES = ['me', 'login', 'requests', 'invitations', DEFAULT_ADMIN_NAME];
const APPLE_ISSUER = 'https://appleid.apple.com';

var settings = { passwordSignIn: true, signInRequests: 'ask' };
// state -> the sign-in under way; ticket -> the account it signs in; code -> the account linking
var flows = new Map();
var tickets = new Map();
var links = new Map();
// provider id -> its discovered metadata, so each sign-in doesn't fetch it again
var discovered = new Map();
var oidcModule;

var fail = (code, message) => utils.respondWithCode(code, { code, message });

// openid-client is published only as an ES module
var oidc = async () => {
    if (!oidcModule) {
        oidcModule = await import('openid-client');
    }
    return oidcModule;
};

var put = (map, key, value, ms) => {
    const now = Date.now();
    for (const [k, entry] of map) {
        if (entry.expires < now) {
            map.delete(k);
        }
    }
    map.set(key, { ...value, expires: now + ms });
};

// the entry for key, once; undefined if there is none or it has expired
var take = (map, key) => {
    const entry = map.get(key);
    map.delete(key);
    return entry && entry.expires >= Date.now() ? entry : undefined;
};

var randomToken = () => crypto.randomBytes(24).toString('base64url');

var passwordSignInForced = () => process.env.POOL_FORCE_PASSWORD_SIGNIN === '1';

// plain http issuers are only for tests, which run a fake service on localhost
var insecureAllowed = (issuer) => process.env.OIDC_ALLOW_INSECURE === '1' && new URL(issuer).protocol === 'http:';

/**
 * reads the sign-in settings and forgets cached services and sign-ins under way; run at startup
 * and after a factory reset
 **/
exports.load = async function() {
    const doc = await Setting.findById(SETTINGS_ID).lean();
    settings = {
        passwordSignIn: !doc || doc.passwordSignIn !== false,
        signInRequests: doc && doc.signInRequests === 'refuse' ? 'refuse' : 'ask'
    };
    flows.clear();
    tickets.clear();
    links.clear();
    discovered.clear();
    if (passwordSignInForced() && !settings.passwordSignIn) {
        logger.warn('password sign-in is turned off, but POOL_FORCE_PASSWORD_SIGNIN=1 allows it anyway');
    }
};

exports.passwordSignInAllowed = function() {
    return settings.passwordSignIn || passwordSignInForced();
};

/**
 * the address the browser reached this server at: POOL_PUBLIC_URL if set, otherwise what the
 * proxies in front of it report
 **/
var publicOrigin = (req) => {
    if (process.env.POOL_PUBLIC_URL) {
        return process.env.POOL_PUBLIC_URL.replace(/\/+$/, '');
    }
    const first = (value) => value ? String(value).split(',')[0].trim() : undefined;
    const proto = first(req.headers['x-forwarded-proto']) || req.protocol || 'http';
    const host = first(req.headers['x-forwarded-host']) || req.headers.host;
    return `${proto}://${host}`;
};

var redirectUri = (origin, providerId) => `${origin}${API_BASE}/auth/${providerId}/callback`;

// Apple's client secret is a short-lived JWT signed with the key from the developer account
var clientSecretFor = (provider) => {
    if (provider.kind !== 'apple') {
        return provider.clientSecret || undefined;
    }
    const { teamId, keyId, privateKey } = provider.apple || {};
    return jwt.sign({}, privateKey, {
        algorithm: 'ES256',
        keyid: keyId,
        issuer: teamId,
        subject: provider.clientId,
        audience: APPLE_ISSUER,
        expiresIn: '10m'
    });
};

var configurationFor = async (provider) => {
    const client = await oidc();
    const insecure = insecureAllowed(provider.issuer);
    const stamp = `${provider.issuer} ${provider.updatedAt ? provider.updatedAt.getTime() : ''}`;
    let cached = discovered.get(provider._id);
    if (!cached || cached.stamp !== stamp) {
        const found = await client.discovery(new URL(provider.issuer), provider.clientId, undefined, undefined,
            insecure ? { execute: [client.allowInsecureRequests] } : undefined);
        cached = { stamp, metadata: found.serverMetadata() };
        discovered.set(provider._id, cached);
    }
    const config = new client.Configuration(cached.metadata, provider.clientId, clientSecretFor(provider));
    if (insecure) {
        client.allowInsecureRequests(config);
    }
    return config;
};

var enabledProvider = async (id) => {
    const provider = await Provider.findById(id);
    if (!provider || !provider.enabled) {
        throw fail(404, `signing in with ${id} isn't available here`);
    }
    return provider;
};

// where the browser or app goes once the service sends it back
var destination = (flow, query) => {
    const search = new URLSearchParams(query).toString();
    return flow.client === 'ios' ? `${IOS_CALLBACK}?${search}` : `${flow.origin}/#/signin/complete?${search}`;
};

/**
 * where to send the browser to sign in with a service; client is web or ios, link a code from
 * linkIdentity when an account is adding the service
 **/
exports.start = async function(req, providerId, { client, link } = {}) {
    const flow = { provider: providerId, client: client === 'ios' ? 'ios' : 'web', origin: publicOrigin(req) };
    try {
        const provider = await enabledProvider(providerId);
        if (link) {
            const linking = take(links, String(link));
            if (!linking || linking.provider !== provider._id) {
                throw fail(400, 'that request to link a service has expired; try again');
            }
            flow.linkUser = linking.userId;
        }
        const library = await oidc();
        const config = await configurationFor(provider);
        const state = library.randomState();
        flow.nonce = library.randomNonce();
        const params = {
            redirect_uri: redirectUri(flow.origin, provider._id),
            scope: provider.kind === 'apple' ? 'name email' : 'openid email profile',
            state,
            nonce: flow.nonce
        };
        if (provider.kind === 'apple') {
            // Apple doesn't do PKCE, and posts the result back when it's asked for a name or email
            params.response_mode = 'form_post';
        } else {
            flow.verifier = library.randomPKCECodeVerifier();
            params.code_challenge = await library.calculatePKCECodeChallenge(flow.verifier);
            params.code_challenge_method = 'S256';
        }
        put(flows, state, flow, FLOW_MS);
        return library.buildAuthorizationUrl(config, params).href;
    } catch (e) {
        const message = e && e.payload ? e.payload.message : 'the sign-in service could not be reached';
        logger.warn(`sign-in with ${providerId} could not start: ${e && e.payload ? message : e}`);
        return destination(flow, { error: message });
    }
};

var appleName = (user) => {
    try {
        const name = (typeof user === 'string' ? JSON.parse(user) : user || {}).name || {};
        return [name.firstName, name.lastName].filter(Boolean).join(' ') || undefined;
    } catch {
        return undefined;
    }
};

var uniqueName = async (wanted) => {
    const base = (wanted || 'user').trim() || 'user';
    let name = RESERVED_NAMES.includes(base.toLowerCase()) ? `${base}-1` : base;
    for (let n = 2; await User.exists({ email: name }); n++) {
        name = `${base}-${n}`;
    }
    return name;
};

var createExternalAccount = async (provider, profile, role) => {
    const account = new User({
        email: await uniqueName(profile.email || profile.name || `${provider._id}-user`),
        role,
        displayName: profile.name,
        identities: [{ provider: provider._id, subject: profile.subject, email: profile.email }]
    });
    await account.save();
    await AccessRequest.deleteOne({ provider: provider._id, subject: profile.subject });
    return account;
};

var redeemInvitation = async (provider, profile) => {
    if (!provider.trustEmail || !profile.emailVerified || !profile.email) {
        return null;
    }
    const invitation = await Invitation.findOne({
        email: profile.email.toLowerCase(),
        $or: [{ provider: null }, { provider: provider._id }]
    });
    if (!invitation) {
        return null;
    }
    const account = await createExternalAccount(provider, profile, invitation.role);
    await invitation.deleteOne();
    logger.info(`${account.email} joined through ${provider.displayName} with ${invitation.createdBy}'s invitation as ${invitation.role}`);
    activity.record(account, `Joined through ${provider.displayName} with an invitation from ${invitation.createdBy}`);
    return account;
};

// pending, denied or refused
var requestAccess = async (provider, profile) => {
    const existing = await AccessRequest.findOne({ provider: provider._id, subject: profile.subject });
    if (existing) {
        if (existing.status === 'denied') {
            return 'denied';
        }
        existing.lastSeen = new Date();
        existing.attempts += 1;
        existing.email = profile.email || existing.email;
        existing.name = profile.name || existing.name;
        await existing.save();
        return 'pending';
    }
    if (settings.signInRequests === 'refuse' || await AccessRequest.countDocuments({ status: 'pending' }) >= MAX_PENDING_REQUESTS) {
        logger.info(`refused ${profile.email || profile.subject} from ${provider.displayName}: no account or invitation`);
        return 'refused';
    }
    await AccessRequest.create({ provider: provider._id, subject: profile.subject, email: profile.email, name: profile.name });
    logger.info(`${profile.email || profile.subject} asked to sign in with ${provider.displayName}`);
    return 'pending';
};

var linkIdentity = async (provider, profile, userId) => {
    const owner = await User.findByIdentity(provider._id, profile.subject);
    if (owner && !owner._id.equals(userId)) {
        return { error: `That ${provider.displayName} account already signs in as ${owner.email}.` };
    }
    const account = await User.findById(userId);
    if (!account) {
        return { error: 'The account to link no longer exists.' };
    }
    if (!owner) {
        account.identities = account.identities.filter((identity) => identity.provider !== provider._id)
            .concat({ provider: provider._id, subject: profile.subject, email: profile.email });
        await account.save();
        await AccessRequest.deleteOne({ provider: provider._id, subject: profile.subject });
        logger.info(`REST ${account.email}: linked ${provider.displayName}`);
        activity.record(account, `Linked ${provider.displayName} for signing in`);
    }
    return { status: 'linked', provider: provider.displayName };
};

var admit = async (provider, profile, flow) => {
    if (flow.linkUser) {
        return linkIdentity(provider, profile, flow.linkUser);
    }
    const account = await User.findByIdentity(provider._id, profile.subject) || await redeemInvitation(provider, profile);
    if (account) {
        const ticket = randomToken();
        put(tickets, ticket, { userId: account._id.toString(), provider: provider.displayName }, TICKET_MS);
        return { ticket };
    }
    return { status: await requestAccess(provider, profile), provider: provider.displayName };
};

/**
 * the service has sent the browser back; answers where to send it next
 **/
exports.callback = async function(req, providerId) {
    const params = req.method === 'POST' ? req.body || {} : req.query || {};
    const flow = params.state ? take(flows, String(params.state)) : undefined;
    if (!flow || flow.provider !== providerId) {
        return destination({ client: 'web', origin: publicOrigin(req) }, { error: 'That sign-in has expired. Try again.' });
    }
    if (params.error) {
        return destination(flow, params.error === 'access_denied' || params.error === 'user_cancelled_authorize'
            ? { status: 'cancelled' }
            : { error: String(params.error_description || params.error) });
    }
    try {
        const library = await oidc();
        const provider = await enabledProvider(providerId);
        const config = await configurationFor(provider);
        const callbackUrl = redirectUri(flow.origin, providerId);
        let current;
        if (req.method === 'POST') {
            current = new Request(callbackUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(params).toString()
            });
        } else {
            current = new URL(callbackUrl);
            Object.entries(params).forEach(([key, value]) => current.searchParams.set(key, value));
        }
        const tokens = await library.authorizationCodeGrant(config, current, {
            pkceCodeVerifier: flow.verifier,
            expectedState: String(params.state),
            expectedNonce: flow.nonce,
            idTokenExpected: true
        });
        const claims = tokens.claims();
        const profile = {
            subject: String(claims.sub),
            email: claims.email ? String(claims.email) : undefined,
            emailVerified: claims.email_verified === true || claims.email_verified === 'true',
            name: claims.name || appleName(params.user) || undefined
        };
        return destination(flow, await admit(provider, profile, flow));
    } catch (e) {
        logger.warn(`sign-in with ${providerId} failed: ${e && e.payload ? e.payload.message : e}`);
        return destination(flow, { error: e && e.payload ? e.payload.message : 'The sign-in couldn’t be completed. Try again.' });
    }
};

/**
 * trades the ticket a completed sign-in sent back for a token, as POST /users/login does for a
 * password
 **/
exports.exchangeTicket = async function(ticket) {
    const entry = ticket ? take(tickets, String(ticket)) : undefined;
    const account = entry ? await User.findById(entry.userId) : null;
    if (!account) {
        throw fail(401, 'that sign-in has expired; sign in again');
    }
    account.lastSignInAt = new Date();
    const token = await account.generateAuthToken();
    logger.info(`signed in ${account.email} (${account.role}) with ${entry.provider}`);
    activity.record(account, `Signed in with ${entry.provider}`);
    return Object.assign(account.describe(), { token });
};

/**
 * the services shown on the sign-in page, and whether it offers a name and password
 **/
exports.listProviders = async function() {
    const providers = await Provider.find({ enabled: true }).sort({ displayName: 1 });
    return {
        passwordSignIn: exports.passwordSignInAllowed(),
        providers: providers.map((provider) => ({ id: provider._id, displayName: provider.displayName }))
    };
};

// MARK: an account's own services

/**
 * where to send the signed-in account's browser to add a service to it
 **/
exports.linkStart = async function(req, user, providerId, client) {
    const provider = await enabledProvider(providerId);
    const code = randomToken();
    put(links, code, { userId: user._id.toString(), provider: provider._id }, LINK_MS);
    const query = new URLSearchParams({ link: code, client: client === 'ios' ? 'ios' : 'web' });
    return { url: `${publicOrigin(req)}${API_BASE}/auth/${provider._id}/start?${query}` };
};

exports.unlink = async function(user, providerId) {
    const remaining = user.identities.filter((identity) => identity.provider !== providerId);
    if (remaining.length === user.identities.length) {
        throw fail(404, `this account doesn't sign in with ${providerId}`);
    }
    if (remaining.length === 0 && !user.hasPassword()) {
        throw fail(409, 'this is the only way this account signs in; link another service first');
    }
    user.identities = remaining;
    await user.save();
    logger.info(`REST ${user.email}: unlinked ${providerId}`);
    activity.record(user, `Stopped signing in with ${providerId}`);
    return user.describe();
};

// MARK: admin: services and settings

var providerView = (provider, origin) => ({
    id: provider._id,
    displayName: provider.displayName,
    kind: provider.kind,
    issuer: provider.issuer,
    clientId: provider.clientId,
    hasClientSecret: Boolean(provider.clientSecret),
    apple: provider.kind === 'apple' ? {
        teamId: (provider.apple || {}).teamId || '',
        keyId: (provider.apple || {}).keyId || '',
        hasPrivateKey: Boolean((provider.apple || {}).privateKey)
    } : undefined,
    enabled: provider.enabled,
    trustEmail: provider.trustEmail,
    redirectUri: redirectUri(origin, provider._id)
});

exports.getSignInSettings = async function(req) {
    const providers = await Provider.find({}).sort({ displayName: 1 });
    return {
        passwordSignIn: settings.passwordSignIn,
        passwordSignInForced: passwordSignInForced(),
        signInRequests: settings.signInRequests,
        redirectUriTemplate: redirectUri(publicOrigin(req), '{id}'),
        providers: providers.map((provider) => providerView(provider, publicOrigin(req)))
    };
};

// true if an admin could still sign in through the enabled services other than excluding
var externalAdminRemains = async (excluding) => {
    const ids = (await Provider.find({ enabled: true }).distinct('_id')).filter((id) => id !== excluding);
    return Boolean(await User.exists({ role: 'admin', 'identities.provider': { $in: ids } }));
};

var requireAdminSignIn = async (excluding) => {
    if (!settings.passwordSignIn && !await externalAdminRemains(excluding)) {
        throw fail(409, 'password sign-in is off, and no admin would be able to sign in any other way');
    }
};

exports.updateSignInSettings = async function(req, admin, changes) {
    const update = {};
    if (typeof changes.passwordSignIn === 'boolean') {
        if (!changes.passwordSignIn && !await externalAdminRemains()) {
            throw fail(409, 'link a sign-in service to an admin account before turning password sign-in off');
        }
        update.passwordSignIn = changes.passwordSignIn;
    }
    if (typeof changes.signInRequests !== 'undefined') {
        if (!['ask', 'refuse'].includes(changes.signInRequests)) {
            throw fail(400, 'signInRequests must be ask or refuse');
        }
        update.signInRequests = changes.signInRequests;
    }
    if (Object.keys(update).length === 0) {
        throw fail(400, 'give passwordSignIn or signInRequests to change');
    }
    await Setting.updateOne({ _id: SETTINGS_ID }, { $set: update }, { upsert: true });
    settings = Object.assign({}, settings, update);
    const notes = [];
    if ('passwordSignIn' in update) {
        notes.push(`password sign-in ${update.passwordSignIn ? 'on' : 'off'}`);
    }
    if ('signInRequests' in update) {
        notes.push(update.signInRequests === 'ask' ? 'newcomers may ask to join' : 'newcomers need an invitation');
    }
    logger.info(`REST ${admin.email}: ${notes.join('; ')}`);
    activity.record(admin, `Changed sign-in settings: ${notes.join('; ')}`);
    return exports.getSignInSettings(req);
};

var checkIssuer = (issuer) => {
    let url;
    try {
        url = new URL(issuer);
    } catch {
        throw fail(400, `${issuer} is not a URL`);
    }
    if (url.protocol !== 'https:' && !insecureAllowed(issuer)) {
        throw fail(400, 'the issuer must be an https address');
    }
};

// fetches the service's discovery document, so a typo shows when it's saved rather than at sign-in
var checkDiscovery = async (provider) => {
    discovered.delete(provider._id);
    try {
        await configurationFor(provider);
    } catch (e) {
        throw fail(400, `couldn't read ${provider.issuer}/.well-known/openid-configuration: ${e.message}`);
    }
};

var applyProviderChanges = (provider, changes) => {
    ['displayName', 'issuer', 'clientId'].forEach((field) => {
        if (typeof changes[field] === 'string' && changes[field].trim()) {
            provider[field] = changes[field].trim();
        }
    });
    if (typeof changes.clientSecret === 'string' && changes.clientSecret) {
        provider.clientSecret = changes.clientSecret;
    } else if (changes.clientSecret === null) {
        provider.clientSecret = undefined;
    }
    ['enabled', 'trustEmail'].forEach((field) => {
        if (typeof changes[field] === 'boolean') {
            provider[field] = changes[field];
        }
    });
    if (provider.kind === 'apple' && changes.apple) {
        provider.apple = provider.apple || {};
        ['teamId', 'keyId', 'privateKey'].forEach((field) => {
            if (typeof changes.apple[field] === 'string' && changes.apple[field].trim()) {
                provider.apple[field] = changes.apple[field].trim();
            }
        });
    }
};

var checkAppleKey = (provider) => {
    const { teamId, keyId, privateKey } = provider.apple || {};
    if (!teamId || !keyId || !privateKey) {
        throw fail(400, 'Apple needs the team ID, key ID and private key');
    }
    try {
        clientSecretFor(provider);
    } catch (e) {
        throw fail(400, `the Apple private key can't sign: ${e.message}`);
    }
};

exports.createProvider = async function(req, admin, body) {
    const id = String(body.id || '').trim().toLowerCase();
    if (!PROVIDER_ID.test(id) || RESERVED_PROVIDER_IDS.includes(id)) {
        throw fail(400, 'the id must be lowercase letters, digits and dashes, such as google');
    }
    if (await Provider.exists({ _id: id })) {
        throw fail(409, `there is already a service with the id ${id}`);
    }
    const kind = body.kind === 'apple' ? 'apple' : 'oidc';
    const provider = new Provider({
        _id: id,
        kind,
        displayName: body.displayName,
        issuer: kind === 'apple' ? APPLE_ISSUER : body.issuer,
        clientId: body.clientId,
        enabled: body.enabled !== false,
        trustEmail: body.trustEmail === true
    });
    applyProviderChanges(provider, Object.assign({}, body, { issuer: provider.issuer }));
    if (!provider.displayName || !provider.issuer || !provider.clientId) {
        throw fail(400, 'a service needs a name, an issuer and a client ID');
    }
    checkIssuer(provider.issuer);
    if (kind === 'apple') {
        checkAppleKey(provider);
    }
    await checkDiscovery(provider);
    await provider.save();
    logger.info(`REST ${admin.email}: added sign-in service ${id} (${provider.issuer})`);
    activity.record(admin, `Added ${provider.displayName} for signing in`);
    return providerView(provider, publicOrigin(req));
};

exports.updateProvider = async function(req, admin, id, changes) {
    const provider = await Provider.findById(id);
    if (!provider) {
        throw fail(404, `there is no service with the id ${id}`);
    }
    if (changes.enabled === false && provider.enabled) {
        await requireAdminSignIn(id);
    }
    const before = `${provider.issuer} ${provider.clientId}`;
    applyProviderChanges(provider, provider.kind === 'apple' ? Object.assign({}, changes, { issuer: APPLE_ISSUER }) : changes);
    checkIssuer(provider.issuer);
    if (provider.kind === 'apple') {
        checkAppleKey(provider);
    }
    if (before !== `${provider.issuer} ${provider.clientId}`) {
        await checkDiscovery(provider);
    }
    await provider.save();
    discovered.delete(id);
    logger.info(`REST ${admin.email}: changed sign-in service ${id}`);
    activity.record(admin, `Changed ${provider.displayName} for signing in${typeof changes.enabled === 'boolean' ? (changes.enabled ? ' (on)' : ' (off)') : ''}`);
    return providerView(provider, publicOrigin(req));
};

exports.deleteProvider = async function(admin, id) {
    const provider = await Provider.findById(id);
    if (!provider) {
        throw fail(404, `there is no service with the id ${id}`);
    }
    await requireAdminSignIn(id);
    await provider.deleteOne();
    await AccessRequest.deleteMany({ provider: id });
    discovered.delete(id);
    logger.info(`REST ${admin.email}: removed sign-in service ${id}`);
    activity.record(admin, `Removed ${provider.displayName} for signing in`);
    return { code: 200, message: `removed ${id}` };
};

// MARK: admin: requests and invitations

var checkRole = (role) => {
    if (!ROLES.includes(role)) {
        throw fail(400, `role must be one of ${ROLES.join(', ')}`);
    }
};

var providerNames = async () => {
    const providers = await Provider.find({}, { displayName: 1 }).lean();
    return Object.fromEntries(providers.map((provider) => [provider._id, provider.displayName]));
};

var requestView = (request, names) => ({
    id: request._id.toString(),
    provider: request.provider,
    providerName: names[request.provider] || request.provider,
    email: request.email || null,
    name: request.name || null,
    status: request.status,
    firstSeen: request.firstSeen,
    lastSeen: request.lastSeen,
    attempts: request.attempts
});

exports.listRequests = async function() {
    const [requests, names] = await Promise.all([AccessRequest.find({}).sort({ lastSeen: -1 }), providerNames()]);
    return requests.map((request) => requestView(request, names));
};

var findRequest = async (id) => {
    const request = /^[0-9a-f]{24}$/.test(id) ? await AccessRequest.findById(id) : null;
    if (!request) {
        throw fail(404, 'there is no such request');
    }
    return request;
};

exports.approveRequest = async function(admin, id, role) {
    checkRole(role);
    const request = await findRequest(id);
    const provider = await Provider.findById(request.provider);
    if (!provider) {
        throw fail(409, `${request.provider} is no longer a sign-in service here`);
    }
    if (await User.findByIdentity(request.provider, request.subject)) {
        await request.deleteOne();
        throw fail(409, 'that person already has an account');
    }
    const account = await createExternalAccount(provider, request, role);
    logger.info(`REST ${admin.email}: approved ${account.email} (${provider.displayName}) as ${role}`);
    activity.record(admin, `Approved ${account.email} (${provider.displayName}) as ${role}`);
    return account.describe();
};

exports.denyRequest = async function(admin, id) {
    const request = await findRequest(id);
    request.status = 'denied';
    await request.save();
    const who = request.email || request.name || request.subject;
    logger.info(`REST ${admin.email}: denied ${who} (${request.provider})`);
    activity.record(admin, `Denied ${who} (${request.provider}) from signing in`);
    return requestView(request, await providerNames());
};

exports.forgetRequest = async function(admin, id) {
    const request = await findRequest(id);
    await request.deleteOne();
    logger.info(`REST ${admin.email}: forgot the request from ${request.email || request.subject}`);
    return { code: 200, message: 'forgotten' };
};

var invitationView = (invitation, names) => ({
    id: invitation._id.toString(),
    email: invitation.email,
    provider: invitation.provider,
    providerName: invitation.provider ? names[invitation.provider] || invitation.provider : null,
    role: invitation.role,
    createdBy: invitation.createdBy,
    createdAt: invitation.createdAt
});

exports.listInvitations = async function() {
    const [invitations, names] = await Promise.all([Invitation.find({}).sort({ email: 1 }), providerNames()]);
    return invitations.map((invitation) => invitationView(invitation, names));
};

exports.createInvitation = async function(admin, body) {
    const email = String(body.email || '').trim().toLowerCase();
    const role = body.role || 'user';
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
        throw fail(400, 'give the email address the person signs in with');
    }
    checkRole(role);
    const provider = body.provider || null;
    if (provider && !await Provider.exists({ _id: provider })) {
        throw fail(400, `${provider} is not a sign-in service here`);
    }
    if (await Invitation.exists({ email })) {
        throw fail(409, `${email} is already invited`);
    }
    const invitation = await Invitation.create({ email, role, provider, createdBy: admin.email });
    logger.info(`REST ${admin.email}: invited ${email} as ${role}`);
    activity.record(admin, `Invited ${email} as ${role}`);
    return invitationView(invitation, await providerNames());
};

exports.deleteInvitation = async function(admin, id) {
    const invitation = /^[0-9a-f]{24}$/.test(id) ? await Invitation.findById(id) : null;
    if (!invitation) {
        throw fail(404, 'there is no such invitation');
    }
    await invitation.deleteOne();
    logger.info(`REST ${admin.email}: withdrew the invitation for ${invitation.email}`);
    activity.record(admin, `Withdrew the invitation for ${invitation.email}`);
    return { code: 200, message: `withdrew ${invitation.email}'s invitation` };
};
