'use strict';
require('../config/config');

var { mongoose } = require('../mongoose');
var { Event } = require('../models/event');
var utils = require('../utils/writer.js');
const activity = require('./ActivityService');

// status: switches changing; info: readings from the display; control: keypad and remote
// presses seen on the bus; action: signed-in accounts acting through the REST API;
// failed and unrecognized: frames the server could not use
const TYPES = ['status', 'info', 'control', 'action', 'failed', 'unrecognized'];
// the user filter's name for events the controller produced on its own
const CONTROLLER = 'controller';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

var badRequest = (message) => utils.respondWithCode(400, { code: 400, message: message });

var onOff = (value) => value ? 'on' : 'off';

var readingText = ({ name, value }) => {
    switch (name) {
    case 'pool temp':
    case 'spa temp':
    case 'ambient':
        return `${activity.label(name)} ${value}°F`;
    case 'salt':
        return `Salt ${value} ppm`;
    case 'heater1 mode':
        return `Heater ${value ? 'auto' : 'off'}`;
    default:
        return `${activity.label(name)} ${value}`;
    }
};

var summarize = (doc) => {
    const entries = doc.status || [];
    switch (doc.eventType) {
    case 'action':
        return doc.message;
    case 'status':
        return entries.map((entry) => `${activity.label(entry.name)} ${onOff(entry.value)}`).join(', ');
    case 'info':
        return entries.map(readingText).join(', ');
    case 'control':
        return `Pressed ${entries.map((entry) => activity.label(entry.name)).join(' + ')}`;
    case 'failed':
        return 'A frame failed its checksum';
    default:
        return 'An unrecognized frame';
    }
};

// a page ends at a timestamp; every id already returned at exactly that time is skipped on the
// next page, since events sharing a timestamp have no other order. When a run of equal
// timestamps spans pages, the ids carry over from the previous cursor.
var encodeCursor = (page, previous) => {
    const last = page[page.length - 1].timestamp;
    const sameTime = page.filter((doc) => doc.timestamp.getTime() === last.getTime()).map((doc) => String(doc._id));
    const carried = previous && previous.timestamp.getTime() === last.getTime() ? previous.seen.map(String) : [];
    return `${last.toISOString()}|${carried.concat(sameTime).join(',')}`;
};

var decodeCursor = (cursor) => {
    const [time, ids] = cursor.split('|');
    const timestamp = new Date(time);
    if (isNaN(timestamp.getTime())) {
        throw badRequest('cursor is not one this server returned');
    }
    const seen = (ids || '').split(',').filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));
    return { timestamp, seen };
};

/**
 * events newest first (or oldest first), a page at a time
 *
 * types List of event types (optional; all by default)
 * user String: an account name, or "controller" for events with no account (optional)
 * cursor String: the next value of the previous page (optional)
 * order String: desc (default) or asc
 * limit Integer (optional)
 * returns EventPage
 **/
exports.getEvents = async function(types, user, cursor, order, limit) {
    const wanted = types && types.length ? types : TYPES;
    const unknown = wanted.filter((type) => !TYPES.includes(type));
    if (unknown.length) {
        throw badRequest(`unknown event types: ${unknown.join(', ')}`);
    }
    const ascending = order === 'asc';
    const size = Math.min(Math.max(limit || DEFAULT_LIMIT, 1), MAX_LIMIT);

    const match = { eventType: { $in: wanted } };
    if (user === CONTROLLER) {
        match.user = { $exists: false };
    } else if (user) {
        match.user = user;
    }
    const previous = cursor ? decodeCursor(cursor) : undefined;
    if (previous) {
        match.timestamp = ascending ? { $gte: previous.timestamp } : { $lte: previous.timestamp };
        if (previous.seen.length) {
            match._id = { $nin: previous.seen };
        }
    }

    const docs = await Event.find(match)
        .sort({ timestamp: ascending ? 1 : -1 })
        .limit(size + 1)
        .select({ raw: 0 })
        .lean();
    const page = docs.slice(0, size);

    return {
        events: page.map((doc) => ({
            id: String(doc._id),
            timestamp: doc.timestamp,
            type: doc.eventType,
            user: doc.user,
            summary: summarize(doc),
            details: (doc.status || []).map((entry) => ({ name: entry.name, value: entry.value }))
        })),
        next: docs.length > size ? encodeCursor(page, previous) : null
    };
};

/**
 * every account that has done something recorded in the log
 *
 * returns List
 **/
exports.getEventUsers = async function() {
    const users = await Event.distinct('user', { user: { $exists: true } });
    return users.sort((a, b) => a.localeCompare(b));
};
