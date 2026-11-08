'use strict';
var mongoose = require('mongoose');

// the server's own settings, one document
var SettingSchema = new mongoose.Schema({
    _id: String,
    // null follows the time zone detected from the host
    timeZone: { type: String, default: null },
    rawRetentionDays: Number
});

var Setting = mongoose.model('settings', SettingSchema);

module.exports = { Setting };
