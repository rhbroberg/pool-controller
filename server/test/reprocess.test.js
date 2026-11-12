'use strict';
// Reprocessing stored history: frames the server once couldn't read are read again with today's
// protocol code, through the REST API, and the summaries are redone after.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startServer, commission, account, eventually } = require('./helpers/server');
const { stuff } = require('../protocol/parse');

const MINUTE_MS = 60 * 1000;
// a wireless remote screen recorded on 2020-07-19: air 102°F, with an escaped 0x10 in its checksum
const WIRELESS_AIR = Buffer.from('EAIECoMAAyAgQWlyIFRlbXAgIDEwMl9GICAgICAgICAgICAgICAgICAgICAgICAACBAAEAM=', 'base64');
const SPA = [0x10, 0, 0, 0];
const SPA_AND_FILTER = [0x30, 0, 0, 0];
const CHECK_SYSTEM = [0x04, 0, 0, 0];

var frame = (type, body) => {
    const bytes = [0x10, 0x02, ...type, ...body];
    const sum = bytes.reduce((total, byte) => total + byte, 0);
    return Buffer.from([...bytes, (sum >> 8) & 0xff, sum & 0xff, 0x10, 0x03]);
};
var display = (text) => stuff(frame([0x01, 0x03], [...Buffer.from(text.padEnd(40), 'ascii'), 0x00]));
var status = (bytes) => stuff(frame([0x01, 0x02], [...bytes, 0, 0, 0, 0]));

