'use strict';

const fs = require('fs');
var { Setting } = require('../models/setting');
var utils = require('../utils/writer.js');
const { isValidTimeZone } = require('../utils/timezone');
const activity = require('./ActivityService');
const log4js = require('log4js');
var logger = log4js.getLogger();

const SETTINGS_ID = 'server';
const DEFAULT_RETENTION_DAYS = 365;
const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 3650;

var stored = { timeZone: null, rawRetentionDays: DEFAULT_RETENTION_DAYS };
var detected;
var listeners = [];

var readFile = (path) => {
    try {
        return fs.readFileSync(path, 'utf8').trim();
    } catch {
        return undefined;
    }
};

var readLink = (path) => {
    try {
        return fs.readlinkSync(path);
    } catch {
        return undefined;
    }
};

/**
 * the host's time zone: TZ, then /etc/timezone (Raspberry Pi OS), then the zone /etc/localtime
 * links to, then the runtime's own if it isn't UTC; a container sees the Pi's only when those
 * files are mounted into it
 **/
var detect = () => {
    const link = readLink('/etc/localtime');
    const candidates = [
        process.env.TZ,
        readFile('/etc/timezone'),
        link && (link.match(/zoneinfo\/(.+)$/) || [])[1],
        Intl.DateTimeFormat().resolvedOptions().timeZone
    ];
    const zone = candidates.find((candidate) => isValidTimeZone(candidate) && !/^(Etc\/)?(UTC|GMT)$/.test(candidate));
    return zone;
};

var validationError = (message) => utils.respondWithCode(400, { code: 400, message: message });

/**
 * reads the stored settings; run at startup and after a factory reset
 **/
exports.load = async function() {
    detected = detect();
    const doc = await Setting.findById(SETTINGS_ID).lean();
    stored = {
        timeZone: doc && doc.timeZone ? doc.timeZone : null,
        rawRetentionDays: doc && doc.rawRetentionDays ? doc.rawRetentionDays : DEFAULT_RETENTION_DAYS
    };
    logger.info(`time zone ${exports.timeZone()} (${exports.timeZoneSource()}); raw history kept ${stored.rawRetentionDays} days`);
};

/**
 * the zone calendar days follow: the configured one, otherwise the host's, otherwise UTC
 **/
exports.timeZone = function() {
    return stored.timeZone || detected || 'UTC';
};

exports.timeZoneSource = function() {
    if (stored.timeZone) {
        return 'configured';
    }
    return detected ? 'system' : 'default';
};

exports.rawRetentionDays = function() {
    return stored.rawRetentionDays;
};

/**
 * listener(changes) runs after a change, with changes.timeZone set when the zone changed
 **/
exports.onChange = function(listener) {
    listeners.push(listener);
};

/**
 * returns Settings
 **/
exports.getSettings = async function() {
    return {
        timeZone: exports.timeZone(),
        timeZoneSource: exports.timeZoneSource(),
        detectedTimeZone: detected || null,
        rawRetentionDays: stored.rawRetentionDays,
        minimumRetentionDays: MIN_RETENTION_DAYS,
        maximumRetentionDays: MAX_RETENTION_DAYS
    };
};

/**
 * changes the time zone (null goes back to the detected one) or how long raw events are kept
 *
 * returns Settings
 **/
exports.updateSettings = async function(changes, user) {
    const who = user && user.email ? user.email : 'unknown user';
    const update = {};
    if (Object.prototype.hasOwnProperty.call(changes || {}, 'timeZone')) {
        const zone = changes.timeZone === '' ? null : changes.timeZone;
        if (zone !== null && !isValidTimeZone(zone)) {
            throw validationError(`${zone} is not a time zone; use a name such as America/New_York`);
        }
        update.timeZone = zone;
    }
    if (Object.prototype.hasOwnProperty.call(changes || {}, 'rawRetentionDays')) {
        const days = changes.rawRetentionDays;
        if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
            throw validationError(`keep raw history for ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS} days`);
        }
        update.rawRetentionDays = days;
    }
    if (Object.keys(update).length === 0) {
        throw validationError('give a timeZone or rawRetentionDays to change');
    }

    const previousZone = exports.timeZone();
    await Setting.updateOne({ _id: SETTINGS_ID }, { $set: update }, { upsert: true });
    stored = Object.assign({}, stored, update);

    const notes = [];
    const changed = {};
    if ('timeZone' in update && exports.timeZone() !== previousZone) {
        changed.timeZone = exports.timeZone();
        notes.push(`time zone ${previousZone} -> ${changed.timeZone}`);
    }
    if ('rawRetentionDays' in update) {
        notes.push(`raw history kept ${update.rawRetentionDays} days`);
    }
    if (notes.length > 0) {
        logger.info(`REST ${who}: ${notes.join('; ')}`);
        activity.record(user, `Changed server settings: ${notes.join('; ')}`);
    }
    listeners.forEach((listener) => listener(changed));
    return exports.getSettings();
};
