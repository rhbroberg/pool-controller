'use strict';

const log4js = require('log4js');
const moment = require('moment');

var logger = log4js.getLogger();

const statusMap = [
    ['heater1', 'valve3', 'check system', 'pool', 'spa', 'filter', 'lights', 'aux1'],
    ['unknown2.1', 'unknown2.2', 'aux3', 'aux4', 'aux5', 'unknown2.6', 'valve4', 'unknown2.8'],
    ['unknown3.1', 'unknown3.2', 'unknown3.3', 'unknown3.4', 'unknown3.5', 'unknown3.6', 'unknown3.7', 'unknown3.8'],
    ['aux14', 'superchlorinate', 'unknown4.3', 'unknown4.4', 'unknown4.5', 'unknown4.6', 'unknown4.7', 'unknown4.8']
];

const controlMap = {
    0: 'aux13', // 0x00 00 00 01
    1: 'aux14', // 0x00 00 00 02
    2: 'superchlorinate', // 0x00 00 00 04
    3: 'unlock config', // 0x00 00 00 08

    // curiously, bits 4-7 are not represented

    8: 'aux9', // 0x00 00 01 00: 'aux9',
    9: 'aux10', // 0x00 00 02 00: 'aux10',
    10: 'aux11', // 0x00 00 04 00: 'aux11',
    11: 'aux12', // 0x00 00 08 00: 'aux12',

    12: 'valve3', // 0x00 00 10 00: 'valve3',
    13: 'valve4/heater2', // 0x00 00 20 00: 'valve4/heater2',
    14: 'heater2', //0x00 00 40 00: 'heater1',
    15: 'aux8', // 0x00 00 80 00: 'aux8',

    16: 'lights', // 0x00 01 00 00: 'lights',
    17: 'aux1', // 0x00 02 00 00: 'aux1',
    18: 'aux2', // 0x00 04 00 00: 'aux2',
    19: 'aux3', //0x00 08 00 00: 'aux3',

    20: 'aux4', // 0x00 10 00 00: 'aux4',
    21: 'aux5', // 0x00 20 00 00: 'aux5',
    22: 'aux6', // 0x00 40 00 00: 'aux6',
    23: 'aux7', // 0x00 80 00 00: 'aux7',

    24: 'right', // 0x01 00 00 00: 'right',
    25: 'menu', // 0x02 00 00 00: 'menu',
    26: 'left', // 0x04 00 00 00: 'left',
    27: 'off', // 0x08 00 00 00: 'off',

    28: 'minus', // 0x10 00 00 00: 'minus',
    29: 'plus', // 0x20 00 00 00: 'plus',
    30: 'spillover', // 0x40 00 00 00: 'spillover',
    31: 'filter' // 0x80 00 00 00: 'filter',
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

        for (let byte = 0; byte < 4; byte++) {
            for (let bit = 0; bit < 8; bit++) {
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

    getHeater1() {
        return this.extractValue(/ +Heater1 +Manual +([^ ]+)/);
    }

    getCheckSystem() {
        return this.extractValue(/ +Check System +(.+)$/);
    }
}

// 10 02 00 83 01 [xx yy zz aa] [xx yy zz aa] 00 ckmsb cklsb
class ControlEvent extends ChecksummedEvent {
    constructor(frame) {
        super(frame, undefined, undefined);
    }

    prettyOnBits() {
        var msg = '';
        let commandBits = this.frame.readUInt8(5) * Math.pow(2, 24) +
            this.frame.readUInt8(6) * Math.pow(2, 16) +
            this.frame.readUInt8(7) * Math.pow(2, 8) +
            this.frame.readUInt8(8);

        logger.trace('individual command bytes are ',
            this.frame.readUInt8(5),
            this.frame.readUInt8(6),
            this.frame.readUInt8(7),
            this.frame.readUInt8(8));

        for (let bitShift = 0; bitShift < 32; bitShift++) {
            let singleBit = commandBits >> bitShift;
            if (singleBit & 0x01) {
                msg += `${controlMap[bitShift]} `;
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
