var Tail = require('./tail');
const fs = require('fs');
const log4js = require('log4js');
var logger = log4js.getLogger();
const { PingEvent, StatusEvent, DisplayUpdateEvent, ControlEvent, MotorTelemetryEvent, UnidentifiedPingEvent, UnidentifiedStatusEvent } = require('../protocol/events'); // eslint-disable-line no-unused-vars

var streamFromStart = (filename, cb) => {
    fs.open(filename, 'r', (err, fd) => {
        if (err) {
            logger.error(err);
            return;
        }
        fs.fstat(fd, (statErr, stat) => {
            if (statErr) {
                logger.error(statErr);
                return;
            }
            let offset = 0;
            const chunkSize = 256;
            const pump = () => {
                if (offset >= stat.size) {
                    fs.close(fd, () => {});
                    logger.info('replay complete');
                    return;
                }
                const size = Math.min(chunkSize, stat.size - offset);
                const buf = Buffer.alloc(size);
                fs.read(fd, buf, 0, size, offset, (readErr, bytesRead) => {
                    if (readErr) {
                        logger.error(readErr);
                        return;
                    }
                    offset += bytesRead;
                    cb(buf.slice(0, bytesRead));
                    setTimeout(pump, 20);
                });
            };
            pump();
        });
    });
};

var listen = ((filename, cb, options) => {
    logger.info('tailing file', filename);
    if (options && options.fromStart) {
        logger.info('reading capture from the start');
        streamFromStart(filename, cb);
        return;
    }

    var tail = new Tail(filename, /\003/, { 'interval': 500 });
    tail.on('line', (data) => {
        logger.debug('got another tail hunk');
        cb(data);
    });
});

var writeEvent = ((message) => {
    const myControl = new ControlEvent(message);
    logger.debug('writing control event: ', myControl.asString());
});

module.exports = { listen, writeEvent };
