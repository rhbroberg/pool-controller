import fs from 'fs';
import log4js from 'log4js';
const Tail = require('./tail');
import { ControlEvent } from '../protocol/events';

const logger = log4js.getLogger();

const streamFromStart = (filename: string, cb: (data: Buffer) => void) => {
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

const listen = ((filename: string, cb: (data: Buffer) => void, options?: { fromStart?: boolean }) => {
    logger.info('tailing file', filename);
    if (options && options.fromStart) {
        logger.info('reading capture from the start');
        streamFromStart(filename, cb);
        return;
    }

    var tail = new Tail(filename, new RegExp(String.fromCharCode(0x03)), { 'interval': 500 });
    tail.on('line', (data: any) => {
        logger.debug('got another tail hunk');
        cb(data);
    });
});

const writeEvent = ((message: any) => {
    const myControl = new ControlEvent(message);
    logger.debug('writing control event: ', myControl.asString());
});

export { listen, writeEvent };
