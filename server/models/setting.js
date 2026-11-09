'use strict';
var mongoose = require('mongoose');

// where the pool is, found from the zip code an admin gave, so weather can be fetched for it
var LocationSchema = new mongoose.Schema({
    zipCode: String,
    countryCode: String,
    latitude: Number,
    longitude: Number,
    placeName: String,
    updatedAt: Date
}, { _id: false });

// the server's own settings, one document
var SettingSchema = new mongoose.Schema({
    _id: String,
    // null follows the time zone detected from the host
    timeZone: { type: String, default: null },
    rawRetentionDays: Number,
    // null until an admin gives a zip code; no weather is fetched without one
    location: { type: LocationSchema, default: null },
    // whether accounts may sign in with a name and password
    passwordSignIn: { type: Boolean, default: true },
    // ask: someone without an account or invitation becomes a request for an admin; refuse: turned away
    signInRequests: { type: String, enum: ['ask', 'refuse'], default: 'ask' }
});

var Setting = mongoose.model('settings', SettingSchema);

module.exports = { Setting };
