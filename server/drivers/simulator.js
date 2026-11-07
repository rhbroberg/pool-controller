// Stands in for the pool controller: replays a capture like the tail driver, but owns the
// switch state so control writes from the REST API take effect.
const fs = require('fs');
const log4js = require('log4js');
const { FrameParser } = require('../protocol/parse');
const { EventFactory } = require('../protocol/eventfactory');
const { StatusEvent, ControlEvent, panelLabels } = require('../protocol/events');
const heating = require('../protocol/heating');
var logger = log4js.getLogger();

const FRAME_INTERVAL_MS = 25;
const RESPONSE_DELAY_MS = 100;
// the simulator has no panel menus; it acknowledges a navigation key on the display instead
const KEY_ECHO_MS = 4000;
const panelKeyLabels = { menu: 'MENU', left: '< LEFT', right: 'RIGHT >', minus: '- DOWN', plus: '+ UP' };

// in sample-various-bin, the aux14 (spa filter) key brings valve3 and aux1 on and off with it
const linkedSwitches = {
    aux14: ['valve3', 'aux1']
};
// the captures never show a spa temperature and rarely the pool's; the simulator shows the pool
// temperature, and the spa's while the spa filter runs, this often
const SPA_TEMP_EVERY_MS = 5000;
// the heater in auto fires, and the heat pump (valve4) runs at half its rate, while the water they
// drive toward is below their setpoint for it; with neither heating, the water cools
const TEMP_STEP_MS = 30 * 1000;
const HEAT_PUMP_STEPS_PER_DEGREE = 2;
const SPA_COOLS_TO_F = 90;
const POOL_COOLING_STEPS = 4;
// the panel announces a labelled output changing as "<label> / Turned On"
const switchMessages = panelLabels;

var frames = [];
var statusTemplate;
var displayTemplate;
var switchMask = 0;
var heaterAuto = false;
var echoUntil = 0;
var spaTempShownAt = 0;
var temperaturesShown = 0;
var poolTempF;
var spaTempF = 98;
var tempSteps = 0;
var emit;
// the controller keeps a setpoint per body for each device; these are the simulator's
var setpointValues = {
    pool: { heater1: 84, heatpump: 82 },
    spa: { heater1: 102, heatpump: 100 }
};

var isOn = (name) => ((switchMask >>> StatusEvent.bitPosition(name)) & 1) === 1;

var loadCapture = (filename) => {
    const parser = new FrameParser();
    const factory = new EventFactory();
    parser.parse(fs.readFileSync(filename), (buf) => {
        const frame = Buffer.from(buf);
        let event;
        try {
            event = factory.create(frame);
        } catch {
            return; // drop frames that fail their checksum
        }
        if (!event) {
            return;
        }
        const kind = event.constructor.name;
        if (kind === 'ControlEvent' && event.enabledSwitches().length > 0) {
            return; // recorded keypresses would fight the simulated state
        }
        if (kind === 'StatusEvent' && !statusTemplate) {
            statusTemplate = frame;
            switchMask = event.rawMask() >>> 0;
        }
        // 4 header bytes, 40 characters, a NUL, the checksum and the trailer
        if (kind === 'DisplayUpdateEvent' && !displayTemplate && frame.length === 49) {
            displayTemplate = frame;
        }
        const display = kind === 'DisplayUpdateEvent';
        const poolTemp = display ? event.getPoolTemp() : undefined;
        if (typeof poolTemp !== 'undefined' && typeof poolTempF === 'undefined') {
            poolTempF = Number(poolTemp);
        }
        frames.push({
            kind,
            frame,
            heater: display && typeof event.getHeater1Mode() !== 'undefined',
            pool: typeof poolTemp !== 'undefined'
        });
    });
    if (!statusTemplate) {
        throw new Error(`${filename} has no status frames to start from`);
    }
};

var writeChecksum = (frame) => {
    let checksum = 0;
    for (let i = 0; i < frame.length - 4; i++) {
        checksum += frame.readUInt8(i);
    }
    frame.writeUInt16BE(checksum, frame.length - 4);
    return frame;
};

