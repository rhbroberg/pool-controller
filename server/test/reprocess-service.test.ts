'use strict';
// The reprocessing service and the rollups' rebuild mark, in this process, for what the REST API
// can't time or set up: a second run while one waits its turn, bytes that hold no frame, and a
// summary that reaches into the range.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const DATABASE = 'PoolServiceTest-reprocess';
process.env.MONGODB_URI = `${process.env.TEST_MONGO_HOST || 'mongodb://127.0.0.1:27017'}/${DATABASE}`;
require('log4js').getLogger().level = 'off';
const { mongoose } = require('../mongoose');
const { Event } = require('../models/event');
const { Rollup } = require('../models/rollup');
const { JobState } = require('../models/jobState');
const Reprocess = require('../service/ReprocessService');
const rollups = require('../service/RollupService');
const scheduler = require('../jobs/scheduler');
const { stuff } = require('../protocol/parse');

const HOUR_MS = 3600 * 1000;

var frame = (type, body) => {
    const bytes = [0x10, 0x02, ...type, ...body];
    const sum = bytes.reduce((total, byte) => total + byte, 0);
    return Buffer.from([...bytes, (sum >> 8) & 0xff, sum & 0xff, 0x10, 0x03]);
};
var display = (text) => stuff(frame([0x01, 0x03], [...Buffer.from(text.padEnd(40), 'ascii'), 0x00]));

var finished = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
        const run = await Reprocess.status();
        if (run && !['waiting', 'running'].includes(run.state)) {
            return run;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('reprocessing never finished');
};

describe('reprocessing service', () => {
    const hour = Math.floor((Date.now() - 48 * HOUR_MS) / HOUR_MS) * HOUR_MS;
    // half way through an hour, so that hour's summary reaches into the range
    const from = new Date(hour + HOUR_MS / 2);
    const to = new Date(hour + HOUR_MS);

    before(async () => {
        await mongoose.connection.asPromise();
        await mongoose.connection.dropDatabase();
        // the server builds these at startup; reprocessing walks each kind by its index
        await Promise.all([Event, Rollup].map((model) => model.syncIndexes()));
    });

    after(async () => {
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
    });

    it('turns down a second run while one waits for the job queue', async () => {
        let release;
        const busy = scheduler.exclusive(() => new Promise((resolve) => { release = resolve; }));
        const waiting = await Reprocess.start({ from: from.toISOString(), to: to.toISOString(), dryRun: true });
        assert.equal(waiting.state, 'waiting');
        await assert.rejects(Reprocess.start({ from: from.toISOString(), to: to.toISOString() }), (error) => error.code === 409);
        release();
        await busy;
        const run = await finished();
        assert.equal(run.state, 'finished', run.error);
    });

    it('starts from stored events, not from a summary that reaches into the range', async () => {
        await Rollup.create({ name: 'pool temp', res: rollups.HOUR, start: new Date(hour), end: new Date(hour + HOUR_MS), count: 1, min: 80, max: 80, sum: 80 * HOUR_MS / 2, knownMs: HOUR_MS / 2, last: 80 });
        await Event.create({ _id: new mongoose.Types.ObjectId(), source: 'panel', eventType: 'failed', timestamp: new Date(from.getTime() + 60000), raw: display('  Pool Temp   80_F'), status: [] });
        await Reprocess.start({ from: from.toISOString(), to: to.toISOString(), eventTypes: ['failed'], dryRun: true });
        const run = await finished();
        assert.deepEqual(run.transitions, [{ from: 'failed', to: 'info', count: 1 }]);
    });

    it('leaves alone an event whose bytes hold no whole frame', async () => {
        const garbled = await Event.create({ _id: new mongoose.Types.ObjectId(), source: 'panel', eventType: 'failed', timestamp: new Date(from.getTime() + 120000), raw: Buffer.from([0x10, 0x02, 0x01, 0x03, 0x41]), status: [] });
        await Reprocess.start({ from: from.toISOString(), to: to.toISOString(), eventTypes: ['failed'] });
        const run = await finished();
        assert.equal(run.unreadable, 1);
        assert.equal((await Event.findById(garbled._id).lean()).eventType, 'failed');
    });

    it('moves the rollups’ rebuild mark back, even after the job has cleared it', async () => {
        await JobState.deleteMany({});
        const early = new Date('2020-07-19T04:00:00Z');
        const later = new Date('2021-01-01T00:00:00Z');
        await rollups.invalidateFrom(later);
        assert.equal((await JobState.findById(rollups.ROLLUPS_JOB).lean()).data.rebuildFrom.getTime(), later.getTime(), 'with no job state yet');
        await rollups.invalidateFrom(early);
        await rollups.invalidateFrom(later);
        assert.equal((await JobState.findById(rollups.ROLLUPS_JOB).lean()).data.rebuildFrom.getTime(), early.getTime(), 'the earliest wins');
        await JobState.updateOne({ _id: rollups.ROLLUPS_JOB }, { $set: { 'data.rebuildFrom': null } });
        await rollups.invalidateFrom(later);
        assert.equal((await JobState.findById(rollups.ROLLUPS_JOB).lean()).data.rebuildFrom.getTime(), later.getTime(), 'after the job cleared it');
    });
});
