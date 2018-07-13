'use strict';

const log4js = require('log4js');
const moment = require('moment');

var logger = log4js.getLogger();

const statusMap = [
    ['heater1', 'valve3', 'check system', 'pool', 'spa', 'filter', 'lights', 'aux1'],
    ['unknown2.1', 'unknown2.2', 'aux3', 'aux4', 'unknown2.5', 'unknown2.6', 'valve4', 'unknown2.8'],
    ['unknown3.1', 'unknown3.2', 'unknown3.3', 'unknown3.4', 'unknown3.5', 'unknown3.6', 'unknown3.7', 'unknown3.8'],
    ['unknown4.1', 'unknown4.2', 'unknown4.3', 'unknown4.4', 'unknown4.5', 'unknown4.6', 'unknown4.7', 'unknown4.8']
];

const controlMap = {

    0x01000000: 'right',
    0x02000000: 'menu',
    0x04000000: 'left',
    0x08000000: 'off',

    0x10000000: 'minus',
    0x20000000: 'plus',
    0x40000000: 'spillover',
    0x80000000: 'filter',

    0x00010000: 'lights',
    0x00020000: 'aux1',
    0x00040000: 'aux2',
    0x00080000: 'aux3',

    0x00100000: 'aux4',
    0x00200000: 'aux5',
    0x00400000: 'aux6',
    0x00800000: 'aux7',

    0x00001000: 'valve3',
    0x00002000: 'valve4/heater2',
    0x00004000: 'heater1',
    0x00008000: 'aux8',

    0x00000100: 'aux9',
    0x00000200: 'aux10',
    0x00000400: 'aux11',
    0x00000800: 'aux12',

    0x00000001: 'aux13',
    0x00000002: 'aux14',
    0x00000004: 'superchlorinate',
    0x00000008: 'unlock config'
};

class Event {
    constructor(frame, validMsb, validLsb) {
        this.frame = frame;
        this.now = moment().valueOf();

        if (validLsb && validMsb) {
            this.verifyEventType(validMsb, validLsb);
        }
    }

    verifyEventType(msb, lsb) {
        const isValid = (this.frame.readUInt8(2) === msb && this.frame.readUInt8(3) == lsb) ? true : false;
        if (!isValid) {
            const woe = `wrong message type created: (${this.frame.readUInt8(2)}, ${this.frame.readUInt8(3)} != (${msb}, ${lsb}) `;
            logger.error(woe);
            throw new Error(woe);
        }
    }

    toHexString() {
        return this.frame.toHexString();
    }
}

class ChecksummedEvent extends Event {
    constructor(frame) {
        super(frame);

        if (!this.verifyChecksum()) {
            throw new Error('checksum failure');
        }
    }

    verifyChecksum() {
        const msb = this.frame.readUInt8(this.frame.length - 2);
        const lsb = this.frame.readUInt8(this.frame.length - 1);
        const messageChecksum = msb * 256 + lsb;

        logger.trace(`msb ${msb} and lsb ${lsb}`);

        const computedChecksum = this.computeChecksum();
        if (messageChecksum !== computedChecksum) {
            logger.error(`checksum mismatch: found ${messageChecksum.toString(16)}, computed ${computedChecksum.toString(16)}; ${msb} ${lsb}`);
            logger.error('message: ', this.frame.toString());
            return false;
        }
        return true;
    }

    computeChecksum() {
        var checksum = 0;

        for (var i = 0; i < this.frame.length - 2; i++) {
            checksum += this.frame.readUInt8(i);
        }
        return checksum;
    }
}

// 10 02 01 01 ckmsb cklsb
class PingEvent extends Event {
    constructor(frame) {
        super(frame, 0x01, 0x01);
    }
}

// 10 02 01 02 ... ckmsg cklsb
class StatusEvent extends ChecksummedEvent {
    constructor(frame) {
        super(frame, 0x01, 0x02);
    }

    bitToInt(byte, mask) {
        return byte & mask ? 1 : 0;
    }

    textBitMaskFromByte(byte) {
        let mask = `${this.bitToInt(byte, 0x01)}${this.bitToInt(byte, 0x02)}${this.bitToInt(byte, 0x04)}${this.bitToInt(byte, 0x08)}`;
        mask += `.${this.bitToInt(byte, 0x10)}${this.bitToInt(byte, 0x20)}${this.bitToInt(byte, 0x40)}${this.bitToInt(byte, 0x80)}`;

        return mask;
    }

    asString() {
        let msg = this.textBitMaskFromByte(this.frame.readUInt8(4));
        msg += ' ' + this.textBitMaskFromByte(this.frame.readUInt8(5));
        msg += ' ' + this.textBitMaskFromByte(this.frame.readUInt8(6));
        msg += ' ' + this.textBitMaskFromByte(this.frame.readUInt8(7));

        return msg;
    }

    prettyOnBits() {
        let msg = '';

        for (let byte = 0; byte < 3; byte++) {
            for (let bit = 0; bit < 7; bit++) {
                if (this.bitToInt(this.frame.readUInt8(byte + 4), Math.pow(2, bit))) {
                    msg += `'${statusMap[byte][bit]}' `;
                }
            }
        }
        return msg;
    }
}

// 10 02 01 03 .... ckmsb cklsb
class DisplayUpdateEvent extends ChecksummedEvent {
    constructor(frame) {
        super(frame, 0x01, 0x03);
        this.text = frame.toString('ascii', 4);
    }

    clearText() {
        // only what's between the header, the trailing NULL, and the checksum is interesting
        return this.frame.toString('ascii', 4, this.frame.length - 3);
    }

    extractValue(clause) {
        const match = this.text.match(clause);
        return match ? match[1] : undefined;
    }

    getSaltPPM() {
        return this.extractValue(/ +Salt Level +(\d+) PPM/);
    }

    getAmbientTemp() {
        return this.extractValue(/ +Air Temp +(\d+)_F/);
    }

    getPoolTemp() {
        return this.extractValue(/ +Pool Temp +(\d+)_F/);
    }

    getSpaTemp() {
        return this.extractValue(/ +Spa Temp +(\d+)_F/);
    }
}

// 10 02 00 83 01 [xx yy zz aa] [xx yy zz aa] 00 ckmsb cklsb
class ControlEvent extends ChecksummedEvent {
    constructor(frame) {
        super(frame, undefined, undefined);
    }

    prettyOnBits() {
        var msg = '';
        for (var byte = 5; byte < 9; byte++) {
            for (var key in controlMap) {
                if ((key && byte) != 0) {
                    msg += `${controlMap[key]} `;
                }
            }
        }
        return msg;
    }
}

// e0 18 80 e6 18 9e e0 1e 80
class MotorTelemetryEvent extends Event {
    constructor(frame) {
        super(frame, undefined, undefined);
    }

}

module.exports = { PingEvent, DisplayUpdateEvent, StatusEvent, MotorTelemetryEvent, ControlEvent };