var statusFrame = () => {
    updateHeaters();
    const frame = Buffer.from(statusTemplate);
    frame.writeUInt32LE(switchMask >>> 0, 4);
    return writeChecksum(frame);
};

var centered = (text, width) => {
    const left = Math.max(0, Math.floor((width - text.length) / 2));
    return (' '.repeat(left) + text).padEnd(width).slice(0, width);
};

// two 20 character lines, laid out like the panel's own display frames
var displayFrame = (line1, line2) => {
    const frame = Buffer.from(displayTemplate);
    const text = centered(line1, 20) + centered(line2, 20);
    frame.write(text, 4, 40, 'ascii');
    return writeChecksum(frame);
};

var heaterFrame = () => displayFrame('Heater1', heaterAuto ? 'Auto Control' : 'Manual Off');

var setSwitch = (name, on) => {
    const bit = 1 << StatusEvent.bitPosition(name);
    switchMask = on ? (switchMask | bit) >>> 0 : (switchMask & ~bit) >>> 0;
};

// the spillover key steps the water flow through these, setting the matching status bit
const WATER_MODES = ['pool', 'spa', 'spillover'];

var waterMode = () => WATER_MODES.find((mode) => mode !== 'pool' && isOn(mode)) || 'pool';

var stepWaterMode = () => {
    const next = WATER_MODES[(WATER_MODES.indexOf(waterMode()) + 1) % WATER_MODES.length];
    WATER_MODES.forEach((mode) => setSwitch(mode, mode === next));
    logger.debug(`simulator: water flow is now ${next}`);
    return next;
};

// the heater and heat pump are in series, so both warm the same water: both bodies in
// spillover, the spa in spa mode, and in pool mode the spa if its filter runs, else the pool
var heatedBodies = () => {
    const mode = waterMode();
    if (mode === 'spillover') {
        return ['pool', 'spa'];
    }
    return mode === 'spa' || isOn('aux14') ? ['spa'] : ['pool'];
};

var targetBody = () => heating.targetBody({ filter: isOn('filter'), spaFilter: isOn('aux14'), waterMode: waterMode() });

var callsForHeat = (device) => {
    const body = targetBody();
    return Boolean(body) && heating.callsForHeat(body === 'spa' ? spaTempF : poolTempF, setpointValues[body][device]);
};

// the heater1 status bit is the heater firing, which it does in auto while its water is below the
// setpoint; the heat pump has no bit of its own, so only its heat shows
var updateHeaters = () => {
    const heaterFiring = heaterAuto && callsForHeat('heater1');
    const heatPumpRunning = isOn('valve4') && callsForHeat('heatpump');
    setSwitch('heater1', heaterFiring);
    return { heaterFiring, heatPumpRunning };
};

var stepTemperatures = () => {
    tempSteps++;
    const { heaterFiring, heatPumpRunning } = updateHeaters();
    if (heaterFiring || heatPumpRunning) {
        const gain = heaterFiring || tempSteps % HEAT_PUMP_STEPS_PER_DEGREE === 0 ? 1 : 0;
        const heated = heatedBodies();
        if (heated.includes('spa')) {
            spaTempF = Math.min(heating.SETPOINT_MAX_F, spaTempF + gain);
        }
        if (heated.includes('pool')) {
            poolTempF = Math.min(heating.SETPOINT_MAX_F, poolTempF + gain);
        }
    } else {
        if (spaTempF > SPA_COOLS_TO_F) {
            spaTempF--;
        }
        if (tempSteps % POOL_COOLING_STEPS === 0 && poolTempF > 0) {
            poolTempF--;
        }
    }
};

