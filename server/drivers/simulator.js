// Stands in for the pool controller: replays a capture like the tail driver, but owns the
// switch state so control writes from the REST API take effect.
const fs = require('fs');
const log4js = require('log4js');
const { FrameParser } = require('../protocol/parse');
const { EventFactory } = require('../protocol/eventfactory');
const { StatusEvent, ControlEvent } = require('../protocol/events');
var logger = log4js.getLogger();

const FRAME_INTERVAL_MS = 25;
const RESPONSE_DELAY_MS = 100;

// control buttons whose name differs from the status bit they drive
const statusNameForControl = {
    'valve4/heater2': 'valve4'
};

var frames = [];
var statusTemplate;
var switchMask = 0;
var emit;

var loadCapture = (filename) => {
    const parser = new FrameParser();
    const factory = new EventFactory();
    parser.parse(fs.readFileSync(filename), (buf) => {
        const frame = Buffer.from(buf);
        let event;
        try {
            event = factory.create(frame);
        } catch (e) {
            return; // drop frames that fail their checksum
        }
        if (!event) {
            return;
        }
        const kind = event.constructor.name;
        if (kind === 'ControlEvent' && event.enabledSwitches().length > 0) {
            return; // recorded keypresses would fight the simulated state
        }
        if (kind === 'StatusEvent' && !statusTemplate) {
            statusTemplate = frame;
            switchMask = event.rawMask() >>> 0;
        }
        frames.push({ kind, frame });
    });
    if (!statusTemplate) {
        throw new Error(`${filename} has no status frames to start from`);
    }
};

var statusFrame = () => {
    const frame = Buffer.from(statusTemplate);
    frame.writeUInt32LE(switchMask >>> 0, 4);
    let checksum = 0;
    for (let i = 0; i < frame.length - 4; i++) {
        checksum += frame.readUInt8(i);
    }
    frame.writeUInt16BE(checksum, frame.length - 4);
    return frame;
};

var listen = ((filename, cb) => {
    emit = cb;
    // frames that fail their checksum are dropped; don't log each one while loading
    const level = logger.level;
    logger.level = 'off';
    try {
        loadCapture(filename);
    } finally {
        logger.level = level;
    }
    logger.info(`simulating the controller with ${frames.length} frames from ${filename}`);

    let next = 0;
    setInterval(() => {
        const { kind, frame } = frames[next];
        next = (next + 1) % frames.length;
        emit(kind === 'StatusEvent' ? statusFrame() : frame);
    }, FRAME_INTERVAL_MS);
});

var writeEvent = ((message) => {
    const control = new ControlEvent(Buffer.from(message));
    const pressed = control.enabledSwitches();
    logger.debug('simulator received control event:', pressed.join(', '));

    setTimeout(() => {
        pressed.forEach((name) => {
            const statusName = statusNameForControl[name] || name;
            const bit = StatusEvent.bitPosition(statusName);
            if (typeof bit === 'undefined') {
                logger.debug(`simulator: '${name}' has no status bit to change`);
                return;
            }
            switchMask = (switchMask ^ (1 << bit)) >>> 0;
            logger.debug(`simulator: ${statusName} is now ${(switchMask >>> bit) & 1 ? 'on' : 'off'}`);
        });
        emit(statusFrame());
    }, RESPONSE_DELAY_MS);
});

module.exports = { listen, writeEvent };
