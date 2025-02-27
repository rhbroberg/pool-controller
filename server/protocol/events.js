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

class TwoWayMap {
    constructor(map) {
        this.map = map;
        this.reverseMap = {};
        for (var key in map) {
            var value = map[key];
            this.reverseMap[value] = key;
        }
    }

    fromIndex(key) { return this.map[key]; }
    fromName(key) { return this.reverseMap[key]; }
}

const controlMap = new TwoWayMap({
    '0': 'aux13', // 0x00 00 00 01
    '1': 'aux14', // 0x00 00 00 02
    '2': 'superchlorinate', // 0x00 00 00 04
    '3': 'unlock config', // 0x00 00 00 08

    // curiously, bits 4-7 are not represented

    '8': 'aux9', // 0x00 00 01 00: 'aux9',
    '9': 'aux10', // 0x00 00 02 00: 'aux10',
    '10': 'aux11', // 0x00 00 04 00: 'aux11',
    '11': 'aux12', // 0x00 00 08 00: 'aux12',

    '12': 'valve3', // 0x00 00 10 00: 'valve3',
    '13': 'valve4/heater2', // 0x00 00 20 00: 'valve4/heater2',
    '14': 'heater2', //0x00 00 40 00: 'heater1',
    '15': 'aux8', // 0x00 00 80 00: 'aux8',

    '16': 'lights', // 0x00 01 00 00: 'lights',
    '17': 'aux1', // 0x00 02 00 00: 'aux1',
    '18': 'aux2', // 0x00 04 00 00: 'aux2',
    '19': 'aux3', //0x00 08 00 00: 'aux3',

    '20': 'aux4', // 0x00 10 00 00: 'aux4',
    '21': 'aux5', // 0x00 20 00 00: 'aux5',
    '22': 'aux6', // 0x00 40 00 00: 'aux6',
    '23': 'aux7', // 0x00 80 00 00: 'aux7',

    '24': 'right', // 0x01 00 00 00: 'right',
    '25': 'menu', // 0x02 00 00 00: 'menu',
    '26': 'left', // 0x04 00 00 00: 'left',
    '27': 'off', // 0x08 00 00 00: 'off',

    '28': 'minus', // 0x10 00 00 00: 'minus',
    '29': 'plus', // 0x20 00 00 00: 'plus',
    '30': 'spillover', // 0x40 00 00 00: 'spillover',
    '31': 'filter' // 0x80 00 00 00: 'filter',
});

class Event {
    constructor(frame, header) {
        this.now = moment().valueOf();
        this.validMsb = header[0];
        this.validLsb = header[1];

        if (frame) {
            this.frame = frame;
            this.verifyEventType(this.validMsb, this.validLsb);
        } else {
            this.frame = Buffer.alloc(32, 0);
            this.frame.writeUInt8(0x10, 0);
            this.frame.writeUInt8(0x02, 1);
            this.frame.writeUInt8(this.validMsb, 2);
            this.frame.writeUInt8(this.validLsb, 3);
        }
    }