describe('reprocessing history', () => {
    let server;
    let api;
    let admin;
    let viewer;
    let connection;
    let events;
    const start = Date.now() - 2 * 24 * 60 * MINUTE_MS;
    const at = (minutes) => new Date(start + minutes * MINUTE_MS);
    const ids = {};

    const add = (name, eventType, minutes, raw, status = []) => {
        ids[name] = new mongoose.Types.ObjectId();
        return { _id: ids[name], source: 'panel', eventType, timestamp: at(minutes), raw, status };
    };

    const reprocess = async (body) => {
        const started = await api('POST', '/system/reprocess', { token: admin, body });
        assert.equal(started.status, 202, started.text);
        const run = await eventually(async () => {
            const current = await api('GET', '/system/reprocess', { token: admin });
            return current.status === 200 && ['finished', 'failed'].includes(current.body.state) ? current.body : undefined;
        }, { message: 'reprocessing to finish', timeoutMs: 20000 });
        assert.equal(run.state, 'finished', run.error);
        return run;
    };

    const doc = (name) => events.findOne({ _id: ids[name] });
    const readings = async (name) => (await doc(name)).status.map((entry) => [entry.name, entry.value]);
    const transition = (run, from, to) => (run.transitions.find((each) => each.from === from && each.to === to) || { count: 0 }).count;
    const first = { from: at(-1).toISOString(), to: at(10).toISOString() };
    const fault = { from: at(39).toISOString(), to: at(44).toISOString() };
    const second = { from: at(95).toISOString(), to: at(110).toISOString() };

    before(async () => {
        server = await startServer({ database: 'PoolRestTest-reprocess', driver: 'none', args: ['--no-jobs'] });
        api = server.api;
        admin = await commission(api);
        viewer = await account(api, admin, 'watcher', 'viewer');
        connection = await mongoose.createConnection(server.uri).asPromise();
        events = connection.db.collection('events');
        const corrupt = Buffer.from(display('  Pool Temp   81_F'));
        corrupt[corrupt.length - 3] ^= 0x01;
        await events.insertMany([
            // the first window: frames stored as failures, and a switch already on
            add('pool', 'info', 0, display('  Pool Temp   80_F'), [{ name: 'pool temp', value: 80 }]),
            add('switches', 'failed', 1, status(SPA)),
            add('wireless', 'failed', 2, WIRELESS_AIR),
            add('repeat', 'failed', 3, display('   Air Temp   102_F')),
            add('corrupt', 'failed', 4, corrupt),
            add('mystery', 'failed', 5, stuff(frame([0x09, 0x09], [0x10, 0x01]))),
            add('reassert', 'status', 6, status(SPA), [{ name: 'spa', value: 1 }]),
            { _id: new mongoose.Types.ObjectId(), eventType: 'action', source: 'rest', user: 'someone', message: 'Turned Lights on', timestamp: at(7), status: [] },
            // a fault, and the panel saying why while it lasts; it clears before the second window
            add('faultOn', 'status', 40, status(CHECK_SYSTEM), [{ name: 'check system', value: 1 }]),
            add('reason', 'failed', 41, display('    Check System          Low Salt')),
            add('sameReason', 'failed', 42, display('    Check System          Low Salt')),
            add('faultOff', 'status', 45, status([0, 0, 0, 0]), [{ name: 'check system', value: 0 }]),
            // what history held before the second window
            add('heldPool', 'info', 90, display('  Pool Temp   85_F'), [{ name: 'pool temp', value: 85 }]),
            add('heldFilter', 'status', 91, status(SPA_AND_FILTER), [{ name: 'filter', value: 1 }]),
            // the second window
            add('samePool', 'failed', 100, display('  Pool Temp   85_F')),
            add('sameSwitches', 'failed', 101, status(SPA_AND_FILTER)),
            add('warmer', 'failed', 102, display('  Pool Temp   86_F')),
            add('again', 'info', 103, display('  Pool Temp   86_F'), [{ name: 'pool temp', value: 86 }]),
            add('warmest', 'info', 104, display('  Pool Temp   87_F'), [{ name: 'pool temp', value: 87 }])
        ]);
        // caught up, as on a running server, so a rebuild has to move its progress back
        const rolled = await api('POST', '/system/jobs/rollups/run', { token: admin });
        assert.equal(rolled.status, 200, rolled.text);
    });

    after(async () => {
        await connection.close();
        await server.stop();
    });

    it('is only for admins, and checks what it is asked', async () => {
        assert.equal((await api('POST', '/system/reprocess', { body: first })).status, 401);
        assert.equal((await api('POST', '/system/reprocess', { token: viewer, body: first })).status, 403);
        assert.equal((await api('GET', '/system/reprocess', { token: viewer })).status, 403);
        assert.equal((await api('POST', '/system/reprocess', { token: admin, body: { ...first, eventTypes: ['action'] } })).status, 400);
        assert.equal((await api('POST', '/system/reprocess', { token: admin, body: { from: first.to, to: first.from } })).status, 400);
        assert.equal((await api('POST', '/system/reprocess', { token: admin, body: { from: 'yesterday', to: first.to } })).status, 400);
        assert.equal((await api('POST', '/system/reprocess', { token: admin, body: { to: first.to } })).status, 400);
        assert.equal((await api('GET', '/system/reprocess', { token: admin })).status, 404, 'nothing has run yet');
    });

    it('previews what would change without changing anything', async () => {
        const run = await reprocess({ ...first, dryRun: true });
        assert.equal(run.dryRun, true);
        assert.deepEqual(run.eventTypes, ['info', 'status', 'control', 'failed', 'unrecognized'], 'every kind by default');
        assert.equal(run.examined, 7, 'every frame, and not the action');
        assert.equal(transition(run, 'failed', 'status'), 1);
        assert.equal(transition(run, 'failed', 'info'), 1);
        assert.equal(transition(run, 'failed', 'removed'), 1, 'the air reading again');
        assert.equal(transition(run, 'failed', 'unrecognized'), 1);
        assert.equal(transition(run, 'status', 'removed'), 1, 'the spa was already on');
        assert.equal(run.unchanged, 2, 'the pool reading and the frame that still fails');
        assert.equal((await doc('switches')).eventType, 'failed');
        assert.equal(await events.countDocuments({ timestamp: { $gte: at(-1), $lt: at(10) } }), 8, 'nothing removed');
    });

    it('rewrites only the chosen kinds, and has the summaries redone', async () => {
        const run = await reprocess({ ...first, eventTypes: ['failed'] });
        assert.equal(run.examined, 5);
        assert.equal((await doc('switches')).eventType, 'status');
        assert.deepEqual(await readings('switches'), [['spa', 1]]);
        assert.equal((await doc('wireless')).eventType, 'info');
        assert.deepEqual(await readings('wireless'), [['ambient', 102]]);
        assert.equal(await doc('repeat'), null);
        assert.equal((await doc('corrupt')).eventType, 'failed');
        assert.equal((await doc('mystery')).eventType, 'unrecognized');
        assert.equal((await doc('reassert')).eventType, 'status', 'status events were not chosen');

        const rollups = await eventually(async () => {
            const jobs = await api('GET', '/system/jobs', { token: admin });
            const job = jobs.body.find((each) => each.name === 'rollups');
            return job && job.runs > 1 && !job.running ? job : undefined;
        }, { message: 'the rollups job to run after reprocessing' });
        assert.match(rollups.lastSummary, new RegExp(`rebuilding from ${first.from.slice(0, 16)}`));

        const log = await api('GET', '/events?types=action', { token: admin });
        assert.ok(log.body.events.some((event) => /^Reprocessed history/.test(event.summary)), JSON.stringify(log.body.events));
    });

    it('answers the same the second time', async () => {
        const run = await reprocess({ ...first, eventTypes: ['failed'] });
        assert.equal(run.updated, 0);
        assert.equal(run.removed, 0);
    });

    it('keeps the panel’s reason to check the system, once for each fault', async () => {
        const run = await reprocess({ ...fault, eventTypes: ['failed'] });
        assert.equal(run.examined, 2);
        assert.equal((await doc('reason')).eventType, 'info');
        assert.deepEqual(await readings('reason'), [['check system reason', 1]]);
        assert.equal((await doc('reason')).message, 'Low Salt');
        assert.equal(await doc('sameReason'), null, 'the panel showing the same reason again');

        const log = await api('GET', `/events?types=info&order=asc&cursor=${encodeURIComponent(`${at(40).toISOString()}|`)}`, { token: admin });
        assert.equal(log.body.events[0].summary, 'Check System: Low Salt');

        const again = await reprocess({ ...fault, eventTypes: ['info', 'failed'] });
        assert.equal(again.updated + again.removed, 0, 'the message is kept as it is');
    });

    it('starts from what history held before the range, and rewrites every kind at once', async () => {
        const later = new Date(Date.now() + 24 * 60 * MINUTE_MS).toISOString();
        const run = await reprocess({ from: second.from, to: later });
        assert.ok(new Date(run.to).getTime() <= Date.now(), 'a range ending later stops at now');
        assert.equal(run.examined, 5, 'each event once, though one became a reading on the way');
        assert.equal(await doc('samePool'), null, 'the pool was already 85');
        assert.equal(await doc('sameSwitches'), null, 'the filter was already on');
        assert.equal((await doc('warmer')).eventType, 'info');
        assert.deepEqual(await readings('warmer'), [['pool temp', 86]]);
        assert.equal(await doc('again'), null, 'a reading of 86 again');
        assert.deepEqual(await readings('warmest'), [['pool temp', 87]]);
        assert.equal(run.unchanged, 1);

        const again = await reprocess({ from: second.from, to: later });
        assert.equal(again.updated + again.removed, 0);
    });
});
