'use strict';
const log4js = require('log4js');

var logger = log4js.getLogger();

class FrameParser {

    constructor() {
        this.state = 'begin';
        this.checksum = 0;
        this.start = 0;
        this.bufferIndex = 0;
        this.mode = 'none';

        this.payload = new Buffer.allocUnsafe(1024);
    }

    verifyChecksum(msb, lsb) {
        const messageChecksum = msb * 256 + lsb;
        if (messageChecksum !== this.checksum) {
            logger.error(`checksum mismatch: found ${messageChecksum.toString(16)}, computed ${this.checksum.toString(16)} at ${this.start}; ${msb} ${lsb}`);
            return false;
        }
        return true;
    }

    toString(frame, length) {
        var readable = '';
        for (var i = 0; i < length; i++) {
            readable += '0x';
            readable += frame[i].toString(16).padStart(2, 0);
            readable += ' ';
        }
        return readable;
    }

    parseRegular(received, thisByte, i) {
        if (this.state === 'header_1') {
            if (thisByte === 0x02) {
                this.state = 'in_body';
                this.bufferIndex = 0;
                this.checksum += thisByte;
            }
        } else if (this.state === 'in_body') {
            if ((thisByte === 0x03) && (this.payload.readUInt8(this.bufferIndex - 1) === 0x10)) {
                const msb = this.payload.readUInt8(this.bufferIndex - 3);
                const lsb = this.payload.readUInt8(this.bufferIndex - 2);
                logger.trace(`msb ${msb} and lsb ${lsb}`);
                this.checksum -= (msb + lsb + 0x10); // the 0x10 is the (thisByte -1) sub-termination char
                this.bufferIndex -= 3; // back up the 2 checksum bytes and the sub-termination char

                if (!this.verifyChecksum(msb, lsb)) {
                    logger.error(this.toString(this.payload, this.bufferIndex));
                }

                logger.debug('complete message: ', this.checksum.toString(16), this.bufferIndex);
                received(this.payload, this.bufferIndex);
                this.bufferIndex = 0;
                this.state = 'begin';
            }
            else {
                this.payload.writeUInt8(thisByte, this.bufferIndex++);
                this.checksum += thisByte;
            }
        }
        else {
            logger.error(`parse error: state ${this.state}, byte ${thisByte.toString(16)}, index ${i} `);
            logger.error(this.toString(this.payload, this.bufferIndex));
            this.state = 'begin';
            this.start = i;
        }
    }

    parseAlternate(received, thisByte) {
        if (this.state === 'alternate_header') {
            if (thisByte === 0x18) {
                this.state = 'alternate_body';
                logger.debug('alternate message started');
            }
        } else if (this.state === 'alternate_body') {
            this.payload.writeUInt8(thisByte, this.bufferIndex++);
            if (thisByte === 0x1e) {
                this.state = 'alternate_footer';
            }
        } else if (this.state === 'alternate_footer') {
            if (thisByte === 0x80) {
                logger.debug('alternate message complete');
                this.state = 'begin';
                this.bufferIndex = 0;
                received(this.payload, this.bufferIndex);
            }
        }
    }

    parse(hunk, received) {
        for (var i = 0; i < hunk.length; i++) {
            let thisByte = hunk[i];
            logger.trace('hunka hunka: ', thisByte.toString(16));
            if (this.state === 'begin') {
                if (thisByte === 0x10) {
                    this.state = 'header_1';
                    this.checksum = thisByte;
                    this.start = i;
                    this.mode = 'regular';
                } else if (thisByte === 0xe0) {
                    this.state = 'alternate_header';
                    this.mode = 'alternate';
                }
            } else if (this.mode === 'regular') {
                this.parseRegular(received, thisByte, i);
            } else if (this.mode === 'alternate') {
                this.parseAlternate(received, thisByte);
            }
        }
    }

}

module.exports = { FrameParser };
