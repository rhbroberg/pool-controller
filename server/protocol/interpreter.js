'use strict';
// What the server stores for each frame from the controller. Readings and switches are stored only
// when they change, so what a frame means depends on the frames before it; this keeps that state.
// The live controller and reprocessing of stored history share it, so both store the same things.

const { StatusEvent } = require('./events');

// the readings the display shows; the pool, spa and air start unknown rather than absent
const READINGS = { poolTemp: 'pool temp', spaTemp: 'spa temp', salt: 'salt', ambientTemp: 'ambient' };
const UNKNOWN = -1;
const HEATER_MODE = 'heater1 mode';

var isTextDisplay = (event) => event && typeof event.getPoolTemp === 'function' && typeof event.getHeater1Mode === 'function';

class FrameInterpreter {
    constructor() {
        this.reset();
    }

    /** forgets what has been seen, so the next frames are stored as new history */
    reset() {
        this.present = { 'pool temp': UNKNOWN, 'spa temp': UNKNOWN, 'ambient': UNKNOWN };
        this.previous = { 'pool temp': UNKNOWN, 'spa temp': UNKNOWN, 'ambient': UNKNOWN };
        this.statusMask = 0;
        this.enabledSwitches = [];
        // 1 for auto, 0 for off, undefined until the panel displays the heater line
        this.heaterAuto = undefined;
    }

    /**
     * starts from what history last recorded: readings by name, the switches that were on, and
     * the heater's mode
     **/
    seed({ readings = {}, switchesOn = [], heaterAuto } = {}) {
        this.reset();
        Object.entries(readings).forEach(([name, value]) => {
            if (typeof value === 'number') {
                this.present[name] = value;
            }
        });
        switchesOn.forEach((name) => {
            const bit = StatusEvent.bitPosition(name);
            if (typeof bit !== 'undefined') {
                this.statusMask = (this.statusMask | (1 << bit)) | 0;
            }
        });
        this.heaterAuto = heaterAuto;
    }

    // a one-degree bounce back to the reading before is the sensor flickering, not a change
    addIfChanged(changes, text, name) {
        if (!text) {
            return;
        }
        const value = Number(text);
        if (this.present[name] !== value) {
            const flicker = typeof this.previous[name] !== 'undefined' && value === this.previous[name] && Math.abs(this.present[name] - value) === 1;
            if (!flicker) {
                changes.push({ name, value });
                this.previous[name] = this.present[name];
            }
        }
        this.present[name] = value;
    }

    /**
     * what to store for an event the factory made: { eventType, status }, or null when it changes
     * nothing. A status frame also says which switches went on and off
     **/
    interpret(event) {
        if (isTextDisplay(event)) {
            const changes = [];
            const heaterMode = event.getHeater1Mode();
            if (typeof heaterMode !== 'undefined') {
                const auto = /Off$/.test(heaterMode) ? 0 : 1;
                if (auto !== this.heaterAuto) {
                    this.heaterAuto = auto;
                    changes.push({ name: HEATER_MODE, value: auto });
                }
            }
            this.addIfChanged(changes, event.getPoolTemp(), READINGS.poolTemp);
            this.addIfChanged(changes, event.getSpaTemp(), READINGS.spaTemp);
            this.addIfChanged(changes, event.getSaltPPM(), READINGS.salt);
            this.addIfChanged(changes, event.getAmbientTemp(), READINGS.ambientTemp);
            return changes.length ? { eventType: 'info', status: changes } : null;
        }
        if (event instanceof StatusEvent) {
            const diffs = event.diff(this.statusMask);
            this.statusMask = event.rawMask();
            this.enabledSwitches = event.enabledSwitches();
            if (diffs.nowEnabled.length === 0 && diffs.nowDisabled.length === 0) {
                return null;
            }
            const status = diffs.nowEnabled.map((name) => ({ name, value: 1 }))
                .concat(diffs.nowDisabled.map((name) => ({ name, value: 0 })));
            return { eventType: 'status', status, diffs };
        }
        if (event && event.constructor.name === 'ControlEvent') {
            const pressed = event.enabledSwitches();
            return pressed.length ? { eventType: 'control', status: pressed.map((name) => ({ name, value: 1 })) } : null;
        }
        return null;
    }

    /**
     * follows an event already stored as it is, as if this had decided to store it
     **/
    adopt(eventType, status) {
        for (const entry of status || []) {
            if (typeof entry.value !== 'number') {
                continue;
            }
            if (eventType === 'info' && entry.name === HEATER_MODE) {
                this.heaterAuto = entry.value;
            } else if (eventType === 'info') {
                this.previous[entry.name] = this.present[entry.name];
                this.present[entry.name] = entry.value;
            } else if (eventType === 'status') {
                const bit = StatusEvent.bitPosition(entry.name);
                if (typeof bit !== 'undefined') {
                    this.statusMask = (entry.value ? (this.statusMask | (1 << bit)) : (this.statusMask & ~(1 << bit))) | 0;
                }
            }
        }
    }
}

module.exports = { FrameInterpreter, isTextDisplay, HEATER_MODE };
