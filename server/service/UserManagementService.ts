'use strict';

import crypto from 'crypto';
import { User as UserModel, DEFAULT_ADMIN_NAME, DEFAULT_ADMIN_PASSWORD, ROLES } from '../models/user';
const User: any = UserModel;
import * as utils from '../utils/writer';
import * as names from '../utils/names';
import * as activity from './ActivityService';
import * as externalAuth from './ExternalAuthService';
import log4js from 'log4js';
var logger = log4js.getLogger();

const MINIMUM_PASSWORD_LENGTH = 6;
// these would collide with the /users/me, /users/login, /users/requests, /users/invitations,
// /users/guests and /users/archived routes
const RESERVED_NAMES = ['me', 'login', 'requests', 'invitations', 'guests', 'archived'];
const GUEST_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// how many generated names to try before adding a number to one
const GUEST_NAME_TRIES = 20;

var requireJwtSecret = () => {
    if (!process.env.JWT_SECRET) {
        throw utils.respondWithCode(500, { code: 500, message: 'the server has no JWT_SECRET configured' });
    }
};

var fail = (code: any, message: any) => utils.respondWithCode(code, { code: code, message: message });

var describe = (user: any) => user.describe();

var checkName = (name: any) => {
    if (!name) {
        throw fail(400, 'an account name is required');
    }
    if (RESERVED_NAMES.includes(name.toLowerCase())) {
        throw fail(400, `${name} cannot be used as an account name`);
    }
};

var checkPassword = (password: any) => {
    if (!password || password.length < MINIMUM_PASSWORD_LENGTH || password === DEFAULT_ADMIN_PASSWORD) {
        throw fail(400, `choose a password of at least ${MINIMUM_PASSWORD_LENGTH} characters`);
    }
};

var checkRole = (role: any) => {
    if (!ROLES.includes(role)) {
        throw fail(400, `role must be one of ${ROLES.join(', ')}`);
    }
};

// keeps at least one admin who can manage the others
var requireAnotherAdmin = async (user: any) => {
    if (user.role === 'admin' && await User.countDocuments({ role: 'admin', _id: { $ne: user._id } }) === 0) {
        throw fail(409, `${user.email} is the only admin`);
    }
};

var findAccount = async (name: any) => {
    const account = await User.findOne({ email: name });
    if (!account) {
        throw fail(404, `there is no account named ${name}`);
    }
    return account;
};

/**
 * an expiry as given to the API: undefined when not given, null for none, otherwise a Date that
 * must be in the future
 **/
var parseExpiry = (value: unknown) => {
    if (value === undefined || value === null) {
        return value;
    }
    const date = new Date(value as string | number | Date);
    if (Number.isNaN(date.getTime())) {
        throw fail(400, `${value} is not a date`);
    }
    if (date.getTime() <= Date.now()) {
        throw fail(400, 'choose an expiry in the future');
    }
    return date;
};

var expiryNote = (date: Date | null | undefined) => date ? `, expiring ${date.toISOString()}` : '';

/**
 * archives every account past its expiry, which signs it out everywhere; resolves with how many
 **/
export async function archiveExpired(now = new Date()) {
    const archived = await User.archiveExpired(now);
    for (const account of archived) {
        logger.info(`archived ${account.email}, which expired ${account.expiresAt.toISOString()}`);
        activity.record(account, 'Archived: the account expired');
    }
    return archived.length;
}

/**
 * refuses an account that can't sign in any more, archiving one that has just expired
 **/
var refuseInactive = async (account: any) => {
    if (account.isActive()) {
        return;
    }
    if (!account.archivedAt) {
        await archiveExpired();
    }
    throw fail(401, 'this account has expired');
};

// admins don't expire, so the server can't be left with no one to manage it
var checkExpiryForRole = (role: string, expiresAt: Date | null | undefined) => {
    if (role === 'admin' && expiresAt) {
        throw fail(400, 'admin accounts don’t expire');
    }
};

/**
 * admin: adds an account with a role (user if not given) and optionally an expiry
 *
 * returns User
 **/
export async function createUser(admin: any, credentials: any) {
    const name = (credentials.email || '').trim();
    const role = credentials.role || 'user';
    checkName(name);
    checkPassword(credentials.password);
    checkRole(role);
    const expiresAt = parseExpiry(credentials.expiresAt);
    checkExpiryForRole(role, expiresAt);
    if (await User.exists({ email: name })) {
        throw fail(409, 'that account name is already in use');
    }

    const account = new User({ email: name, password: credentials.password, role: role, expiresAt: expiresAt || undefined });
    await account.save();
    logger.info(`REST ${admin.email}: created ${role} account ${name}${expiryNote(expiresAt)}`);
    activity.record(admin, `Created ${role} account ${name}`);
    return account.describeForAdmin();
};

