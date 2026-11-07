'use strict';
require('../config/config');
const _ = require('lodash'); // eslint-disable-line no-unused-vars

var { mongoose } = require('../mongoose'); // eslint-disable-line no-unused-vars
var { ObjectID } = require('mongodb'); // eslint-disable-line no-unused-vars
var { Event } = require('../models/event');
var utils = require('../utils/writer.js');
const log4js = require('log4js');
var logger = log4js.getLogger();

// names this installation's panel shows for generic outputs; keys are lowercase letters and
// digits only, so "spa filter", "spa-filter" and "spaFilter" all match
const deviceAliases = {
    spafilter: 'aux14'
};

var resolveDevice = (deviceId) => deviceAliases[deviceId.toLowerCase().replace(/[^a-z0-9]/g, '')] || deviceId;

var describeDevice = (requested, device) => requested === device ? device : `${requested} (${device})`;

/**
 *
 * deviceId String 
 * no response value expected for this operation
 **/
exports.getDeviceState = function(requestedId) {
    const deviceId = resolveDevice(requestedId);
    return new Promise(async function(resolve, reject) { // eslint-disable-line no-unused-vars
        var examples = {};
        var current;

        current = await Event.findOne({ 'eventType': 'status', 'status': { $elemMatch: { 'name': deviceId } } }).sort({ timestamp: -1 });
        if (!current) {
            resolve();
            return;
        }

        const deviceCurrent = current.status.find((mystatus) => { return mystatus.name === deviceId; });
        const deviceCurrentValue = deviceCurrent ? deviceCurrent.value : 0;

        const lastChanged = await Event.findOne({ 'eventType': 'status', 'status': { $elemMatch: { 'name': deviceId, 'value': deviceCurrentValue ? 0 : 1 } } }).sort({ timestamp: -1 });
        if (lastChanged) {
            const devicePrevious = lastChanged.status.find((mystatus) => { return mystatus.name === deviceId; });
            examples['application/json'] = {
                'id': devicePrevious._id,
                'previousUpdate': lastChanged.timestamp,
                'timestamp': current.timestamp,
                'name': devicePrevious.name,
                'value': deviceCurrentValue
            };
        } else if (deviceCurrent) {
            examples['application/json'] = {
                'id': deviceCurrent._id,
                'timestamp': current.timestamp,
                'name': deviceCurrent.name,
                'value': deviceCurrentValue
            };
        }

        if (Object.keys(examples).length > 0) {
            resolve(examples[Object.keys(examples)[0]]);
        } else {
            resolve();
        }
    });
};


/**
 * returns all configured devices
 *
 * skip Integer number of records to skip (optional)
 * limit Integer max number of records to return (optional)
 * returns List
 **/
exports.getDevices = function(skip, limit) { // eslint-disable-line no-unused-vars
    return new Promise(async function(resolve, reject) { // eslint-disable-line no-unused-vars
        var examples = {};
        var indicators = [];

        const doc = await Event.findOne({ 'eventType': 'status' }).sort({ timestamp: -1 });
        if (doc) {
            logger.trace('found most recent status', doc);
            doc.status.forEach(function(indicator) {
                indicators.push(indicator.name);
            });
        }

        examples['application/json'] = indicators;
        if (Object.keys(examples).length > 0) {
            resolve(examples[Object.keys(examples)[0]]);
        } else {
            resolve();
        }
    });
};


/**
 *
 * deviceId String 
 * returns DeviceRegistrationInfo
 **/
exports.registerDevice = function(deviceId) { // eslint-disable-line no-unused-vars
    return new Promise(function(resolve, reject) { // eslint-disable-line no-unused-vars
        var examples = {};
        examples['application/json'] = {
            'id': '0729a580-2240-11e6-9eb5-0002a5d5c51b',
            'uri': 'http://10.0.0.220:8080'
        };
        if (Object.keys(examples).length > 0) {
            resolve(examples[Object.keys(examples)[0]]);
        } else {
            resolve();
        }
    });
};

var controlCB;

exports.registerControlListener = function(cb) {
    controlCB = cb;
};

/**
 *
 * deviceId String 
 * state String 
 * returns DeviceState
 **/
var onOff = (isOn) => isOn ? 'on' : 'off';

exports.setDeviceState = function(requestedId, state, user) {
    return new Promise(function(resolve, reject) {
        const deviceId = resolveDevice(requestedId);
        const label = describeDevice(requestedId, deviceId);
        const desiredOn = state === 'true';
        const who = user && user.email ? user.email : 'unknown user';

        let wasOn;
        try {
            wasOn = controlCB(deviceId, desiredOn, who);
        } catch (e) {
            logger.warn(`REST ${who}: rejected ${label} ${onOff(desiredOn)}: ${e.message}`);
            reject(utils.respondWithCode(400, { code: 400, message: e.message }));
            return;
        }

        if (wasOn === desiredOn) {
            logger.info(`REST ${who}: ${label} already ${onOff(wasOn)}, nothing sent`);
        } else {
            logger.info(`REST ${who}: ${label} ${onOff(wasOn)} -> ${onOff(desiredOn)}`);
        }

        // the controller confirms the change on a later status frame; GET /status reports it
        resolve({
            'id': deviceId,
            'name': deviceId,
            'value': String(desiredOn),
            'previousValue': String(wasOn),
            'lastUpdate': new Date().toISOString()
        });
    });
};
