'use strict';
var mongoose = require('mongoose');

// one reading summarized over one bucket of time: hourly buckets on the UTC hour, daily ones on
// the pool's local midnight. Values hold until they change, so the average is weighted by how
// long each value was in effect, and knownMs is how much of the bucket had a value at all.
var RollupSchema = new mongoose.Schema({
    name: String,
    // bucket length in seconds: 3600 or 86400
    res: Number,
    start: Date,
    end: Date,
    // readings recorded in the bucket
    count: Number,
    min: Number,
    max: Number,
    // value × milliseconds in effect, so buckets combine exactly
    sum: Number,
    knownMs: Number,
    // the value in effect as the bucket ends
    last: Number
}, { versionKey: false });

// every history and availability query is a range of one name at one resolution
RollupSchema.index({ name: 1, res: 1, start: 1 }, { name: 'name_res_start', unique: true });

var Rollup = mongoose.model('rollups', RollupSchema);

module.exports = { Rollup };
