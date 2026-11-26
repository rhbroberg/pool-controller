'use strict';
// Brings the hourly and daily rollups up to date in one go, as for years of history that
// predate them, instead of in the rollups job's short steps.
//
//   NODE_ENV=development node tools/rollup-history.js             roll up whatever isn't yet
//   NODE_ENV=development node tools/rollup-history.js --rebuild   discard every rollup and start over
//
// The server's own job does the same work in the background, so this is only to get it done
// now. It shares the job's lease, so it waits while the server is running the job.
require('../config/config');
const log4js = require('log4js');
log4js.getLogger().level = 'warn';
var { mongoose } = require('../mongoose');
var { Rollup } = require('../models/rollup');
var { JobState } = require('../models/jobState');
const settings = require('../service/SettingsService');
const scheduler = require('../jobs/scheduler');
const rollupsJob = require('../jobs/rollups');

const BUSY_WAIT_MS = 10000;

(async () => {
    await mongoose.connection.asPromise();
    await Promise.all([settings.load(), Rollup.syncIndexes()]);
    if (process.argv.includes('--rebuild')) {
        await Rollup.deleteMany({});
        await JobState.updateOne({ _id: rollupsJob.name }, { $set: { data: {} } });
        console.log('discarded every rollup');
    }
    scheduler.register(rollupsJob);
    for (let run = 1; ; run++) {
        const status = await scheduler.runNow(rollupsJob.name, 'rollup-history');
        if (status.busy) {
            console.log('the server is running the rollups job; trying again shortly');
            await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS));
            continue;
        }
        console.log(`${run}: ${status.lastResult === 'ok' ? status.lastSummary : `failed: ${status.lastError}`}`);
        if (status.lastResult !== 'ok' || !status.more) {
            break;
        }
    }
})()
    .catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
