var mongoose = require('mongoose');

var Event = mongoose.model('Event', {

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

module.exports = { Event };
