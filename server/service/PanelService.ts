'use strict';

import { errorMessageOf } from '../types/domain';

import log4js from 'log4js';
import type { AuthUser, PanelKey } from '../types/domain';
import { respondWithCode } from '../utils/writer';
import * as activity from './ActivityService';

const logger = log4js.getLogger();

var displaySource: () => any = () => undefined;
var keyListener: ((key: string, who: string) => void) | undefined;

export function registerDisplaySource(source: () => any) {
    displaySource = source;
}

export function registerKeyListener(listener: (key: string, who: string) => void) {
    keyListener = listener;
}

/**
 * the most recent text the panel displayed
 *
 * returns PanelDisplay
 **/
export function getPanelDisplay() {
    return new Promise(function(resolve, reject) {
        const display = displaySource();
        if (!display) {
            reject(respondWithCode(404, { code: 404, message: 'the panel has not reported any display text yet' }));
            return;
        }
        resolve(display);
    });
}

/**
 * presses one panel key, as the wireless remote would
 *
 * key String
 * returns PanelKeyPress
 **/
export function pressPanelKey(key: PanelKey | string, user?: AuthUser | null) {
    return new Promise(function(resolve, reject) {
        const who = user && user.email ? user.email : 'unknown user';
        try {
            keyListener!(key, who);
        } catch (e: any) {
            logger.warn(`REST ${who}: rejected panel key ${key}: ${errorMessageOf(e)}`);
            reject(respondWithCode(400, { code: 400, message: errorMessageOf(e) }));
            return;
        }
        logger.info(`REST ${who}: pressed panel key ${key}`);
        activity.record(user, `Pressed the panel's ${key} key`, [{ name: key, value: 1 }]);
        resolve({ key: key, requestedAt: new Date().toISOString() });
    });
}
