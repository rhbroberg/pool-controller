'use strict';
var mongoose = require('mongoose');

// one document per maintenance job: its lease, how its last run went, and whatever it keeps
// between runs (such as how far rollups have got)
var JobStateSchema = new mongoose.Schema({
    _id: String,
    leaseOwner: String,
    leaseUntil: Date,
    lastStartedAt: Date,
    lastFinishedAt: Date,
    lastDurationMs: Number,
    lastResult: String,
    lastError: String,
    lastSummary: String,
    runs: { type: Number, default: 0 },
    data: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { minimize: false });

var JobState = mongoose.model('jobs', JobStateSchema);

module.exports = { JobState };
