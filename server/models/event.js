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
// bubble under wallpaper alert: timestamp first, some queries super fast, others super slow
EventSchema.index({ eventType: 1, timestamp: -1, status: 1, 'status.0.name': 1, 'status.0.value': 1, 'status.1.name': 1, 'status.1.value': 1, 'status.2.name': 1, 'status.2.value': 1 }, { name: 'eventType_1' });
var Event = mongoose.model('events', EventSchema);

module.exports = { Event };
