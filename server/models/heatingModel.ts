'use strict';
var mongoose = require('mongoose');

// what the server learned from history about how each body of water warms and cools: the fit for
// each body, the range of history it was learned from, and the windows it was made from. Saving
// a new one makes it the active one; the earlier ones stay as a record.
var HeatingModelSchema = new mongoose.Schema({
    createdAt: { type: Date, default: Date.now },
    createdBy: String,
    // the history the windows were looked for in
    range: { from: Date, to: Date },
    // the time zone the sun was taken from: the model's sun term goes with that wall clock
    timeZone: String,
    // { pool, spa }: each as fitBody() describes it
    bodies: mongoose.Schema.Types.Mixed,
    // the windows the fit used, kept compact: [{ id, body, sources, start, end, hours, slope, ... }]
    windowsUsed: mongoose.Schema.Types.Mixed,
    active: { type: Boolean, default: false, index: true }
});

var HeatingModel = mongoose.model('heatingmodels', HeatingModelSchema);

module.exports = { HeatingModel };
