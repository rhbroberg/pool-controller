'use strict';
// The live feed the browser page subscribes to over socket.io, against the simulated controller.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer } = require('./helpers/server');

describe('streaming', () => {
    let server;
    let socket;

    before(async () => {
        server = await startServer({ database: 'PoolRestTest-streaming' });
        socket = io(`http://127.0.0.1:${server.port}`, { transports: ['websocket'], reconnection: false });
        await new Promise((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('connect_error', reject);
        });
    });

    after(async () => {
        if (socket) {
            socket.close();
        }
        await server.stop();
    });

    it('serves the browser client script', async () => {
        const response = await fetch(`http://127.0.0.1:${server.port}/socket.io/socket.io.js`);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /socket\.io/i);
    });

    it('streams controller frames to connected clients', async () => {
        const message = await new Promise((resolve) => {
            const received = (cleartext) => {
                socket.off('info', received);
                socket.off('status', received);
                resolve(JSON.parse(cleartext));
            };
            socket.on('info', received);
            socket.on('status', received);
        });
        assert.ok(['info', 'status'].includes(message.kind));
        assert.ok(message.text);
        assert.ok(Number.isInteger(message.timestamp), 'timestamp is epoch milliseconds');
    });

    it('acknowledges a client joining the data stream', async () => {
        const peers = new Promise((resolve) => socket.once('peers', resolve));
        await socket.timeout(5000).emitWithAck('join', {});
        assert.match(await peers, /another streamer/);
        const stillRunning = new Promise((resolve) => setTimeout(() => resolve('running'), 500));
        assert.equal(await Promise.race([server.exited, stillRunning]), 'running');
    });
});
