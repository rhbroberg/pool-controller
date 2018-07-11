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
let mode;

payload = new Buffer.allocUnsafe(1024);

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

var parseRegular = (received, thisByte, i) => {
    if (state === 'header_1') {
        if (thisByte === 0x02) {
            state = 'in_body';
            bufferIndex = 0;
            checksum += thisByte;
        }
    } else if (state === 'in_body') {
        if ((thisByte === 0x03) && (payload.readUInt8(bufferIndex - 1) === 0x10)) {
            const msb = payload.readUInt8(bufferIndex - 3);
            const lsb = payload.readUInt8(bufferIndex - 2);
            logger.trace(`msb ${msb} and lsb ${lsb}`);
            checksum -= (msb + lsb + 0x10); // the 0x10 is the (thisByte -1) sub-termination char
            bufferIndex -= 3; // back up the 2 checksum bytes and the sub-termination char

            if (!verifyChecksum(msb, lsb)) {
                logger.error(frameToString(payload, bufferIndex));
            }

            logger.debug('complete message: ', checksum.toString(16), bufferIndex);
            received(payload, bufferIndex);
            bufferIndex = 0;
            state = 'begin';
        }
        else {
            payload.writeUInt8(thisByte, bufferIndex++);
            checksum += thisByte;
        }
    }
    else {
        logger.error(`parse error: state ${state}, byte ${thisByte.toString(16)}, index ${i} `);
        logger.error(frameToString(payload, bufferIndex));
        state = 'begin';
        start = i;
    }
};

var parseAlternate = (received, thisByte) => {
    if (state === 'alternate_header') {
        if (thisByte === 0x18) {
            state = 'alternate_body';
            logger.info('alternate message started');
        }
    } else if (state === 'alternate_body') {
        payload.writeUInt8(thisByte, bufferIndex++);
        if (thisByte === 0x1e) {
            state = 'alternate_footer';
        }
    } else if (state === 'alternate_footer') {
        if (thisByte === 0x80) {
            logger.info('alternate message complete');
            state = 'begin';
            bufferIndex = 0;
            received(payload, bufferIndex);
        }
    }
};

var parse = (hunk, received) => {
    for (var i = 0; i < hunk.length; i++) {
        let thisByte = hunk[i];
        logger.trace('hunka hunka: ', thisByte.toString(16));
        if (state === 'begin') {
            if (thisByte === 0x10) {
                state = 'header_1';
                checksum = thisByte;
                start = i;
                mode = 'regular';
            } else if (thisByte === 0xe0) {
                state = 'alternate_header';
                mode = 'alternate';
            }
        } else if (mode === 'regular') {
            parseRegular(received, thisByte, i);
        } else if (mode === 'alternate') {
            parseAlternate(received, thisByte);
        }
    }
};

var isMessage = (buf, first, second) => {
    return (buf.readUInt8(0) === first && buf.readUInt8(1) === second) ? true : false;
};

fs.readFile(__dirname + '/' + '../test-data/sample-all-bin', (err, data) => {
    logger.info('starting');
    if (err)
    {
        logger.error(err);
        return;
    }
    parse(data, (buf, len) => {
        logger.debug(frameToString(buf, len));

        if (isMessage(buf, 0x01, 0x03)) {
            logger.info('screen1: ', buf.toString('ascii', 2, len - 2));
        }

        if (isMessage(buf, 0x01, 0x01)) {
            logger.debug('heartbeat');
        }

        if (isMessage(buf, 0x04, 0x0a)) {
            logger.info('screen2: ', buf.toString('ascii', 5, len - 5), '\n');
        }

        if (isMessage(buf, 0xe0, 0x18)) {
            logger.info('motor: ', buf.toString('ascii', 2, len - 2));
        }
    });
});
