'use strict';
const log4js = require('log4js');

var logger = log4js.getLogger();

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
            logger.debug('alternate message started');
        }
    } else if (state === 'alternate_body') {
        payload.writeUInt8(thisByte, bufferIndex++);
        if (thisByte === 0x1e) {
            state = 'alternate_footer';
        }
    } else if (state === 'alternate_footer') {
        if (thisByte === 0x80) {
            logger.debug('alternate message complete');
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

module.exports = { parse, frameToString };
