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
    }]
});

// auto-create mongo indexes; idempotent
EventSchema.index({ eventType: 1, status: 1, timestamp: -1 }, { name: 'eventType_1' });
var Event = mongoose.model('events', EventSchema);

module.exports = { Event };
