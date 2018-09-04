'use strict';
require('../config/config');

var { mongoose } = require('../mongoose'); // eslint-disable-line no-unused-vars
var { ObjectID } = require('mongodb'); // eslint-disable-line no-unused-vars
var { Event } = require('../models/event'); // eslint-disable-line no-unused-vars
const log4js = require('log4js'); // eslint-disable-line no-unused-vars
var logger = log4js.getLogger(); // eslint-disable-line no-unused-vars


/**
 * returns all filtration devices
 *
 * returns List
 **/
exports.getFiltrationDevices = function() {
    return new Promise(function(resolve, reject) { // eslint-disable-line no-unused-vars
        var examples = {};
        examples['application/json'] = ['pool', 'spa'];
        if (Object.keys(examples).length > 0) {
            resolve(examples[Object.keys(examples)[0]]);
        } else {
            resolve();
        }
    });
};


/**
 *
 * pumpId String 
 * returns ApiResponse
 **/
exports.getFiltrationState = function(pumpId) { // eslint-disable-line no-unused-vars
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


/**
 *
 * pumpId String 
 * state String 
 * returns ApiResponse
 **/
exports.setFiltrationState = function(pumpId, state) { // eslint-disable-line no-unused-vars
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
