'use strict';
const log4js = require('log4js');

var logger = log4js.getLogger();

const DLE = 0x10;
const STX = 0x02;
const ETX = 0x03;
// longer than any frame the controller sends; a lost end marker can't run past it
const MAX_FRAME = 256;

/**
 * a frame as it goes on the bus: inside the body a 0x10 is sent as 10 00, so only 10 02 and
 * 10 03 mark a frame's start and end. The checksum covers the bytes before this escaping.
 **/
var stuff = (frame) => {
    const out = [frame[0], frame[1]];
    for (let i = 2; i < frame.length - 2; i++) {
        out.push(frame[i]);
        if (frame[i] === DLE) {
            out.push(0x00);
        }
    }
    out.push(frame[frame.length - 2], frame[frame.length - 1]);
    return Buffer.from(out);
};

class FrameParser {

    constructor() {
        this.state = 'begin';
        this.start = 0;
        this.bufferIndex = 0;
        this.wireIndex = 0;
        // the last byte was a 0x10 that hasn't been matched with what follows it yet
        this.escaped = false;
        this.subParser;
        this.parseErrors = 0;

        this.payload = Buffer.allocUnsafe(MAX_FRAME);
        this.wire = Buffer.allocUnsafe(MAX_FRAME * 2);
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

    append(thisByte) {
        if (this.bufferIndex >= MAX_FRAME) {
            logger.error(`frame longer than ${MAX_FRAME} bytes; dropping it`);
            this.state = 'begin';
            this.parseErrors++;
            return false;
        }
        this.payload.writeUInt8(thisByte, this.bufferIndex++);
        return true;
    }

    /**
     * hands received the frame with the bus's escaping undone, its length, and the bytes as they
     * arrived, which is what gets stored
     **/
    parseRegular(received, thisByte, i) {
        if (this.state === 'header') {
            if ((thisByte === STX) && (this.payload.readUInt8(0) == DLE)) {
                this.state = 'body';
                this.payload.writeUInt8(thisByte, this.bufferIndex++);
                this.wire.writeUInt8(thisByte, this.wireIndex++);
            } else {
                logger.error(`header parse error: expected 0x02 after 0x10, but got ${thisByte}`);
                this.state = 'begin';
                this.parseErrors++;
            }
        } else if (this.state === 'body') {
            this.wire.writeUInt8(thisByte, this.wireIndex++);
            if (this.escaped) {
                this.escaped = false;
                if (thisByte === 0x00) {
                    // the 0x10 before it was data
                    return;
                }
                if (thisByte === ETX) {
                    if (this.append(thisByte)) {
                        logger.debug('complete message length (including terminator)', this.bufferIndex);
                        logger.trace('contents ', this.toHexString());
                        received(this.payload.slice(0, this.bufferIndex), this.bufferIndex, Buffer.from(this.wire.subarray(0, this.wireIndex)));
                        this.state = 'begin';
                    }
                    return;
                }
            }
            if (this.append(thisByte) && thisByte === DLE) {
                this.escaped = true;
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
                if (thisByte === DLE) {
                    this.state = 'header';
                    this.start = i;
                    this.subParser = this.parseRegular;
                    this.bufferIndex = 0;
                    this.wireIndex = 0;
                    this.escaped = false;
                    this.payload.writeUInt8(thisByte, this.bufferIndex++);
                    this.wire.writeUInt8(thisByte, this.wireIndex++);
                } else if (thisByte === 0xe0) {
                    // commented this out during field testing; an error in the bitstream caused
                    // runaway parsing to not recognize 'regular' frames.  must re-think how this works
                    //   this.state = 'alternate_header';
                    //   this.subParser = this.parseMotorTelemetry;
                }
            } else {
                this.subParser(received, thisByte, i);
            }
        }
    }

}

/**
 * the frames in bytes as they came off the bus, such as an event's stored raw: each as
 * { frame, wire }, with the escaping undone in frame
 **/
var framesIn = (bytes) => {
    const parser = new FrameParser();
    const frames = [];
    parser.parse(bytes, (frame, length, wire) => frames.push({ frame: Buffer.from(frame), wire }));
    return frames;
};

module.exports = { FrameParser, stuff, framesIn };
