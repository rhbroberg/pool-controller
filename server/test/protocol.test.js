'use strict';
// The controller's framing and what the server makes of each frame, without a server or database.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FrameParser, stuff, framesIn } = require('../protocol/parse');
const { EventFactory } = require('../protocol/eventfactory');
const { FrameInterpreter } = require('../protocol/interpreter');

// a wireless remote screen recorded on 2020-07-19, whose checksum 08 10 went on the bus as 08 10 00
const WIRELESS_AIR = Buffer.from('EAIECoMAAyAgQWlyIFRlbXAgIDEwMl9GICAgICAgICAgICAgICAgICAgICAgICAACBAAEAM=', 'base64');

var frame = (type, body) => {
    const bytes = [0x10, 0x02, ...type, ...body];
    const sum = bytes.reduce((total, byte) => total + byte, 0);
    return Buffer.from([...bytes, (sum >> 8) & 0xff, sum & 0xff, 0x10, 0x03]);
};
var display = (text) => frame([0x01, 0x03], [...Buffer.from(text.padEnd(40), 'ascii'), 0x00]);
var status = (bytes) => frame([0x01, 0x02], [...bytes, 0, 0, 0, 0]);

describe('framing', () => {
    it('undoes the escaping of a 0x10 inside a frame, and keeps the bytes as they arrived', () => {
        const [{ frame: parsed, wire }] = framesIn(WIRELESS_AIR);
        assert.deepEqual(wire, WIRELESS_AIR);
        assert.equal(parsed.length, WIRELESS_AIR.length - 1);
        assert.deepEqual([...parsed.subarray(-4)], [0x08, 0x10, 0x10, 0x03]);
        const event = new EventFactory().create(parsed);
        assert.equal(event.constructor.name, 'WirelessDisplayEvent');
        assert.equal(event.getAmbientTemp(), '102');
    });

    it('escapes a 0x10 for the bus, so a 0x10 followed by 0x03 inside a frame does not end it', () => {
        // spa (0x10) and a byte of 0x03 after it
        const sent = status([0x10, 0x03, 0x00, 0x00]);
        const wire = stuff(sent);
        assert.equal(wire.length, sent.length + 1);
        assert.deepEqual([...wire.subarray(4, 7)], [0x10, 0x00, 0x03]);
        const frames = framesIn(wire);
        assert.equal(frames.length, 1);
        assert.deepEqual(frames[0].frame, sent);
        assert.ok(new EventFactory().create(frames[0].frame).enabledSwitches().includes('spa'));
    });

    it('finds each frame in a stream split anywhere', () => {
        const stream = Buffer.concat([stuff(status([0x20, 0, 0, 0])), WIRELESS_AIR, stuff(display('  Pool Temp   80_F'))]);
        const parser = new FrameParser();
        const found = [];
        for (let i = 0; i < stream.length; i += 7) {
            parser.parse(stream.subarray(i, i + 7), (parsed) => found.push(Buffer.from(parsed)));
        }
        assert.equal(found.length, 3);
        assert.deepEqual(found.map((each) => new EventFactory().create(each).constructor.name), ['StatusEvent', 'WirelessDisplayEvent', 'DisplayUpdateEvent']);
    });

    it('drops a frame that never ends instead of overrunning', () => {
        const parser = new FrameParser();
        const found = [];
        parser.parse(Buffer.concat([Buffer.from([0x10, 0x02]), Buffer.alloc(600, 0x41), stuff(status([0x20, 0, 0, 0]))]), (parsed) => found.push(parsed));
        assert.ok(parser.parseErrors > 0);
        assert.equal(found.length, 1, 'the next frame is still found');
    });
});

describe('interpreting frames', () => {
    const factory = new EventFactory();
    const read = (interpreter, bytes) => interpreter.interpret(factory.create(bytes));

    it('stores a reading when it changes, but not a one-degree bounce back', () => {
        const interpreter = new FrameInterpreter();
        assert.deepEqual(read(interpreter, display('  Pool Temp   80_F')).status, [{ name: 'pool temp', value: 80 }]);
        assert.equal(read(interpreter, display('  Pool Temp   80_F')), null);
        assert.deepEqual(read(interpreter, display('  Pool Temp   81_F')).status, [{ name: 'pool temp', value: 81 }]);
        assert.equal(read(interpreter, display('  Pool Temp   80_F')), null, 'a bounce');
        assert.deepEqual(read(interpreter, display('  Pool Temp   82_F')).status, [{ name: 'pool temp', value: 82 }]);
    });

    it('takes readings and the heater mode from the wireless remote', () => {
        const interpreter = new FrameInterpreter();
        const [{ frame: parsed }] = framesIn(WIRELESS_AIR);
        assert.deepEqual(read(interpreter, parsed), { eventType: 'info', status: [{ name: 'ambient', value: 102 }] });
        assert.deepEqual(read(interpreter, display('      Heater1       Auto Control')).status, [{ name: 'heater1 mode', value: 1 }]);
    });

    it('stores the switches that went on and off', () => {
        const interpreter = new FrameInterpreter();
        assert.deepEqual(read(interpreter, status([0x30, 0, 0, 0])).status, [{ name: 'spa', value: 1 }, { name: 'filter', value: 1 }]);
        assert.deepEqual(read(interpreter, status([0x20, 0, 0, 0])).status, [{ name: 'spa', value: 0 }]);
        assert.equal(read(interpreter, status([0x20, 0, 0, 0])), null);
    });

    it('starts from what history held, and follows events kept as they are', () => {
        const interpreter = new FrameInterpreter();
        interpreter.seed({ readings: { 'pool temp': 80 }, switchesOn: ['filter'], heaterAuto: 1 });
        assert.equal(read(interpreter, display('  Pool Temp   80_F')), null);
        assert.equal(read(interpreter, status([0x20, 0, 0, 0])), null);
        interpreter.adopt('status', [{ name: 'filter', value: 0 }]);
        interpreter.adopt('info', [{ name: 'pool temp', value: 84 }]);
        assert.deepEqual(read(interpreter, status([0x20, 0, 0, 0])).status, [{ name: 'filter', value: 1 }]);
        assert.deepEqual(read(interpreter, display('  Pool Temp   80_F')).status, [{ name: 'pool temp', value: 80 }]);
    });
});
