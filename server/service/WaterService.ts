'use strict';

import log4js from 'log4js';
import type { AuthUser } from '../types/domain';

const utils = require('../utils/writer');
const activity = require('./ActivityService');
const logger = log4js.getLogger();

var modeListener: ((mode: string, who: string) => string) | undefined;

exports.registerModeListener = function(listener: (mode: string, who: string) => string) {
    modeListener = listener;
};

var title = (mode: string) => mode.charAt(0).toUpperCase() + mode.slice(1);

/**
 * sets the water flow to pool, spa or spillover; the controller steps through those modes in
 * that order, so the server presses the spillover key until the requested mode is reached
 *
 * mode String
 * returns WaterMode
 **/
exports.setWaterMode = function(mode: string, user?: AuthUser | null) {
    return new Promise(function(resolve, reject) {
        const who = user && user.email ? user.email : 'unknown user';
        let previous: string;
        try {
            previous = modeListener!(mode, who);
        } catch (e: any) {
            logger.warn(`REST ${who}: rejected water flow ${mode}: ${e.message}`);
            reject(utils.respondWithCode(400, { code: 400, message: e.message }));
            return;
        }

        if (previous === mode) {
            logger.info(`REST ${who}: water flow already ${mode}, nothing sent`);
            activity.record(user, `Asked for ${title(mode)} water flow; it already was`);
        } else {
            logger.info(`REST ${who}: water flow ${previous} -> ${mode}`);
            activity.record(user, `Switched water flow from ${title(previous)} to ${title(mode)}`);
        }
        // the change shows up on later status frames; GET /status reports the pool, spa and
        // spillover switches
        resolve({ mode: mode, previousMode: previous, requestedAt: new Date().toISOString() });
    });
};
