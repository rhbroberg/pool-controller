'use strict';

// move the code from .register in each class to the constructor here instead
class EventFactory {

    constructor() {
        this.twoByteEvents = {};
        this.oneByteEvents = {};
    }

    registerEvent(header, creator) {
        if (typeof header[1] != 'undefined') {
            const key = `${header[0]}, ${header[1]}`;
            this.twoByteEvents[key] = creator;
        } else {
            const key = `${header[0]}`;
            this.oneByteEvents[key] = creator;
        }
    }

    create(buf) {
        const msb = buf.readUInt8(2);
        const lsb = buf.readUInt8(3);
        let event = this.twoByteEvents[`${msb}, ${lsb}`];

        if (event) {
            return event(buf);
        } else {
            // try the one-byte events
            event = this.oneByteEvents[`${msb}`];
            if (event) {
                return event(buf);
            }
        }
    }
}

module.exports = { EventFactory };
