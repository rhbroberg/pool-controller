'use strict';
const log4js = require('log4js');

var logger = log4js.getLogger();

class FrameParser {

    constructor() {
        this.state = 'begin';
        this.start = 0;
        this.bufferIndex = 0;
        this.mode = 'none';

        this.payload = new Buffer.allocUnsafe(128);
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
                this.payload.writeUInt8(thisByte, this.bufferIndex++);
            }
        } else if (this.state === 'in_body') {
            if ((thisByte === 0x03) && (this.payload.readUInt8(this.bufferIndex - 1) === 0x10)) {
                this.bufferIndex -= 1; // back up the sub-termination char

                logger.debug('complete message length ', this.bufferIndex);
                logger.trace('contents ', toString(this.payload, this.bufferIndex));
                received(this.payload, this.bufferIndex);
                this.bufferIndex = 0;
                this.state = 'begin';
            }
            else {
                this.payload.writeUInt8(thisByte, this.bufferIndex++);
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
                    this.start = i;
                    this.mode = 'regular';
                    this.bufferIndex = 0;
                    this.payload.writeUInt8(thisByte, this.bufferIndex++);
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
