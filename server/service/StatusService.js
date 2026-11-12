'use strict';
require('../config/config');

var { mongoose } = require('../mongoose'); // eslint-disable-line no-unused-vars
var { Event } = require('../models/event');
const { StatusEvent } = require('../protocol/events');
const { CHECK_SYSTEM_REASON } = require('../protocol/interpreter');
const log4js = require('log4js');
var logger = log4js.getLogger();

// must match the names server.js records for display updates
const infoNames = ['ambient', 'pool temp', 'spa temp', 'salt', 'heater1 mode'];

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
    return exports.switchesOf(new StatusEvent(raw), doc.timestamp);
};

/**
 * why the panel asks for the system to be checked: value counts the reasons, which message lists
 **/
exports.reasonReading = function(reasons, timestamp) {
    const reading = { name: CHECK_SYSTEM_REASON, category: 'info', value: reasons.length, timestamp: timestamp };
    if (reasons.length) {
        reading.message = reasons.join(', ');
    }
    return reading;
};

// the reasons stored since the check system switch last went on
var latestReasons = async (switches) => {
    const checkSystem = switches.find((reading) => reading.name === 'check system');
    if (!checkSystem) {
        return undefined;
    }
    if (!checkSystem.value) {
        return exports.reasonReading([], checkSystem.timestamp);
    }
    const wentOn = await Event.findOne({ eventType: 'status', status: { $elemMatch: { name: 'check system', value: 1 } } })
        .sort({ timestamp: -1 })
        .select({ timestamp: 1 })
        .lean();
    const docs = await Event.find({ eventType: 'info', 'status.name': CHECK_SYSTEM_REASON, timestamp: { $gte: wentOn ? wentOn.timestamp : new Date(0) } })
        .sort({ timestamp: 1 })
        .select({ timestamp: 1, message: 1 })
        .lean();
    const reasons = [...new Set(docs.map((doc) => doc.message).filter((message) => message))];
    return exports.reasonReading(reasons, docs.length ? docs[docs.length - 1].timestamp : checkSystem.timestamp);
};

/**
 * every named switch in a status frame, as GET /status reports them
 **/
exports.switchesOf = function(statusEvent, timestamp) {
    const switches = [];
    statusEvent.bitsToName((name, isOn) => {
        if (!name.startsWith('unknown')) {
            switches.push({
                name: name,
                category: 'status',
                value: isOn,
                timestamp: timestamp
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
    const reason = await latestReasons(switches);

    const readings = info.concat(reason).filter((reading) => reading).concat(switches);
    logger.debug('current status has', readings.length, 'readings');
    return readings;
};
