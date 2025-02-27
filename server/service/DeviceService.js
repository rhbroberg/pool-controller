'use strict';
require('../config/config');
const _ = require('lodash'); // eslint-disable-line no-unused-vars

var { mongoose } = require('../mongoose'); // eslint-disable-line no-unused-vars
var { ObjectID } = require('mongodb'); // eslint-disable-line no-unused-vars
var { Event } = require('../models/event');
const log4js = require('log4js');
var logger = log4js.getLogger();

/**
 *
 * deviceId String 
 * no response value expected for this operation
 **/
exports.getDeviceState = function(deviceId) {
    return new Promise(async function(resolve, reject) { // eslint-disable-line no-unused-vars
        var examples = {};
        var current;

        await Event.findOne({ 'eventType': 'status', 'status': { $elemMatch: { 'name': deviceId } } }).sort({ timestamp: -1 }).exec((err, presentValue) => {
            current = presentValue;
        });

        const deviceCurrent = current.status.find((mystatus) => { return mystatus.name === deviceId; });
        const deviceCurrentValue = deviceCurrent ? deviceCurrent.value : 0;

        await Event.findOne({ 'eventType': 'status', 'status': { $elemMatch: { 'name': deviceId, 'value': deviceCurrentValue ? 0 : 1 } } }).sort({ timestamp: -1 }).exec((err, lastChanged) => {
            if (lastChanged) {
                const devicePrevious = lastChanged.status.find((mystatus) => { return mystatus.name === deviceId; });
                examples['application/json'] = {
                    'id': devicePrevious._id,
                    'previousUpdate': lastChanged.timestamp,
                    'timestamp': current.timestamp,
                    'name': devicePrevious.name,
                    'value': deviceCurrentValue
                };
            } else {
                if (deviceCurrent) {
                    examples['application/json'] = {
                        'id': deviceCurrent._id,
                        'timestamp': current.timestamp,
                        'name': deviceCurrent.name,
                        'value': deviceCurrentValue
                    };
                } else {
                    // should return not found
                }

            }
        });

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

        await Event.findOne({ 'eventType': 'status' }).sort({ timestamp: -1 }).exec((err, doc) => {
            if (doc) {
                logger.trace('found most recent status', doc);
                doc.status.forEach(function(indicator) {
                    indicators.push(indicator.name);
                });
            }
        });

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
exports.setDeviceState = function(deviceId, state) { // eslint-disable-line no-unused-vars
    return new Promise(function(resolve, reject) { // eslint-disable-line no-unused-vars
        // need top-level catch here for exceptions which will otherwise be silently ignored
        var examples = {};

        logger.info(`setting ${deviceId} to ${state}`);
        const currentDeviceState = controlCB(deviceId);

        examples['application/json'] = {
            'level': 0,
            'lastUpdate': new Date().getTime(),
            'name': deviceId,
            'id': 'id',
            'state': currentDeviceState
        };

        if (Object.keys(examples).length > 0) {
            resolve(examples[Object.keys(examples)[0]]);
        } else {
            resolve();
        }
    });
};
