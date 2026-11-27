'use strict';
require('../config/config');
const _ = require('lodash'); // eslint-disable-line no-unused-vars

var { mongoose } = require('../mongoose'); // eslint-disable-line no-unused-vars
var { ObjectID } = require('mongodb'); // eslint-disable-line no-unused-vars
var { Event } = require('../models/event');
var utils = require('../utils/writer');
const { panelLabels } = require('../protocol/events');
const activity = require('./ActivityService');
const log4js = require('log4js');
var logger = log4js.getLogger();

// letters and digits only, without a plural s, so "Yard Lights", "yard-lights" and "yardlight" match
var normalized = (name: any) => name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');

// the panel's names for generic outputs are accepted in place of aux3, aux5, ...
const deviceAliases: Record<string, string> = Object.keys(panelLabels).reduce((aliases: Record<string, string>, device) => {
    aliases[normalized(panelLabels[device])] = device;
    return aliases;
}, {});

var resolveDevice = (deviceId: any) => deviceAliases[normalized(deviceId)] || deviceId;

var describeDevice = (requested: any, device: any) => requested === device ? device : `${requested} (${device})`;

/**
 *
 * deviceId String 
 * no response value expected for this operation
 **/
export async function getDeviceState(requestedId: any) {
    const deviceId = resolveDevice(requestedId);
    var examples: any = {};
    var current;

    current = await Event.findOne({ 'eventType': 'status', 'status': { $elemMatch: { 'name': deviceId } } }).sort({ timestamp: -1 });
    if (!current) {
        return;
    }

    const deviceCurrent = current.status.find((mystatus: any) => { return mystatus.name === deviceId; });
    const deviceCurrentValue = deviceCurrent ? deviceCurrent.value : 0;

    const lastChanged = await Event.findOne({ 'eventType': 'status', 'status': { $elemMatch: { 'name': deviceId, 'value': deviceCurrentValue ? 0 : 1 } } }).sort({ timestamp: -1 });
    if (lastChanged) {
        const devicePrevious = lastChanged.status.find((mystatus: any) => { return mystatus.name === deviceId; });
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
        return examples[Object.keys(examples)[0]];
    }
};


/**
 * returns all configured devices
 *
 * skip Integer number of records to skip (optional)
 * limit Integer max number of records to return (optional)
 * returns List
 **/
export async function getDevices(skip: any, limit: any) { // eslint-disable-line no-unused-vars
    var examples: any = {};
    var indicators = [] as any[];

    const doc = await Event.findOne({ 'eventType': 'status' }).sort({ timestamp: -1 });
    if (doc) {
        logger.trace('found most recent status', doc);
        doc.status.forEach(function(indicator: any) {
            indicators.push(indicator.name);
        });
    }

    examples['application/json'] = indicators;
    if (Object.keys(examples).length > 0) {
        return examples[Object.keys(examples)[0]];
    }
};


/**
 *
 * deviceId String 
 * returns DeviceRegistrationInfo
 **/
export function registerDevice(deviceId: any) { // eslint-disable-line no-unused-vars
    return new Promise<any>(function(resolve, reject) { // eslint-disable-line no-unused-vars
        var examples: any = {};
        examples['application/json'] = {
            'id': '0729a580-2240-11e6-9eb5-0002a5d5c51b',
            'uri': 'http://10.0.0.220:3000'
        };
        if (Object.keys(examples).length > 0) {
            resolve(examples[Object.keys(examples)[0]]);
        } else {
            resolve(undefined);
        }
    });
};

var controlCB: any;

export function registerControlListener(cb: any) {
    controlCB = cb;
};

/**
 *
 * deviceId String 
 * state String 
 * returns DeviceState
 **/
var onOff = (isOn: any) => isOn ? 'on' : 'off';

export function setDeviceState(requestedId: any, state: any, user: any) {
    return new Promise<any>(function(resolve, reject) {
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

        const details = [{ name: deviceId, value: desiredOn ? 1 : 0 }];
        if (wasOn === desiredOn) {
            logger.info(`REST ${who}: ${label} already ${onOff(wasOn)}, nothing sent`);
            activity.record(user, `Asked to turn ${activity.label(deviceId)} ${onOff(desiredOn)}; it already was`, details);
        } else {
            logger.info(`REST ${who}: ${label} ${onOff(wasOn)} -> ${onOff(desiredOn)}`);
            activity.record(user, `Turned ${activity.label(deviceId)} ${onOff(desiredOn)}`, details);
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
