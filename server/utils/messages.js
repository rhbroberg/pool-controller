const log4js = require('log4js');
const moment = require('moment');

var logger = log4js.getLogger();

class Event {
    constructor(message, validMsb, validLsb) {
        if (validLsb && validMsb) {
            this.verifyMessageType(message, validMsb, validLsb);
        }
        this.message = message;
        this.now = moment().valueOf();
    }

    verifyMessageType(message, msb, lsb) {
        const isValid = (message.readUInt8(0) === msb && message.readUInt8(1) == lsb) ? true : false;
        if (!isValid) {
            let woe = `wrong message type created: (${message.readUInt8(0)}, ${message.readUInt8(1)} != (${msb}, ${lsb}) `;
            logger.error(woe);
            throw new Error(woe);
        }
    }
}

// 01 01 ... <terminator>
class PingEvent extends Event {
    constructor(message) {
        super(message, 0x01, 0x01);
    }
}

// 01 02 ... <terminator>
class StatusEvent extends Event {
    constructor(message) {
        super(message, 0x01, 0x02);

        this.lookup = [
            ['heater1', 'valve3', 'check system', 'pool', 'spa', 'filter', 'lights', 'aux1'],
            ['unknown2.1', 'unknown2.2', 'aux3', 'aux4', 'unknown2.5', 'unknown2.6', 'valve4', 'unknown2.8'],
            ['unknown3.1', 'unknown3.2', 'unknown3.3', 'unknown3.4', 'unknown3.5', 'unknown3.6', 'unknown3.7', 'unknown3.8'],
            ['unknown4.1', 'unknown4.2', 'unknown4.3', 'unknown4.4', 'unknown4.5', 'unknown4.6', 'unknown4.7', 'unknown4.8']
        ];
    }

    bitToInt(byte, mask) {
        return byte & mask ? 1 : 0;
    }

    textBitMaskFromByte(byte) {
        let mask = `${this.bitToInt(byte, 0x01)}${this.bitToInt(byte, 0x02)}${this.bitToInt(byte, 0x04)}${this.bitToInt(byte, 0x08)}`;
        mask += `.${this.bitToInt(byte, 0x10)}${this.bitToInt(byte, 0x20)}${this.bitToInt(byte, 0x40)}${this.bitToInt(byte, 0x80)}`;

        return mask;
    }

    printAllBits() {
        let msg = this.textBitMaskFromByte(this.message.readUInt8(2));
        msg += ' ' + this.textBitMaskFromByte(this.message.readUInt8(3));
        msg += ' ' + this.textBitMaskFromByte(this.message.readUInt8(4));
        msg += ' ' + this.textBitMaskFromByte(this.message.readUInt8(5));

        return msg;
    }

    prettyOnBits() {
        let msg = '';

        for (let byte = 0; byte < 3; byte++) {
            for (let bit = 0; bit < 7; bit++) {
                if (this.bitToInt(this.message.readUInt8(byte + 2), Math.pow(2, bit))) {
                    msg += `'${this.lookup[byte][bit]}' `;
                }
            }
        }
        return msg;
    }
}

// 01 03 .... <terminator>
class DisplayUpdateEvent extends Event {
    constructor(message) {
        super(message, 0x01, 0x03);
        this.text = message.toString('ascii', 2);
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
        return this.extractValue(/ +SPA Temp +(\d+)_F/);
    }
}

// ....
class ControlEvent extends Event {
    constructor(message) {
        super(message, undefined, undefined);
    }

}

// e0 18 80 e6 18 9e e0 1e 80
class MotorTelemetryEvent extends Event {
    constructor(message) {
        super(message, undefined, undefined);
    }

}

// remote control display
// 04 0a ... checksum terminator


module.exports = { PingEvent, DisplayUpdateEvent, StatusEvent, MotorTelemetryEvent, ControlEvent };
