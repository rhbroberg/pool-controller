'use strict';

const fs = require('fs');
var { Setting } = require('../models/setting');
var utils = require('../utils/writer.js');
const { isValidTimeZone } = require('../utils/timezone');
const activity = require('./ActivityService');
const weatherProviders = require('./WeatherProviders');
const log4js = require('log4js');
var logger = log4js.getLogger();

const SETTINGS_ID = 'server';
const DEFAULT_RETENTION_DAYS = 365;
const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 3650;
const ESTIMATE_DISPLAYS = ['remaining', 'readyAt'];
const DEFAULT_ESTIMATE_DISPLAY = 'remaining';
// a heater and heat pump together on a typical spa; an admin sets this one's own
const DEFAULT_SPA_HEATING_RATE = 20;
const MIN_SPA_HEATING_RATE = 1;
const MAX_SPA_HEATING_RATE = 120;
const DEFAULT_PREHEAT_MARGIN_MINUTES = 15;
const MAX_PREHEAT_MARGIN_MINUTES = 240;

// five digits, optionally with the ZIP+4 extension, which the lookup doesn't need
const ZIP_CODE = /^(\d{5})(?:-\d{4})?$/;

var stored = {
    timeZone: null,
    rawRetentionDays: DEFAULT_RETENTION_DAYS,
    location: null,
    heatingEstimateDisplay: DEFAULT_ESTIMATE_DISPLAY,
    spaHeatingRate: DEFAULT_SPA_HEATING_RATE,
    preheatMarginMinutes: DEFAULT_PREHEAT_MARGIN_MINUTES
};
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
        rawRetentionDays: doc && doc.rawRetentionDays ? doc.rawRetentionDays : DEFAULT_RETENTION_DAYS,
        location: doc && doc.location && doc.location.zipCode ? doc.location : null,
        heatingEstimateDisplay: doc && ESTIMATE_DISPLAYS.includes(doc.heatingEstimateDisplay) ? doc.heatingEstimateDisplay : DEFAULT_ESTIMATE_DISPLAY,
        spaHeatingRate: doc && typeof doc.spaHeatingRate === 'number' ? doc.spaHeatingRate : DEFAULT_SPA_HEATING_RATE,
        preheatMarginMinutes: doc && Number.isInteger(doc.preheatMarginMinutes) ? doc.preheatMarginMinutes : DEFAULT_PREHEAT_MARGIN_MINUTES
    };
    const where = stored.location ? `weather for ${stored.location.placeName} (${stored.location.zipCode})` : 'no zip code for weather';
    logger.info(`time zone ${exports.timeZone()} (${exports.timeZoneSource()}); raw history kept ${stored.rawRetentionDays} days; ${where}`);
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

/** 'remaining' (minutes until ready) or 'readyAt' (the time it will be ready) */
exports.heatingEstimateDisplay = function() {
    return stored.heatingEstimateDisplay;
};

/** °F per hour the spa warms with both heat sources, for timing a preheat without a spa model */
exports.spaHeatingRate = function() {
    return stored.spaHeatingRate;
};

/** minutes added to a scheduled preheat's lead time */
exports.preheatMarginMinutes = function() {
    return stored.preheatMarginMinutes;
};

/**
 * where the pool is ({ zipCode, countryCode, latitude, longitude, placeName }), or null
 **/
exports.location = function() {
    return stored.location;
};

var publicLocation = (location) => location ? {
    zipCode: location.zipCode,
    countryCode: location.countryCode,
    placeName: location.placeName,
    latitude: location.latitude,
    longitude: location.longitude
} : null;

/**
 * the place for a zip code: null clears it, an unknown code or one that isn't five digits is a
 * 400, and a lookup service that can't be reached is a 502
 **/
var locate = async (zipCode) => {
    const text = zipCode === null || typeof zipCode === 'undefined' ? '' : String(zipCode).trim();
    if (text === '') {
        return null;
    }
    const match = ZIP_CODE.exec(text);
    if (!match) {
        throw validationError(`${text} isn’t a zip code; use five digits such as 32801`);
    }
    let place;
    try {
        place = await weatherProviders.geocode(match[1]);
    } catch (e) {
        throw utils.respondWithCode(502, { code: 502, message: `couldn’t look up zip code ${match[1]}: ${e.message}` });
    }
    if (!place) {
        throw validationError(`no place has the zip code ${match[1]}`);
    }
    return Object.assign(place, { updatedAt: new Date() });
};

