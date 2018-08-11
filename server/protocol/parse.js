'use strict';
const log4js = require('log4js');

var logger = log4js.getLogger();

class FrameParser {

    constructor() {
        this.state = 'begin';
        this.start = 0;
        this.bufferIndex = 0;
        this.subParser;
        this.parseErrors = 0;

        this.payload = new Buffer.allocUnsafe(128);
    }

    toHexString() {
        var readable;

        for (var i = 0; i < this.bufferIndex; i++) {
            if (!readable) {
                readable = '';
            } else {
                readable += ' ';
            }
            readable += this.payload[i].toString(16).padStart(2, 0);
        }
        return readable;
    }

    parseRegular(received, thisByte, i) {
        if (this.state === 'header') {
            if ((thisByte === 0x02) && (this.payload.readUInt8(0) == 0x10)) {
                this.state = 'body';
                this.payload.writeUInt8(thisByte, this.bufferIndex++);
            } else {
                logger.error(`header parse error: expected 0x02 after 0x10, but got ${thisByte}`);
                this.state = 'begin';
                this.parseErrors++;
            }
        } else if (this.state === 'body') {
            if ((thisByte === 0x03) && (this.payload.readUInt8(this.bufferIndex - 1) === 0x10)) {
                this.bufferIndex -= 1; // back up the sub-termination char

                logger.debug('complete message length ', this.bufferIndex);
                logger.trace('contents ', this.toHexString());
                received(this.payload.slice(0, this.bufferIndex), this.bufferIndex);
                this.state = 'begin';
            }
            else {
                this.payload.writeUInt8(thisByte, this.bufferIndex++);
            }
        }
        else {
            logger.error(`parse error: state ${this.state}, byte ${thisByte.toString(16)}, index ${i} `);
            logger.error(this.toHexString(this.payload, this.bufferIndex));
            this.state = 'begin';
            this.parseErrors++;
        }
    }

    parseMotorTelemetry(received, thisByte) {
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
                received(this.payload.slice(0, this.bufferIndex), this.bufferIndex);
                this.state = 'begin';
                this.bufferIndex = 0;
            }
        }
    }

    parse(hunk, received) {
        for (var i = 0; i < hunk.length; i++) {
            let thisByte = hunk[i];
            logger.trace('byte: ', thisByte.toString(16));
            if (this.state === 'begin') {
                if (thisByte === 0x10) {
                    this.state = 'header';
                    this.start = i;
                    this.subParser = this.parseRegular;
                    this.bufferIndex = 0;
                    this.payload.writeUInt8(thisByte, this.bufferIndex++);
                } else if (thisByte === 0xe0) {
                    this.state = 'alternate_header';
                    this.subParser = this.parseMotorTelemetry;
                }
            } else {
                this.subParser(received, thisByte, i);
            }
        }
    }

}

module.exports = { FrameParser };
