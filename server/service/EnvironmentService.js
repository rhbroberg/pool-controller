'use strict';
require('../config/config');

var { mongoose } = require('../mongoose'); // eslint-disable-line no-unused-vars
var { ObjectID } = require('mongodb'); // eslint-disable-line no-unused-vars
var { Event } = require('../models/event');
const log4js = require('log4js');
var logger = log4js.getLogger();

// lines up with strings in db storage
const tempNames = {
    'pool': 'pool temp',
    'spa': 'spa temp'
}

/**
 * gets the state of the heater
 *
 * poolId String 
 * returns HeaterState
 **/
exports.getHeaterState = function(poolId) { // eslint-disable-line no-unused-vars
    return new Promise(async function(resolve, reject) { // eslint-disable-line no-unused-vars
        var examples = {};

        await Event.findOne({ 'status': { $elemMatch: { 'name': 'heater1' } } }).sort({ timestamp: -1 }).exec((err, doc) => {
            if (doc) {
                examples['application/json'] = {
                    'id': doc.status[0]._id,
                    'units': 'fahrenheit',
                    'timestamp': doc.timestamp,
                    'state': doc.status[0].value ? 'on' : 'off',
                    'setpoint': '42'
                };
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
 *
 * poolId String 
 * returns TemperatueZoneStatus
 **/
exports.getPoolTemperature = function(poolId) { // eslint-disable-line no-unused-vars
    return new Promise(async function(resolve, reject) { // eslint-disable-line no-unused-vars
        var statuses = [];
        var examples = {};

        await getMostRecentInfo(tempNames[poolId], statuses);

        examples['application/json'] = {
            'zoneStatus': statuses
        };

        if (Object.keys(examples).length > 0) {
            resolve(examples[Object.keys(examples)[0]]);
        } else {
            resolve();
        }
    });
};


/**
 * turns the heater on or off
 *
 * poolId String 
 * state String 
 * returns ApiResponse
 **/
exports.setHeaterState = function(poolId, state) { // eslint-disable-line no-unused-vars
    return new Promise(function(resolve, reject) { // eslint-disable-line no-unused-vars
        var examples = {};
        examples['application/json'] = {
            'code': 0,
            'message': 'everything is ok'
        };
        if (Object.keys(examples).length > 0) {
            resolve(examples[Object.keys(examples)[0]]);
        } else {
            resolve();
        }
    });
};

async function getMostRecentInfo(name, statuses) {
    await Event.findOne({ 'status': { $elemMatch: { 'name': name } } }).sort({ timestamp: -1 }).exec((err, doc) => {
        logger.debug('found newest env for ', name, doc, err);
        if (doc) {
            statuses.push({
                'name': doc.status[0].name,
                'id': doc.status[0]._id,
                'units': 'fahrenheit',
                'value': doc.status[0].value,
                'timestamp': doc.timestamp
            });
        }
    });
}

/**
 *
 * returns TemperatureSummary
 **/
exports.temperatureSummary = function() {
    return new Promise(async function(resolve, reject) { // eslint-disable-line no-unused-vars
        var examples = {};
        var statuses = [];

        await getMostRecentInfo('ambient', statuses);
        await getMostRecentInfo('pool temp', statuses);
        await getMostRecentInfo('spa temp', statuses);

        examples['application/json'] = {
            'zoneStatus': statuses
        };

        if (Object.keys(examples).length > 0) {
            resolve(examples[Object.keys(examples)[0]]);
        } else {
            resolve();
        }
    });
};