/**
 * admin: adds a guest, an operator with a generated name and no password, which a one-time code
 * lets in to set one; it expires after a week unless another expiry, or null for none, is given
 *
 * returns Account, with the setupCode for its link and QR code
 **/
export async function createGuest(admin: any, options: any) {
    if (!externalAuth.passwordSignInAllowed()) {
        throw fail(409, 'guests sign in with a password, and password sign-in is turned off here');
    }
    const requested = parseExpiry(options ? options.expiresAt : undefined);
    const expiresAt = requested === undefined ? new Date(Date.now() + GUEST_DAYS * DAY_MS) : requested;

    let name;
    for (let tries = 0; tries < GUEST_NAME_TRIES && !name; tries++) {
        const candidate = names.guestName();
        if (!await User.exists({ email: candidate })) {
            name = candidate;
        }
    }
    for (let number = 2; !name; number++) {
        const candidate = `${names.guestName()}-${number}`;
        if (!await User.exists({ email: candidate })) {
            name = candidate;
        }
    }

    const account = new User({
        email: name,
        role: 'user',
        guest: true,
        setupCode: names.setupCode(),
        mustChangeCredentials: true,
        expiresAt: expiresAt || undefined
    });
    await account.save();
    logger.info(`REST ${admin.email}: created guest ${name}${expiryNote(expiresAt)}`);
    activity.record(admin, `Created guest ${name}`);
    return account.describeForAdmin();
}

/**
 * admin: the accounts, by name, with their dates; archived ones only when asked for, with
 * archived 'include' (all) or 'only'
 *
 * returns List
 **/
export async function listUsers(archived?: string) {
    await archiveExpired();
    const filter = archived === 'include' ? {} : archived === 'only' ? { archivedAt: { $ne: null } } : { archivedAt: null };
    const accounts = await User.find(filter).sort({ email: 1 });
    return accounts.map((account: any) => account.describeForAdmin());
}

/**
 * admin: removes every archived account
 *
 * returns ApiResponse
 **/
export async function deleteArchivedUsers(admin: any) {
    await archiveExpired();
    const archived = await User.find({ archivedAt: { $ne: null } }).select({ email: 1 }).lean();
    const { deletedCount } = await User.deleteMany({ _id: { $in: archived.map((account: any) => account._id) } });
    logger.info(`REST ${admin.email}: removed ${deletedCount} archived accounts${deletedCount ? `: ${archived.map((account: any) => account.email).join(', ')}` : ''}`);
    if (deletedCount > 0) {
        activity.record(admin, `Removed ${deletedCount} archived ${deletedCount === 1 ? 'account' : 'accounts'}`);
    }
    return { code: 200, message: `removed ${deletedCount} archived ${deletedCount === 1 ? 'account' : 'accounts'}` };
}

/**
 * admin: changes another account's role or resets its password; a reset password signs the
 * account out everywhere
 *
 * returns User
 **/
export async function updateUser(admin: any, name: any, changes: any) {
    const account = await findAccount(name);
    if (account.archivedAt) {
        throw fail(409, `${name} is archived; remove it, or add the account again`);
    }
    const updated = [] as any[];
    const described = [] as any[];

    if (typeof changes.role !== 'undefined' && changes.role !== account.role) {
        checkRole(changes.role);
        if (changes.role !== 'admin') {
            await requireAnotherAdmin(account);
        }
        updated.push(`role ${account.role} -> ${changes.role}`);
        described.push(`changed ${name}'s role from ${account.role} to ${changes.role}`);
        account.role = changes.role;
    }
    if (typeof changes.password !== 'undefined') {
        checkPassword(changes.password);
        account.password = changes.password;
        account.tokens = [];
        updated.push('password reset');
        described.push(`reset ${name}'s password`);
    }
    if (typeof changes.expiresAt !== 'undefined') {
        const expiresAt = parseExpiry(changes.expiresAt);
        checkExpiryForRole(account.role, expiresAt);
        account.expiresAt = expiresAt || undefined;
        updated.push(expiresAt ? `expires ${expiresAt.toISOString()}` : 'no expiry');
        described.push(expiresAt ? `set ${name} to expire ${expiresAt.toISOString()}` : `stopped ${name} expiring`);
    } else if (account.role === 'admin' && account.expiresAt) {
        // made an admin above, which never expires
        account.expiresAt = undefined;
        updated.push('no expiry');
    }
    if (updated.length === 0) {
        throw fail(400, 'give a role, a password or an expiry to change');
    }

    await account.save();
    logger.info(`REST ${admin.email}: account ${name}: ${updated.join(', ')}`);
    const sentence = described.join(' and ');
    activity.record(admin, sentence.charAt(0).toUpperCase() + sentence.slice(1));
    return account.describeForAdmin();
};

