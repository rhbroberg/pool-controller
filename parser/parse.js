'use strict';
const fs = require('fs');
const log4js = require('log4js');

var logger = log4js.getLogger();
logger.level = 'info';

var payload;
var state = 'begin';
var checksum;
var start;
let bufferIndex;

var verifyChecksum = (msb, lsb) => {
    const messageChecksum = msb * 256 + lsb;
    if (messageChecksum !== checksum) {
        logger.error(`checksum mismatch: found ${messageChecksum.toString(16)}, computed ${checksum.toString(16)} at ${start}; ${msb} ${lsb}`);
        return false;
    }
    return true;
};

var frameToString = (frame, length) => {
    var readable = '';
    for (var i = 0; i < length; i++) {
        readable += '0x';
        readable += frame[i].toString(16).padStart(2, 0);
        readable += ' ';
    }
    return readable;
};

var parse = (hunk, received) => {
    payload = new Buffer.allocUnsafe(1024);
    for (var i = 0; i < hunk.length; i++) {
        let thisByte = hunk[i];
        logger.trace('hunka hunka: ', thisByte.toString(16));
        if ((state === 'begin') && thisByte === 0x10) {
            state = 'header_1';
            checksum = thisByte;
            start = i;
        } else if (state === 'header_1' && thisByte === 0x02) {
            state = 'in_body';
            bufferIndex = 0;
            checksum += thisByte;
        } else if (state === 'in_body') {
            if (thisByte === 0x10) {
                state = 'footer_1';
                checksum -= payload.readUInt8(bufferIndex - 2);
                checksum -= payload.readUInt8(bufferIndex - 1);
                if (!verifyChecksum(payload.readUInt8(bufferIndex - 2), payload.readUInt8(bufferIndex - 1))) {
                    logger.error(frameToString(payload, bufferIndex));
                }

                bufferIndex -= 2;
            }
            else {
                payload.writeUInt8(thisByte, bufferIndex++);
                checksum += thisByte;
            }
        }
        else if ((state === 'footer_1') && (thisByte === 0x03)) {
            logger.debug('complete message: ', checksum.toString(16), bufferIndex);
            received(payload, bufferIndex);
            bufferIndex = 0;
            state = 'begin';
        }
        else {
            logger.error(`parse error: state ${state}, byte ${thisByte.toString(16)}, index ${i}`);
            logger.error(frameToString(payload, bufferIndex));
            state = 'begin';
            start = i;
        }
    }
};

fs.readFile(__dirname + '/' + '../test-data/sample-all-bin', (err, data) => {
    logger.info('starting');
    if (err)
    {
        console.log(err);
        return;
    }
    parse(data, (buf, len) => {
        logger.debug(frameToString(buf, len));
        if (buf.readUInt8(0) === 0x01 && buf.readUInt8(1) === 0x03) {
            const message = buf.toString('ascii', 2, len - 2);
            logger.info('screen1: ', message);
        }
        if (buf.readUInt8(0) === 0x01 && buf.readUInt8(1) === 0x01) {
            logger.debug('heartbeat');
        }
        if (buf.readUInt8(0) === 0x04 && buf.readUInt8(1) === 0x0a) {
            const message = buf.toString('ascii', 5, len - 5);
            logger.info('screen2: ', message);
        }
    });
});
