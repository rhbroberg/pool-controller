'use strict';

var { mongoose } = require('../mongoose');
var { Event } = require('../models/event');
const { panelLabels } = require('../protocol/events');
const log4js = require('log4js');
var logger = log4js.getLogger();

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
exports.label = function(name) {
    return panelLabels[name] || fixedLabels[name] || name.charAt(0).toUpperCase() + name.slice(1);
};

/**
 * stores something a signed-in account did, for the event log; failures are logged, not thrown,
 * so a request never fails because its record couldn't be written
 *
 * user      the account (or its name)
 * message   what happened, in a sentence
 * details   optional [{ name, value }] such as the device and requested state
 **/
exports.record = async function(user, message, details) {
    const name = user && user.email ? user.email : user;
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
