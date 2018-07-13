const log4js = require('log4js');
var logger = log4js.getLogger();

var verifyMessageType = (message, msb, lsb) => {
    const isValid = (message.readUInt8(0) === msb && message.readUInt8(1) == lsb) ? true : false;
    if (!isValid) {
        logger.error(`wrong message type created: (${message.readUInt8(0)}, ${message.readUInt8(1)} != (${msb}, ${lsb}) `);
        throw new Error('');
    }
};

// 01 01 ... <terminator>
class PingEvent {
    constructor(message) {
        verifyMessageType(message, 0x01, 0x01);
    }
}

// 01 02 ... <terminator>
class StatusEvent {
    constructor(message) {
        verifyMessageType(message, 0x01, 0x02);
        this.message = message;

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
class DisplayUpdateEvent {
    constructor(message) {
        verifyMessageType(message, 0x01, 0x03);
        this.message = message;
        this.text = message.toString('ascii', 2);
    }

    // return 3100
    getSaltPPM() {
        const match = this.text.match(/ +Salt Level +(\d+) PPM/);
        if (match) {
            return match[1];
        }
    }

    // return 78;
    getAmbientTemp() {
        const match = this.text.match(/ +Air Temp +(\d+)_F/);
        if (match) {
            return match[1];
        }
    }

    getPoolTemp() {
        return 82;
    }

    getSpaTemp() {
        return 104;
    }
}

// ....
class ControlEvent {
    constructor() {

    }
}

// e0 18 80 e6 18 9e e0 1e 80
class MotorTelemetryEvent {
    constructor() {

    }
}

// remote control display
// 04 0a ... checksum terminator


module.exports = { PingEvent, DisplayUpdateEvent, StatusEvent, MotorTelemetryEvent, ControlEvent };