/**
 * listener(changes) runs after a change, with changes.timeZone set when the zone changed and
 * changes.location when the zip code did
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
        maximumRetentionDays: MAX_RETENTION_DAYS,
        location: publicLocation(stored.location),
        heatingEstimateDisplay: stored.heatingEstimateDisplay,
        spaHeatingRate: stored.spaHeatingRate,
        preheatMarginMinutes: stored.preheatMarginMinutes
    };
};

/**
 * changes the time zone (null goes back to the detected one), how long raw events are kept, or
 * the zip code weather is fetched for (null or empty stops fetching)
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
    if (Object.prototype.hasOwnProperty.call(changes || {}, 'zipCode')) {
        update.location = await locate(changes.zipCode);
    }
    if (Object.prototype.hasOwnProperty.call(changes || {}, 'heatingEstimateDisplay')) {
        if (!ESTIMATE_DISPLAYS.includes(changes.heatingEstimateDisplay)) {
            throw validationError(`show the heating estimate as ${ESTIMATE_DISPLAYS.join(' or ')}`);
        }
        update.heatingEstimateDisplay = changes.heatingEstimateDisplay;
    }
    if (Object.prototype.hasOwnProperty.call(changes || {}, 'spaHeatingRate')) {
        const rate = changes.spaHeatingRate;
        if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < MIN_SPA_HEATING_RATE || rate > MAX_SPA_HEATING_RATE) {
            throw validationError(`the spa heating rate must be ${MIN_SPA_HEATING_RATE} to ${MAX_SPA_HEATING_RATE}°F per hour`);
        }
        update.spaHeatingRate = rate;
    }
    if (Object.prototype.hasOwnProperty.call(changes || {}, 'preheatMarginMinutes')) {
        const minutes = changes.preheatMarginMinutes;
        if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_PREHEAT_MARGIN_MINUTES) {
            throw validationError(`the preheat margin must be 0 to ${MAX_PREHEAT_MARGIN_MINUTES} minutes`);
        }
        update.preheatMarginMinutes = minutes;
    }
    if (Object.keys(update).length === 0) {
        throw validationError('give a timeZone, rawRetentionDays, zipCode, heatingEstimateDisplay, spaHeatingRate or preheatMarginMinutes to change');
    }

    const previousZone = exports.timeZone();
    const previousZip = stored.location ? stored.location.zipCode : null;
    const previousDisplay = stored.heatingEstimateDisplay;
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
    if ('location' in update && (update.location ? update.location.zipCode : null) !== previousZip) {
        changed.location = publicLocation(update.location);
        notes.push(update.location ? `weather for ${update.location.placeName} (${update.location.zipCode})` : 'no zip code for weather');
    }
    if ('heatingEstimateDisplay' in update && update.heatingEstimateDisplay !== previousDisplay) {
        changed.heatingEstimateDisplay = update.heatingEstimateDisplay;
        notes.push(update.heatingEstimateDisplay === 'readyAt' ? 'heating estimates show the time it will be ready' : 'heating estimates show the minutes left');
    }
    if ('spaHeatingRate' in update) {
        changed.spaHeatingRate = update.spaHeatingRate;
        notes.push(`spa heats ${update.spaHeatingRate}°F per hour for preheat timing`);
    }
    if ('preheatMarginMinutes' in update) {
        changed.preheatMarginMinutes = update.preheatMarginMinutes;
        notes.push(`preheats start ${update.preheatMarginMinutes} minutes early`);
    }
    if (notes.length > 0) {
        logger.info(`REST ${who}: ${notes.join('; ')}`);
        activity.record(user, `Changed server settings: ${notes.join('; ')}`);
    }
    listeners.forEach((listener) => listener(changed));
    return exports.getSettings();
};
