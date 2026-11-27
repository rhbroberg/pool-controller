'use strict';

import { User as UserModel, DEFAULT_ADMIN_NAME, DEFAULT_ADMIN_PASSWORD, ROLES } from '../models/user';
const User: any = UserModel;
import * as utils from '../utils/writer';
import * as activity from './ActivityService';
import * as externalAuth from './ExternalAuthService';
import log4js from 'log4js';
var logger = log4js.getLogger();

const MINIMUM_PASSWORD_LENGTH = 6;
// these would collide with the /users/me, /users/login, /users/requests and /users/invitations routes
const RESERVED_NAMES = ['me', 'login', 'requests', 'invitations'];

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
 * admin: adds an account with a role (user if not given)
 *
 * returns User
 **/
export async function createUser(admin: any, credentials: any) {
    const name = (credentials.email || '').trim();
    const role = credentials.role || 'user';
    checkName(name);
    checkPassword(credentials.password);
    checkRole(role);
    if (await User.exists({ email: name })) {
        throw fail(409, 'that account name is already in use');
    }

    const account = new User({ email: name, password: credentials.password, role: role });
    await account.save();
    logger.info(`REST ${admin.email}: created ${role} account ${name}`);
    activity.record(admin, `Created ${role} account ${name}`);
    return describe(account);
};

/**
 * admin: every account and its role
 *
 * returns List
 **/
export async function listUsers() {
    const accounts = await User.find({}).sort({ email: 1 });
    return accounts.map(describe);
};

/**
 * admin: changes another account's role or resets its password; a reset password signs the
 * account out everywhere
 *
 * returns User
 **/
export async function updateUser(admin: any, name: any, changes: any) {
    const account = await findAccount(name);
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
    if (updated.length === 0) {
        throw fail(400, 'give a role or a password to change');
    }

    await account.save();
    logger.info(`REST ${admin.email}: account ${name}: ${updated.join(', ')}`);
    const sentence = described.join(' and ');
    activity.record(admin, sentence.charAt(0).toUpperCase() + sentence.slice(1));
    return describe(account);
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

    const token = await user.generateAuthToken();
    logger.info(user.mustChangeCredentials ? `signed in ${user.email}; the account must be commissioned` : `signed in ${user.email} (${user.role})`);
    activity.record(user, 'Signed in');
    return Object.assign(describe(user), { token: token });
};


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
