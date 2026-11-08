'use strict';
var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var EventSchema = new Schema({

    _id: mongoose.Schema.Types.ObjectId,
    raw: Buffer,
    timestamp: {
        type: Date,
        default: Date.now
    },
    eventType: String,
    source: String,
    command: [{
        name: String,
        onOff: Boolean
    }],
    status: [{
        name: String,
        value: Number
    }],
    // set on 'action' events: the signed-in account that acted, and what it did
    user: String,
    message: String
});

// the server syncs these at startup, dropping any index that isn't listed here
// one named reading over a time range, and its newest value before a time
EventSchema.index({ eventType: 1, 'status.name': 1, timestamp: -1 }, { name: 'eventType_statusName_timestamp' });
// the event log's pages of chosen kinds, and every reading in a window for the rollups
EventSchema.index({ eventType: 1, timestamp: -1 }, { name: 'eventType_timestamp' });
// the oldest events, for retention and the start of history
EventSchema.index({ timestamp: 1 }, { name: 'timestamp' });
// one account's actions, newest first, without walking past the controller's own events
EventSchema.index({ user: 1, timestamp: -1 }, { name: 'user_timestamp', sparse: true });
var Event = mongoose.model('events', EventSchema);

module.exports = { Event };
