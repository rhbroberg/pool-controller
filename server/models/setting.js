'use strict';
var mongoose = require('mongoose');

// the server's own settings, one document
var SettingSchema = new mongoose.Schema({
    _id: String,
    // null follows the time zone detected from the host
    timeZone: { type: String, default: null },
    rawRetentionDays: Number,
    // whether accounts may sign in with a name and password
    passwordSignIn: { type: Boolean, default: true },
    // ask: someone without an account or invitation becomes a request for an admin; refuse: turned away
    signInRequests: { type: String, enum: ['ask', 'refuse'], default: 'ask' }
});

var Setting = mongoose.model('settings', SettingSchema);

module.exports = { Setting };
