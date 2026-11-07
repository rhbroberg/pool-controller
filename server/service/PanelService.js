'use strict';

var utils = require('../utils/writer.js');
const activity = require('./ActivityService');
const log4js = require('log4js');
var logger = log4js.getLogger();

var displaySource = () => undefined;
var keyListener;

exports.registerDisplaySource = function(source) {
    displaySource = source;
};

exports.registerKeyListener = function(listener) {
    keyListener = listener;
};

/**
 * the most recent text the panel displayed
 *
 * returns PanelDisplay
 **/
exports.getPanelDisplay = function() {
    return new Promise(function(resolve, reject) {
        const display = displaySource();
        if (!display) {
            reject(utils.respondWithCode(404, { code: 404, message: 'the panel has not reported any display text yet' }));
            return;
        }
        resolve(display);
    });
};

/**
 * presses one panel key, as the wireless remote would
 *
 * key String
 * returns PanelKeyPress
 **/
exports.pressPanelKey = function(key, user) {
    return new Promise(function(resolve, reject) {
        const who = user && user.email ? user.email : 'unknown user';
        try {
            keyListener(key, who);
        } catch (e) {
            logger.warn(`REST ${who}: rejected panel key ${key}: ${e.message}`);
            reject(utils.respondWithCode(400, { code: 400, message: e.message }));
            return;
        }
        logger.info(`REST ${who}: pressed panel key ${key}`);
        activity.record(user, `Pressed the panel's ${key} key`, [{ name: key, value: 1 }]);
        resolve({ key: key, requestedAt: new Date().toISOString() });
    });
};
