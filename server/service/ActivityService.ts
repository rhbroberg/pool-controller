'use strict';

import log4js from 'log4js';
import { mongoose } from '../mongoose';
import { Event } from '../models/event';
import { panelLabels } from '../protocol/events';
import type { AuthUser } from '../types/domain';

const logger = log4js.getLogger();

const fixedLabels = {
    heater1: 'Heater',
    superchlorinate: 'Super Chlorinate',
    'check system': 'Check System',
    'check system reason': 'Check System reason',
    'pool temp': 'Pool',
    'spa temp': 'Spa',
    ambient: 'Air',
    salt: 'Salt',
    'heater1 mode': 'Heater mode'
};

/**
 * the name a person would use for a switch, button or reading
 **/
exports.label = function(name: string): string {
    return (panelLabels as Record<string, string>)[name] || (fixedLabels as Record<string, string>)[name] || name.charAt(0).toUpperCase() + name.slice(1);
};

/**
 * stores something a signed-in account did, for the event log; failures are logged, not thrown,
 * so a request never fails because its record couldn't be written
 *
 * user      the account (or its name)
 * message   what happened, in a sentence
 * details   optional [{ name, value }] such as the device and requested state
 **/
exports.record = async function(user: AuthUser | string | null | undefined, message: string, details?: { name: string; value: unknown }[]) {
    const name = user && typeof user === 'object' && user.email ? user.email : user;
    try {
        await Event.create({
            _id: new mongoose.Types.ObjectId(),
            eventType: 'action',
            source: 'rest',
            timestamp: new Date(),
            user: name || 'unknown user',
            message: message,
            status: details || []
        });
    } catch (e) {
        logger.error(`could not record "${message}" for ${name}: ${e}`);
    }
};
