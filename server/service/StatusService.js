'use strict';
require('../config/config');

var { mongoose } = require('../mongoose'); // eslint-disable-line no-unused-vars
var { Event } = require('../models/event');
const { StatusEvent } = require('../protocol/events');
const log4js = require('log4js');
var logger = log4js.getLogger();

// must match the names server.js records for display updates
const infoNames = ['ambient', 'pool temp', 'salt'];

var latestInfo = async (name) => {
    const doc = await Event.findOne({ eventType: 'info', status: { $elemMatch: { name: name } } })
        .sort({ timestamp: -1 })
        .lean();
    if (!doc) {
        return undefined;
    }
    const reading = doc.status.find((entry) => entry.name === name);
    return {
        name: name,
        category: 'info',
        value: reading.value,
        timestamp: doc.timestamp
    };
};

var latestSwitches = async () => {
    const doc = await Event.findOne({ eventType: 'status' })
        .sort({ timestamp: -1 })
        .lean();
    if (!doc || !doc.raw) {
        return [];
    }

    // each status frame carries every switch bit, not only the ones that changed
    const raw = Buffer.from(doc.raw.buffer ? doc.raw.buffer : doc.raw);
    const switches = [];
    new StatusEvent(raw).bitsToName((name, isOn) => {
        if (!name.startsWith('unknown')) {
            switches.push({
                name: name,
                category: 'status',
                value: isOn,
                timestamp: doc.timestamp
            });
        }
    });
    return switches.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
};

/**
 * returns the most recent recorded value of every status and info reading
 *
 * returns List
 **/
exports.getCurrentStatus = async function() {
    const [info, switches] = await Promise.all([
        Promise.all(infoNames.map(latestInfo)),
        latestSwitches()
    ]);

    const readings = info.filter((reading) => reading).concat(switches);
    logger.debug('current status has', readings.length, 'readings');
    return readings;
};