/**
 * admin: removes an account
 *
 * returns ApiResponse
 **/
export async function deleteUser(admin: any, name: any) {
    const account = await findAccount(name);
    await requireAnotherAdmin(account);
    await account.deleteOne();
    logger.info(`REST ${admin.email}: removed account ${name}`);
    activity.record(admin, `Removed account ${name}`);
    return { code: 200, message: `removed ${name}` };
};


/**
 * the signed-in account
 *
 * returns User
 **/
export async function getUser(user: any) {
    return describe(user);
};


/**
 * returns User with a token to send as the x-auth header; mustChangeCredentials means the
 * token is only good for changeCredentials until the account is renamed
 **/
export async function loginUser(credentials: any) {
    requireJwtSecret();
    if (!externalAuth.passwordSignInAllowed()) {
        throw fail(403, 'password sign-in is turned off here; sign in with one of the services instead');
    }

    let user;
    try {
        user = await User.findByCredentials(credentials.email, credentials.password);
    } catch {
        throw fail(401, 'incorrect name or password');
    }
    await refuseInactive(user);

    user.recordSignIn();
    const token = await user.generateAuthToken();
    logger.info(user.mustChangeCredentials ? `signed in ${user.email}; the account must be commissioned` : `signed in ${user.email} (${user.role})`);
    activity.record(user, 'Signed in');
    return Object.assign(describe(user), { token: token });
};

/**
 * signs a guest in with the one-time code from its link or QR code, as POST /users/login does
 * with a password. The token, like the default admin's, is only good for setting a password
 * (changeCredentials); once one is set the code stops working, and the guest signs in with it.
 *
 * returns User with a token and mustChangeCredentials
 **/
export async function loginGuest(credentials: any) {
    requireJwtSecret();
    if (!externalAuth.passwordSignInAllowed()) {
        throw fail(403, 'password sign-in is turned off here; sign in with one of the services instead');
    }
    const name = credentials && credentials.email ? String(credentials.email) : '';
    const code = credentials && credentials.code ? String(credentials.code) : '';
    const account = name ? await User.findOne({ email: name }) : null;
    if (!account || !account.guest) {
        throw fail(401, 'that guest link isn’t valid');
    }
    await refuseInactive(account);
    if (!account.setupCode) {
        throw fail(409, `${name} has already set a password; sign in with it`);
    }
    const expected = Buffer.from(account.setupCode);
    const given = Buffer.from(code);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
        throw fail(401, 'that guest link isn’t valid');
    }

    account.recordSignIn();
    const token = await account.generateAuthToken();
    logger.info(`signed in guest ${account.email} with its link; it must set a password`);
    activity.record(account, 'Signed in with a guest link');
    return Object.assign(describe(account), { token });
}


/**
 * renames the signed-in account and sets its password; this is how the default admin account
 * is commissioned, and how any account changes its own password. Every earlier token for the
 * account stops working.
 *
 * returns User
 **/
export async function changeCredentials(user: any, credentials: any) {
    requireJwtSecret();

    const name = (credentials.email || '').trim();
    checkName(name);
    if (name.toLowerCase() === DEFAULT_ADMIN_NAME && user.mustChangeCredentials) {
        throw fail(400, `choose an account name other than ${DEFAULT_ADMIN_NAME}`);
    }
    checkPassword(credentials.password);
    if (await User.exists({ email: name, _id: { $ne: user._id } })) {
        throw fail(409, 'that account name is already in use');
    }

    const previousName = user.email;
    user.email = name;
    user.password = credentials.password;
    user.mustChangeCredentials = false;
    // a guest's link only lets it in to set its first password
    user.setupCode = undefined;
    user.tokens = [];
    await user.save();
    const token = await user.generateAuthToken();

    logger.info(previousName === name
        ? `REST ${name}: changed password`
        : `REST ${previousName}: account renamed to ${name} with a new password`);
    activity.record(user, previousName === name ? 'Changed own password' : `Renamed account ${previousName} to ${name} and set its password`);
    return Object.assign(describe(user), { token: token });
};


/**
 * signs the current token out
 *
 * returns ApiResponse
 **/
export async function logoutUser(user: any, token: any) {
    await user.removeToken(token);
    logger.info(`REST ${user.email}: signed out`);
    activity.record(user, 'Signed out');
    return { code: 200, message: 'signed out' };
};
