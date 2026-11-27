'use strict';

import { errorMessageOf } from '../types/domain';

import type { AuthUser } from '../types/domain';

var { mongoose } = require('../mongoose');
var { Event } = require('../models/event');
var { User, DEFAULT_ADMIN_NAME, DEFAULT_ADMIN_PASSWORD } = require('../models/user');
var { Rollup } = require('../models/rollup');
var { Provider, AccessRequest, Invitation } = require('../models/signIn');
var { WeatherHour, WeatherDay } = require('../models/weather');
var utils = require('../utils/writer');
const activity = require('./ActivityService');
const log4js = require('log4js');
var logger = log4js.getLogger();

// long enough for the response to reach the client before the process goes away
const RESTART_DELAY_MS = 500;

var resetListener = () => {};

export function registerResetListener(listener: () => void) {
    resetListener = listener;
};

var nameOf = (user?: AuthUser | null) => user && user.email ? user.email : 'unknown user';

const SERVICE_NAME = 'pool-controller';
const { version } = require('../package.json');
const { commit, apiVersion } = require('../utils/buildInfo');
const startedAt = new Date();

/**
 * identifies the service, so a client can tell it found a pool controller server, and the build
 * it is running
 *
 * returns SystemInfo
 **/
export function info() {
    return { service: SERVICE_NAME, version, apiVersion, commit, startedAt };
};

/**
 * creates the default admin account if there are no accounts; run at startup
 **/
export async function commissionIfEmpty() {
    const upgraded = await User.assignLegacyRoles();
    if (upgraded > 0) {
        logger.warn(`gave the admin role to ${upgraded} account(s) created before roles existed`);
    }
    if (await User.ensureDefaultAdmin()) {
        logger.warn(`no accounts exist; created ${DEFAULT_ADMIN_NAME} / ${DEFAULT_ADMIN_PASSWORD}, which must be renamed before it can change anything`);
    }
};

/**
 * erases all history and accounts, then recreates the default admin account
 *
 * returns ApiResponse
 **/
export async function factoryReset(user?: AuthUser | null) {
    const who = nameOf(user);
    logger.warn(`REST ${who}: factory reset; erasing all history and accounts`);
    try {
        await mongoose.connection.dropDatabase();
        await Promise.all([Event, User, Rollup, Provider, AccessRequest, Invitation, WeatherHour, WeatherDay].map((model) => model.createIndexes()));
        await commissionIfEmpty();
    } catch (e) {
        logger.error(`factory reset failed: ${e}`);
        throw utils.respondWithCode(500, { code: 500, message: `factory reset failed: ${errorMessageOf(e)}` });
    }
    resetListener();
    // the first entry in the fresh history says who wiped the old one
    await activity.record(user, 'Factory reset: erased all history and accounts');
    return { code: 200, message: `factory reset complete; sign in as ${DEFAULT_ADMIN_NAME} / ${DEFAULT_ADMIN_PASSWORD} to commission the server` };
};

/**
 * exits the process so the container's restart policy starts a fresh one
 *
 * returns ApiResponse
 **/
export async function restart(user?: AuthUser | null) {
    logger.warn(`REST ${nameOf(user)}: restart requested; exiting`);
    await activity.record(user, 'Restarted the server');
    setTimeout(() => {
        mongoose.disconnect()
            .catch(() => {})
            .then(() => process.exit(0));
    }, RESTART_DELAY_MS);
    return { code: 200, message: 'the server is restarting' };
};
