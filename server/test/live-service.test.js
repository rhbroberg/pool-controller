'use strict';
// What the live updates push, and when, without a server or a database.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const liveService = require('../service/LiveService');
const { switchesOf } = require('../service/StatusService');
const { StatusEvent } = require('../protocol/events');

// the status service's model opens a database connection, which would keep the run going
after(() => mongoose.disconnect());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** stands in for the socket.io server, recording what's sent to every client */
const fakeIo = () => {
    const sent = [];
    return { sent, emit: (kind, payload) => sent.push({ kind, payload }) };
};

const statusEvent = (on) => {
    let mask = 0;
    on.forEach((name) => {
        mask |= 1 << StatusEvent.bitPosition(name);
    });
    const frame = Buffer.from([0x10, 0x02, 0x01, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10, 0x03]);
    frame.writeUInt32LE(mask >>> 0, 4);
    let checksum = 0;
    for (let i = 0; i < 12; i++) {
        checksum += frame[i];
    }
    frame.writeUInt16BE(checksum, 12);
    return new StatusEvent(frame);
};

describe('live service', () => {
    it('pushes readings to every client, then heating once for a burst of changes', async () => {
        const io = fakeIo();
        let asked = 0;
        liveService.attach(io, { heating: async () => ({ minimum: 65, asked: ++asked }) });
        const entry = { name: 'filter', category: 'status', value: 1, timestamp: new Date() };
        liveService.readings([entry]);
        liveService.readings([{ ...entry, name: 'pool temp', category: 'info', value: 80 }]);
        assert.deepEqual(io.sent.map((message) => message.kind), ['readings', 'readings'], 'readings go at once');
        assert.deepEqual(io.sent[0].payload, { readings: [entry] });

        await sleep(400);
        assert.deepEqual(io.sent.map((message) => message.kind), ['readings', 'readings', 'heating']);
        assert.deepEqual(io.sent[2].payload, { minimum: 65, asked: 1 }, 'asked for heating only once');

        liveService.heatingChanged();
        await sleep(400);
        assert.equal(io.sent.filter((message) => message.kind === 'heating').length, 2, 'a later change pushes again');
    });

    it('pushes nothing for no readings', async () => {
        const io = fakeIo();
        liveService.attach(io, { heating: async () => ({ minimum: 65 }) });
        liveService.readings([]);
        liveService.readings(undefined);
        await sleep(300);
        assert.deepEqual(io.sent, []);
    });

    it('skips heating it can’t get, without failing', async () => {
        const io = fakeIo();
        liveService.attach(io, { heating: async () => { throw new Error('database down'); } });
        liveService.heatingChanged();
        await sleep(300);
        liveService.attach(io, { heating: async () => null });
        liveService.heatingChanged();
        await sleep(300);
        assert.deepEqual(io.sent, []);
    });
});

describe('switches of a status frame', () => {
    const at = new Date('2026-11-09T12:00:00Z');

    it('lists every named switch, on or off, as GET /status does', () => {
        const switches = switchesOf(statusEvent(['filter', 'aux3', 'superchlorinate']), at);
        const byName = Object.fromEntries(switches.map((entry) => [entry.name, entry.value]));
        assert.equal(byName.filter, 1);
        assert.equal(byName.aux3, 1);
        assert.equal(byName.superchlorinate, 1);
        assert.equal(byName.lights, 0);
        assert.equal(byName.spa, 0);
        assert.ok(switches.every((entry) => entry.category === 'status' && entry.timestamp === at));
    });

    it('leaves out bits nobody has identified, and sorts names as people read them', () => {
        const names = switchesOf(statusEvent([]), at).map((entry) => entry.name);
        assert.ok(names.every((name) => !name.startsWith('unknown')), names.join(', '));
        assert.ok(names.indexOf('aux3') < names.indexOf('aux14'), 'aux3 before aux14');
        assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    });
});