var listen = ((filename, cb) => {
    emit = cb;
    // frames that fail their checksum are dropped; don't log each one while loading
    const level = logger.level;
    logger.level = 'off';
    try {
        loadCapture(filename);
    } finally {
        logger.level = level;
    }
    logger.info(`simulating the controller with ${frames.length} frames from ${filename}`);
    if (typeof poolTempF === 'undefined') {
        poolTempF = 78;
    }
    setInterval(stepTemperatures, TEMP_STEP_MS);

    let next = 0;
    setInterval(() => {
        const { kind, frame, heater, pool } = frames[next];
        next = (next + 1) % frames.length;
        if (kind === 'DisplayUpdateEvent' && Date.now() < echoUntil) {
            return;
        }
        if (kind === 'StatusEvent') {
            emit(statusFrame());
        } else if (heater) {
            emit(heaterFrame());
        } else if (pool) {
            emit(displayFrame(`Pool Temp   ${poolTempF}_F`, ''));
        } else if (kind === 'DisplayUpdateEvent' && Date.now() - spaTempShownAt > SPA_TEMP_EVERY_MS) {
            spaTempShownAt = Date.now();
            // the spa's sensor is just downstream of the spa filter pump, so its temperature is
            // only known while that runs; the display takes turns when both are known
            const known = isOn('aux14') ? ['pool', 'spa'] : ['pool'];
            const body = known[temperaturesShown++ % known.length];
            emit(body === 'spa'
                ? displayFrame(`Spa Temp   ${spaTempF}_F`, '')
                : displayFrame(`Pool Temp   ${poolTempF}_F`, ''));
        } else {
            emit(frame);
        }
    }, FRAME_INTERVAL_MS);
});

var writeEvent = ((message) => {
    const control = new ControlEvent(Buffer.from(message));
    const pressed = control.enabledSwitches();
    logger.debug('simulator received control event:', pressed.join(', '));

    setTimeout(() => {
        const keys = pressed.filter((name) => panelKeyLabels[name]);
        if (keys.length > 0 && displayTemplate) {
            echoUntil = Date.now() + KEY_ECHO_MS;
            emit(displayFrame('SIMULATOR', keys.map((key) => panelKeyLabels[key]).join(' ')));
        }

        if (pressed.includes('heater1') && displayTemplate) {
            heaterAuto = !heaterAuto;
            echoUntil = Date.now() + KEY_ECHO_MS;
            emit(heaterFrame());
            logger.debug(`simulator: heater1 is now ${heaterAuto ? 'auto' : 'off'}`);
        }

        if (pressed.includes('spillover') && displayTemplate) {
            const mode = stepWaterMode();
            echoUntil = Date.now() + KEY_ECHO_MS;
            emit(displayFrame('SIMULATOR', `${mode.toUpperCase()} MODE`));
        }

        pressed.filter((name) => !panelKeyLabels[name] && name !== 'heater1' && name !== 'spillover').forEach((name) => {
            const statusName = name;
            const bit = StatusEvent.bitPosition(statusName);
            if (typeof bit === 'undefined') {
                logger.debug(`simulator: '${name}' has no status bit to change`);
                return;
            }
            switchMask = (switchMask ^ (1 << bit)) >>> 0;
            const nowOn = isOn(statusName);
            (linkedSwitches[statusName] || []).forEach((linked) => {
                const linkedBit = StatusEvent.bitPosition(linked);
                switchMask = nowOn ? (switchMask | (1 << linkedBit)) >>> 0 : (switchMask & ~(1 << linkedBit)) >>> 0;
            });
            if (switchMessages[statusName] && displayTemplate) {
                echoUntil = Date.now() + KEY_ECHO_MS;
                spaTempShownAt = Date.now();
                emit(displayFrame(switchMessages[statusName], nowOn ? 'Turned On' : 'Turned Off'));
            }
            logger.debug(`simulator: ${statusName} is now ${nowOn ? 'on' : 'off'}`);
        });
        emit(statusFrame());
    }, RESPONSE_DELAY_MS);
});

var setpoints = {
    reachesController: true,
    get: (body, device) => setpointValues[body][device],
    set: (body, device, degrees) => {
        setpointValues[body][device] = degrees;
        logger.debug(`simulator: ${body} ${device} setpoint is now ${degrees}°F`);
    }
};

module.exports = { listen, writeEvent, setpoints };
