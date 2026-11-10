'use strict';
// Frames whose bytes include 0x10, which the bus escapes as 10 00: the server reads them as the
// controller sent them, stores them as they arrived, and escapes the key presses it sends.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');
const { startServer, commission, account, reading, eventually } = require('./helpers/server');
const { stuff } = require('../protocol/parse');

// a wireless remote screen recorded on 2020-07-19: air 102°F, its checksum 08 10 sent as 08 10 00
const WIRELESS_AIR = Buffer.from('EAIECoMAAyAgQWlyIFRlbXAgIDEwMl9GICAgICAgICAgICAgICAgICAgICAgICAACBAAEAM=', 'base64');

var frame = (type, body) => {
    const bytes = [0x10, 0x02, ...type, ...body];
    const sum = bytes.reduce((total, byte) => total + byte, 0);
    return Buffer.from([...bytes, (sum >> 8) & 0xff, sum & 0xff, 0x10, 0x03]);
};

describe('escaped frames', () => {
    let server;
    let api;
    let token;
    let connection;
    let dir;

    before(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-escaped-'));
        const capture = path.join(dir, 'capture');
        // the spa on, its bit 0x10; a panel screen the simulator can echo keys on; the remote; and the
        // controller's ping, after which the server sends a key press
        fs.writeFileSync(capture, Buffer.concat([
            stuff(frame([0x01, 0x02], [0x10, 0, 0, 0, 0, 0, 0, 0])),
            stuff(frame([0x01, 0x01], [])),
            stuff(frame([0x01, 0x03], [...Buffer.from('    Salt Level      3100 PPM'.padEnd(40), 'ascii'), 0x00])),
            WIRELESS_AIR
        ]));
        server = await startServer({ database: 'PoolRestTest-escaped', capture });
        api = server.api;
        const admin = await commission(api);
        token = await account(api, admin, 'operator', 'user');
        connection = await mongoose.createConnection(server.uri).asPromise();
    });

    after(async () => {
        await connection.close();
        await server.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('reads switches and the remote’s readings from frames with an escaped 0x10', async () => {
        await eventually(async () => (await reading(api, 'spa')) === true, { message: 'the spa switch, whose frame is escaped' });
        assert.equal(await reading(api, 'filter'), false);
        await eventually(async () => (await reading(api, 'ambient')) === 102, { message: 'the air temperature from the wireless remote' });
    });

    it('stores frames as they arrived and none as failures', async () => {
        const events = connection.db.collection('events');
        const air = await events.findOne({ eventType: 'info', 'status.name': 'ambient' });
        assert.deepEqual(Buffer.from(air.raw.buffer), WIRELESS_AIR);
        const spa = await events.findOne({ eventType: 'status', 'status.name': 'spa' });
        assert.ok(Buffer.from(spa.raw.buffer).includes(Buffer.from([0x10, 0x00])), 'the switches frame kept its escape');
        assert.equal(await events.countDocuments({ eventType: 'failed' }), 0);
    });

    it('escapes a key press whose frame holds a 0x10, so the controller reads it', async () => {
        // minus is 0x10 in the first key byte
        const press = await api('PUT', '/panel/keys/minus', { token });
        assert.equal(press.status, 200);
        await eventually(async () => {
            const display = await api('GET', '/panel/display');
            return display.status === 200 && display.body.lines.join(' ').includes('- DOWN');
        }, { message: 'the simulator to show the minus key it received' });
    });
});
