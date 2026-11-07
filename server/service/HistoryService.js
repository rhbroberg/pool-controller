'use strict';
require('../config/config');

var { mongoose } = require('../mongoose'); // eslint-disable-line no-unused-vars
var { Event } = require('../models/event');
var utils = require('../utils/writer.js');
const log4js = require('log4js');
var logger = log4js.getLogger();

// readings parsed from the panel display; every other name is a status switch
const infoNames = ['pool temp', 'spa temp', 'ambient', 'salt', 'heater1 mode'];
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_POINTS = 2000;
const MAX_NAMES = 10;

var badRequest = (message) => utils.respondWithCode(400, { code: 400, message: message });

var parseDate = (text, fallback, label) => {
    if (typeof text === 'undefined' || text === '') {
        return fallback;
    }
    const date = new Date(text);
    if (isNaN(date.getTime())) {
        throw badRequest(`${label} is not a date: ${text}`);
    }
    return date;
};

var valueOf = (doc, name) => {
    const entry = doc.status.find((reading) => reading.name === name);
    return { t: doc.timestamp, v: entry ? entry.value : null };
};

// readings are stored only when they change, so `before` carries the value in effect when the
// window opens; above maxPoints, readings are thinned to the last one in each of maxPoints
// equal-count buckets
var seriesFor = async (name, from, to, maxPoints) => {
    const eventType = infoNames.includes(name) ? 'info' : 'status';
    const match = { eventType: eventType, 'status.name': name, timestamp: { $gte: from, $lt: to } };

    const [before, count] = await Promise.all([
        Event.findOne({ eventType: eventType, 'status.name': name, timestamp: { $lt: from } })
            .sort({ timestamp: -1 })
            .select({ timestamp: 1, status: 1 })
            .lean(),
        Event.countDocuments(match)
    ]);

    let points;
    if (count <= maxPoints) {
        const docs = await Event.find(match).sort({ timestamp: 1 }).select({ timestamp: 1, status: 1 }).lean();
        points = docs.map((doc) => valueOf(doc, name));
    } else {
        const buckets = await Event.aggregate([
            { $match: match },
            { $sort: { timestamp: 1 } },
            { $unwind: '$status' },
            { $match: { 'status.name': name } },
            { $bucketAuto: { groupBy: '$timestamp', buckets: maxPoints, output: { t: { $last: '$timestamp' }, v: { $last: '$status.value' } } } }
        ]).allowDiskUse(true);
        points = buckets.map((bucket) => ({ t: bucket.t, v: bucket.v }));
    }

    return {
        name: name,
        before: before ? valueOf(before, name) : null,
        points: points,
        downsampled: count > maxPoints
    };
};

/**
 * readings for each name between from (inclusive) and to (exclusive); defaults to the last 24 hours
 *
 * names List
 * from String (optional)
 * to String (optional)
 * maxPoints Integer (optional)
 * returns History
 **/
exports.getHistory = async function(names, fromText, toText, maxPoints) {
    const requested = (names || []).map((name) => name.trim()).filter((name) => name.length > 0);
    if (requested.length === 0 || requested.length > MAX_NAMES) {
        throw badRequest(`ask for between 1 and ${MAX_NAMES} names`);
    }
    const to = parseDate(toText, new Date(), 'to');
    const from = parseDate(fromText, new Date(to.getTime() - DEFAULT_WINDOW_MS), 'from');
    if (from >= to) {
        throw badRequest('from must be earlier than to');
    }
    const limit = Math.min(Math.max(maxPoints || DEFAULT_MAX_POINTS, 10), 10000);

    const started = Date.now();
    const [series, oldest] = await Promise.all([
        Promise.all(requested.map((name) => seriesFor(name, from, to, limit))),
        Event.findOne({ eventType: { $in: ['info', 'status'] } }).sort({ timestamp: 1 }).select({ timestamp: 1 }).lean()
    ]);
    logger.debug(`history for ${requested.join(', ')} from ${from.toISOString()} to ${to.toISOString()} in ${Date.now() - started}ms`);

    return {
        from: from,
        to: to,
        earliest: oldest ? oldest.timestamp : null,
        series: series
    };
};