    verifyEventType(msb, lsb) {
        const isValid = ((typeof msb === 'undefined' || this.frame.readUInt8(2) === msb) &&
            (typeof lsb === 'undefined' || this.frame.readUInt8(3) == lsb)) ? true : false;
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
    constructor(frame, header) {
        super(frame, header);

        // only verify instances with valid starting data
        if (frame) {
            if (!this.verifyChecksum()) {
                throw new Error('checksum failure');
            }
        }
    }

    verifyChecksum() {
        const msb = this.frame.readUInt8(this.frame.length - 4);
        const lsb = this.frame.readUInt8(this.frame.length - 3);
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

    computeChecksum(length) {
        var checksum = 0;
        const size = length ? length : this.frame.length - 2;

        for (var i = 0; i < size - 2; i++) {
            checksum += this.frame.readUInt8(i);
        }

        return checksum;
    }

    freeze(newLength) {
        var resizedBuf = this.frame.slice(0, newLength + 2);
        this.frame = resizedBuf;
        const checksum = this.computeChecksum(); // don't checksum trailing stanza
        const msb = Math.floor(checksum / 256);
        const lsb = checksum % 256;

        logger.debug('computed checksum is ', checksum.toString(16), msb.toString(16), lsb.toString(16));

        resizedBuf.writeUInt8(msb, this.frame.length - 4);
        resizedBuf.writeUInt8(lsb, this.frame.length - 3);
        resizedBuf.writeUInt8(0x10, this.frame.length - 2);
        resizedBuf.writeUInt8(0x03, this.frame.length - 1);
        this.frame = resizedBuf;
    }

    prettyBits(wantsOn) {
        let msg = '';

        this.bitsToName((name, isOn) => {
            if (wantsOn === isOn) {
                msg += `'${name}' `;
            }
        });
        return msg;
    }

    enabledSwitches() {
        let enabled = [];

        this.bitsToName((name, isOn) => {
            if (isOn) {
                enabled.push(name);
            }
        });
        return enabled;
    }

    disabledSwitches() {
        let disabled = [];

        this.bitsToName((name, isOn) => {
            if (!isOn) {
                disabled.push(name);
            }
        });
        return disabled;
    }

    bitToInt(byte, mask) {
        return byte & mask ? 1 : 0;
    }
}

// 10 02 01 01 ckmsb cklsb
class PingEvent extends Event {
    constructor(frame) {
        super(frame, PingEvent.header());
    }

    static header() {
        return [0x01, 0x01];
    }
}

class UnidentifiedPingEvent extends ChecksummedEvent {
    constructor(frame) {
        super(frame, UnidentifiedPingEvent.header());

        this.secondByte = this.frame.readUInt8(3);
    }

    static header() {
        return [0x04];
    }
}

class UnidentifiedStatusEvent extends ChecksummedEvent {
    constructor(frame) {
        super(frame, UnidentifiedStatusEvent.header());
    }

    static header() {
        return [0x00, 0x04];
    }
}

// 10 02 01 02 ... ckmsg cklsb
class StatusEvent extends ChecksummedEvent {
    constructor(frame) {
        super(frame, StatusEvent.header());
    }

    static header() {
        return [0x01, 0x02];
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

    bitsToName(callback) {
        for (let byte = 0; byte < 4; byte++) {
            for (let bit = 0; bit < 8; bit++) {
                callback(statusMap[byte][bit], this.bitToInt(this.frame.readUInt8(byte + 4), Math.pow(2, bit)));
            }
        }
    }

    rawMask() {
        const mask = (this.frame.readUInt8(4)) +
            (this.frame.readUInt8(5) << 8) +
            (this.frame.readUInt8(6) << 16) +
            (this.frame.readUInt8(7) << 24);

        return mask;
    }

    diff(previousMask) {
        let nowEnabled = [];
        let nowDisabled = [];

        const currentMask = this.rawMask();
        const changedMask = previousMask ^ currentMask;

        for (let bitShift = 0; bitShift < 32; bitShift++) {
            const isChanged = changedMask >> bitShift;
            if (isChanged & 0x01) {
                if ((currentMask >> bitShift) & 0x01) {
                    nowEnabled.push(statusMap[Math.floor(bitShift / 8)][bitShift % 8]);
                } else {
                    nowDisabled.push(statusMap[Math.floor(bitShift / 8)][bitShift % 8]);
                }
            }
        }

        return { 'nowEnabled': nowEnabled, 'nowDisabled': nowDisabled };
    }
}

//    wireless screen update header is: 0x04, 0x0a, need message for it to be tagged (even if discarded)

// 10 02 01 03 .... ckmsb cklsb
class DisplayUpdateEvent extends ChecksummedEvent {
    constructor(frame) {
        super(frame, DisplayUpdateEvent.header());
        this.text = frame.toString('ascii', 4);
    }

    static header() {
        return [0x01, 0x03];
    }

    clearText() {
        // only what's between the header, the trailing NULL, and the checksum is interesting
        return this.frame.toString('ascii', 4, this.frame.length - 5);
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
// dox said  0x83, 0x01 but i find 0x00 0x8c
// 0x8c wireless, 0x03 keypad, 0x02 panel
class ControlEvent extends ChecksummedEvent {
    constructor(frame) {
        super(frame, ControlEvent.header());
    }

    static header() {
        return [0x00, 0x8c];
    }

    textBitMaskFromByte(byte) {
        let mask = `${this.bitToInt(byte, 0x80)}${this.bitToInt(byte, 0x40)}${this.bitToInt(byte, 0x20)}${this.bitToInt(byte, 0x10)}`;
        mask += `.${this.bitToInt(byte, 0x08)}${this.bitToInt(byte, 0x04)}${this.bitToInt(byte, 0x02)}${this.bitToInt(byte, 0x01)}`;

        return mask;
    }

    rawMask() {
        let mask = (this.frame.readUInt8(5) << 24) +
            (this.frame.readUInt8(6) << 16) +
            (this.frame.readUInt8(7) << 8) +
            (this.frame.readUInt8(8));

        return mask;
    }

    bitsToName(callback) {
        let commandBits = this.rawMask();

        logger.trace('individual command bytes are ',
            this.frame.readUInt8(5),
            this.frame.readUInt8(6),
            this.frame.readUInt8(7),
            this.frame.readUInt8(8));

        for (let bitShift = 0; bitShift < 32; bitShift++) {
            let singleBit = commandBits >> bitShift;
            callback(controlMap.fromIndex(bitShift), singleBit & 0x01);
        }
    }

    asString() {
        let msg = this.textBitMaskFromByte(this.frame.readUInt8(5));
        msg += ' ' + this.textBitMaskFromByte(this.frame.readUInt8(6));
        msg += ' ' + this.textBitMaskFromByte(this.frame.readUInt8(7));
        msg += ' ' + this.textBitMaskFromByte(this.frame.readUInt8(8));

        return msg;
    }

    // extend this class for InitiateControlEvent?

    toggleControls(toToggle) {
        let bytes = [0, 0, 0, 0];

        toToggle.forEach((s) => {
            var mask;
            const bitPosition = controlMap.fromName(s);
            mask |= (0x01 << bitPosition);
            const whichByte = Math.floor(bitPosition / 8);
            bytes[whichByte] |= ((mask >> (whichByte * 8)) & 0xff);
        });

        // write bytes to buffer
        for (let byte = 0; byte < 4; byte++)
        {
            this.frame.writeUInt8(bytes[byte], 8 - byte); // locations: 8, 7, 6, 5 (highest location is lowest byte in block)
            this.frame.writeUInt8(bytes[byte], 12 - byte); // locations 12, 11, 10, 9 (ditto)
        }
        logger.debug('created control message:', this.asString(), this.prettyBits(1));
    }

    toggleControlsAlternate(toToggle) {
        // first build the mask from each bit location
        var mask = 0;
        toToggle.forEach((s) => {
            const bitPosition = controlMap.fromName(s);
            mask |= (0x01 << bitPosition);
        });

        // set bit position indexed into each byte to be written out
        for (let byte = 0; byte < 4; byte++) {
            let thisByte = 0;
            for (let bit = 0; bit < 8; bit++) {
                thisByte |= ((mask >> (byte * 8)) & 0xff);
            }
            this.frame.writeUInt8(thisByte, 8 - byte); // locations: 8, 7, 6, 5 (highest location is lowest byte in block)
            this.frame.writeUInt8(thisByte, 12 - byte); // locations: 12, 11, 10, 9 (ditto)
        }

        logger.debug('created conrol message:', this.asString(), this.prettyBits(1));
    }

    myToHexString(buf) {
        var readable;

        for (var i = 0; i < buf.length; i++) {
            if (!readable) {
                readable = '';
            } else {
                readable += ' ';
            }
            readable += buf[i].toString(16).padStart(2, 0);
        }
        return readable;
    }

    payload() {
        this.frame.writeUInt8(0x01, 4);
        this.frame.writeUInt8(0x00, 13);
        this.freeze(16);

        logger.debug('payload is ', this.myToHexString(this.frame));
        return this.frame;
    }

}

// e0 18 80 e6 18 9e e0 1e 80
class MotorTelemetryEvent extends Event {
    constructor(frame) {
        super(frame, MotorTelemetryEvent.header());
    }

    static header() {
        return [0xe0, 0x18];
    }
}

/*
    a block of non-toggle commands from an internet discussion?  will have to investigate
// 10 02 00 8c 01 00 01 00 00 00 01 00 00 00 00 a1 10 03
    /*
    Here is the strings that work for my controller, they were a little different then what you are using.

Filter
10 2 0 5 2 0 2 0 7F 0 9A 10 3 On
10 2 0 5 0 2 0 2 7F 0 9A 10 3 Off

Lights
10 2 0 5 20 0 20 0 7F 0 D6 10 3 On
10 2 0 5 0 20 0 20 7F 0 D6 10 3 Off

Cleaner
10 2 0 5 10 0 0 10 0 0 7F 0 B6 10 3 On
10 2 0 5 0 10 0 0 10 0 7F 0 B6 10 3 off

Waterfall
10 2 0 5 8 0 8 0 7F 0 A6 10 3 On
10 2 0 5 0 8 0 8 7F 0 A6 10 3 Off

// example of lights-on
// payload = new Buffer([0x10, 0x2, 0x00, 0x05, 0x20, 0x00, 0x20, 0x00, 0x7F, 0x00, 0xD6, 0x10, 0x03]);

*/

module.exports = { PingEvent, DisplayUpdateEvent, StatusEvent, MotorTelemetryEvent, ControlEvent, UnidentifiedPingEvent, UnidentifiedStatusEvent };
