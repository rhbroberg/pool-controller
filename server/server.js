'use strict';
require('./config/config');
// eslint and js-beautify fight about having scopes in a switch 'case'; if you make a scope, js-beautify
// fails to properly indent it; if you don't make a scope, eslint complaints about it
/* eslint-disable no-case-declarations */

var socketIO = require('socket.io');
const { FrameParser } = require('./protocol/parse');
const log4js = require('log4js');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { PingEvent, StatusEvent, DisplayUpdateEvent, ControlEvent, MotorTelemetryEvent, UnidentifiedPingEvent, UnidentifiedStatusEvent, panelLabels } = require('./protocol/events'); // eslint-disable-line no-unused-vars
const _ = require('lodash'); // eslint-disable-line no-unused-vars
const { EventFactory } = require('./protocol/eventfactory');
const path = require('path');
const environmentService = require('./service/EnvironmentService');
const deviceService = require('./service/DeviceService');
const panelService = require('./service/PanelService');
const systemService = require('./service/SystemService');
const waterService = require('./service/WaterService');
const heatingService = require('./service/HeatingService');

var { mongoose } = require('./mongoose');
var { ObjectID } = require('mongodb'); // eslint-disable-line no-unused-vars
var { Event } = require('./models/event');
var serial = require('./drivers/serial');
var fileHandler = require('./drivers/filehandler');
var tailHandler = require('./drivers/tailhandler');
var simulator = require('./drivers/simulator');
const express = require('express');
const publicPath = path.join(__dirname, './public');
var { initializeServer } = require('./index'); // route handler, courtesy of swagger.io
var io;
var replayStarted = false;
var controlRequests = [];
var controlVerification = [];
// filter shutdown has been seen to take about a dozen status frames
const CONTROL_VERIFY_STATUS_FRAMES = 40;
var driver;

var argv = yargs(hideBin(process.argv))
    .default('f', __dirname + '/../test-data/sample-various-bin')
    .default('l', 'info')
    .default('d', 'file')
    .boolean('from-start')
    .default('from-start', false)
    .boolean('v')
    .alias('v', 'verbose')
    .argv;

// info shows startup, REST changes and controller confirmations; -v adds every frame
var logger = log4js.getLogger();
logger.level = argv.v ? 'debug' : argv.l;
var parser = new FrameParser();
var processingErrors = 0;
// create factory and register all (currently) known events
var factory = new EventFactory();
// in reality, retrieve these from db at startup
var presentTemp = {
    'pool temp': -1,
    'spa temp': -1,
    'ambient': -1
};
var previousTemp = {
    'pool temp': -1,
    'spa temp': -1,
    'ambient': -1
};
// really retrieve this from db at startup
var currentStatusMask = 0;
var currentEnabledSwitches = [];
var latestDisplay;
// 1 for auto, 0 for off, undefined until the panel displays the heater line
var heaterAuto;

// if webserver is run app will not exit in 'file' mode (which is only used for testing)
if (argv.d !== 'file') {
    logger.info('web server is active');

    initializeServer((app, server) => {
        app.use(express.static(publicPath));
        io = socketIO(server);

        io.on('connection', (socket) => {
            logger.debug('connecting from client', socket);
            if (argv.fromStart && argv.d === 'tail' && !replayStarted) {
                replayStarted = true;
                logger.info('browser connected, replaying', argv.f);
                driver.listen(argv.f, handleHunk, { fromStart: true });
            }
            socket.on('join', (params, callback) => {
                socket.join('datastream');

                socket.emit('catchup', 'here is where i would stream the data up to this point');
                socket.broadcast.emit('datastream');
                socket.emit('peers', 'hey everybody, another streamer attached');

                if (callback) {
                    callback();
                }
            });

            socket.on('disconnect', () => {
                logger.debug('disconnecting');
            });
        });
    });
}

var saveStatus = (switchesEnabled, buf, category, timestamp) => {
    var dbStatusEvent = new Event({
        _id: new mongoose.Types.ObjectId,
        source: 'panel',
        raw: buf,
        eventType: category,
        status: switchesEnabled,
        timestamp: timestamp
    });

    dbStatusEvent.save().then((doc) => {
        logger.trace('saved ', doc);
    }, (e) => {
        logger.error(`failed saving ${category} Event: ${e}`);
    });
};

var saveSwitchState = (switchesEnabled, buf, category, timestamp) => {
    if (switchesEnabled.length > 0) {
        saveStatus(switchesEnabled, buf, category, timestamp);
    }
};

var switchStates = (changed, enabled) => {
    var switchesChanged = [];

    // need to determine the last time a bit was turned on (keep cache); when it goes off, the event needs to include that bit changing state
    changed.forEach(function(name) {
        switchesChanged.push({
            name: name,
            value: enabled
        });
    });

    return switchesChanged;
};

var addIfChanged = (statusChanges, newValue, statusName) => {
    if (newValue) {
        if (presentTemp[statusName] !== newValue) {
            if ((typeof previousTemp[statusName] !== 'undefined') && (newValue === previousTemp[statusName]) && (Math.abs(presentTemp[statusName] - newValue) === 1)) {
                logger.debug(`hystereses prevention for ${statusName} : ${newValue}, ${previousTemp[statusName]}, ${presentTemp[statusName]} `);
            } else {
                statusChanges.push({
                    name: statusName,
                    value: newValue
                });
                previousTemp[statusName] = presentTemp[statusName];
            }
        }
        else {
            logger.debug(`compressing ${statusName}`);
        }
        presentTemp[statusName] = newValue;
    }
};

var streamEvent = (kind, text, timestamp) => {
    // send to sockets (if established)
    if (io) {
        logger.trace('streaming data to http listeners at ', timestamp);
        io.emit(kind, JSON.stringify({
            kind: kind,
            text: text,
            timestamp: timestamp
        }, undefined, 2));
    }
};

var dispatchEvent = (buf) => {
    // maybe change to an observer pattern for action taken
    const event = factory.create(buf);
    if (!event) {
        logger.warn('cannot identify event');
        return false;
    }

    const timestamp = new Date().getTime();
    switch (event.constructor.name) {
        case 'DisplayUpdateEvent':
            {
                const salt = event.getSaltPPM();
                const ambientTemp = event.getAmbientTemp();
                const poolTemp = event.getPoolTemp();
                const spaTemp = event.getSpaTemp();
                const heaterMode = event.getHeater1Mode();
                var statusChanges = [];

                if (typeof heaterMode !== 'undefined') {
                    const auto = /Off$/.test(heaterMode) ? 0 : 1;
                    if (auto !== heaterAuto) {
                        heaterAuto = auto;
                        statusChanges.push({ name: 'heater1 mode', value: auto });
                    }
                }

                latestDisplay = Object.assign(event.panelLines(), { timestamp: new Date(timestamp).toISOString() });
                logger.debug('info: ', event.clearText(), salt ? salt : '', ambientTemp ? ambientTemp : '', poolTemp ? poolTemp : '');

                addIfChanged(statusChanges, poolTemp, 'pool temp');
                addIfChanged(statusChanges, spaTemp, 'spa temp');
                addIfChanged(statusChanges, salt, 'salt');
                addIfChanged(statusChanges, ambientTemp, 'ambient');

                if (statusChanges.length === 0) {
                    // always update the lastUpdated timestamp
                    // maybe update streamers with 'last updated'
                } else {
                    saveSwitchState(statusChanges, buf, 'info', timestamp);
                    streamEvent('info', statusChanges, timestamp);
                }
            }
            break;
        case 'StatusEvent':
            const eventDiffs = event.diff(currentStatusMask);
            logger.debug('status: ', event.asString(), ';', event.prettyBits(1));
            currentStatusMask = event.rawMask();
            currentEnabledSwitches = event.enabledSwitches();

            logger.debug(eventDiffs);
            if (eventDiffs.nowEnabled.length > 0 || eventDiffs.nowDisabled.length > 0) {
                logger.debug('storing changes');
                const nowEnabled = switchStates(eventDiffs.nowEnabled, 1);
                const nowDisabled = switchStates(eventDiffs.nowDisabled, 0);

                saveSwitchState(nowEnabled.concat(nowDisabled), buf, 'status', timestamp);
                streamEvent('status', {
                    nowEnabled: eventDiffs.nowEnabled,
                    nowDisabled: eventDiffs.nowDisabled
                }, timestamp);
            }
            // always update the lastUpdated timestamp
            // maybe update streamers with 'last updated'
            verifyControlRequests();
            advanceWaterMode();
            break;
        case 'PingEvent':
            logger.debug('heartbeat');
            if (logger.isTraceEnabled()) {
                streamEvent('heartbeat', undefined);
            }
            if (controlRequests.length > 0) {
                const request = controlRequests.shift();
                if (request.momentary) {
                    logger.debug(`sending panel key ${request.requestedChange} for ${request.requestedBy}`);
                    driver.writeEvent(request.payload);
                } else if (isSwitchOn(request.requestedChange) === request.desiredOn) {
                    logger.info(`${request.requestedChange} reached ${request.desiredOn ? 'on' : 'off'} before it was sent for ${request.requestedBy}; not sending`);
                } else {
                    request.statusFramesWaited = 0;
                    controlVerification.push(request);

                    logger.debug('ping calling queued callback');
                    driver.writeEvent(request.payload);
                }
            }
            break;
        case 'MotorTelemetryEvent':
            logger.debug('motor: ', buf.toString('ascii', 4, buf.length - 2));
            break;
        case 'ControlEvent':
            if (event.enabledSwitches().length === 0) {
                logger.debug('control: zeroed out all bits');
            } else {
                logger.debug('control: ', event.asString(), ' is toggling ', event.prettyBits(1));
                const toggleBits = switchStates(event.enabledSwitches(), 1);
                saveSwitchState(toggleBits, buf, 'control', timestamp);
                streamEvent('control', event.enabledSwitches(), timestamp);
            }
            break;
        case 'UnidentifiedStatusEvent':
            logger.debug('unidentified status:');
            break;
        case 'UnidentifiedPingEvent':
            logger.debug('unidentified ping');
            break;
        default:
            saveStatus([], buf, 'unrecognized', timestamp);
            return false;
    }
    return true;
};

var handleHunk = (data) => {
    parser.parse(data, (buf) => {
        logger.debug(parser.toHexString());
        // maybe change Event to take the FrameParser instead of the buf?
        try {
            if (!dispatchEvent(buf)) {
                // if message is unrecognized, log out hex bytes
                logger.warn('unrecognized message header bytes: ',
                    buf.readUInt8(2).toString(16).padStart(2, 0),
                    buf.readUInt8(3).toString(16).padStart(2, 0));
                logger.warn(parser.toHexString());
            }
        }
        catch (e) {
            processingErrors++;
            logger.error(`event exception '${e}' received (${processingErrors} so far), continuing`);
            if (e === 'checksum failure') {
                logger.error(e.stack);
            }
            saveStatus([], buf, 'failed', new Date().getTime());
        }
    });
};

// the heater's on/off is its mode from the display, not its status bit
var labelled = (name) => panelLabels[name] ? `${name} (${panelLabels[name]})` : name;

var isSwitchOn = (name) => name === 'heater1' ? heaterAuto === 1 : currentEnabledSwitches.includes(name);

// a keypress only toggles, so a request is confirmed by watching status frames rather than
// pressed again; pressing again while a slow change (filter shutdown) is underway would reverse it
var verifyControlRequests = () => {
    controlVerification = controlVerification.filter((request) => {
        if (isSwitchOn(request.requestedChange) === request.desiredOn) {
            logger.info(`controller confirmed ${labelled(request.requestedChange)} ${request.desiredOn ? 'on' : 'off'} for ${request.requestedBy}`);
            // half duplex means we won't actually receive this event we just sent, so fake it
            dispatchEvent(request.payload);
            return false;
        }
        if (++request.statusFramesWaited >= CONTROL_VERIFY_STATUS_FRAMES) {
            logger.warn(`controller did not confirm ${labelled(request.requestedChange)} ${request.desiredOn ? 'on' : 'off'} for ${request.requestedBy}`);
            return false;
        }
        return true;
    });
};

var controlListener = ((whatChange, desiredOn, requestedBy) => {
    if (!ControlEvent.isControl(whatChange)) {
        throw new Error(`'${whatChange}' is not a controller button`);
    }
    if (whatChange === 'spillover') {
        throw new Error('the spillover key cycles the water flow mode; set the mode with PUT /water/mode/{mode}');
    }
    if (whatChange === 'heater1' && typeof heaterAuto === 'undefined') {
        throw new Error('the panel has not shown the heater mode yet; try again shortly');
    }

    const isOn = isSwitchOn(whatChange);
    if (isOn === desiredOn) {
        return isOn;
    }

    logger.debug(`scheduling ${whatChange} ${desiredOn ? 'on' : 'off'}`);
    var updateIt = new ControlEvent();
    updateIt.toggleControls([whatChange]);

    controlRequests.push({
        requestedChange: whatChange,
        desiredOn: desiredOn,
        requestedBy: requestedBy,
        payload: updateIt.payload()
    });

    return isOn;
});

// The spillover key steps the water flow through pool, spa and spillover in that order. A
// request presses it once, waits for the status bits to show the next mode, and presses
// again until the requested mode is reached.
const WATER_MODES = ['pool', 'spa', 'spillover'];
var waterModeRequest;

var currentWaterMode = () => {
    if (isSwitchOn('spillover')) {
        return 'spillover';
    }
    if (isSwitchOn('spa')) {
        return 'spa';
    }
    return isSwitchOn('pool') ? 'pool' : undefined;
};

var pressSpillover = (requestedBy) => {
    var press = new ControlEvent();
    press.toggleControls(['spillover']);
    controlRequests.push({
        requestedChange: 'spillover',
        requestedBy: requestedBy,
        momentary: true,
        payload: press.payload()
    });
};

var advanceWaterMode = () => {
    if (!waterModeRequest) {
        return;
    }
    const mode = currentWaterMode();
    if (mode === waterModeRequest.target) {
        logger.info(`controller confirmed water flow ${mode} for ${waterModeRequest.requestedBy}`);
        waterModeRequest = undefined;
    } else if (mode !== waterModeRequest.lastMode) {
        waterModeRequest.lastMode = mode;
        waterModeRequest.statusFramesWaited = 0;
        pressSpillover(waterModeRequest.requestedBy);
    } else if (++waterModeRequest.statusFramesWaited >= CONTROL_VERIFY_STATUS_FRAMES) {
        logger.warn(`controller did not reach water flow ${waterModeRequest.target} for ${waterModeRequest.requestedBy}; it is ${mode}`);
        waterModeRequest = undefined;
    }
};

var waterModeListener = ((target, requestedBy) => {
    if (!WATER_MODES.includes(target)) {
        throw new Error(`water flow mode must be one of ${WATER_MODES.join(', ')}`);
    }
    const mode = currentWaterMode();
    if (typeof mode === 'undefined') {
        throw new Error('the controller has not reported the water flow mode yet; try again shortly');
    }
    if (mode === target) {
        waterModeRequest = undefined;
        return mode;
    }
    waterModeRequest = { target: target, requestedBy: requestedBy, lastMode: mode, statusFramesWaited: 0 };
    pressSpillover(requestedBy);
    return mode;
});

const panelKeys = ['menu', 'left', 'right', 'minus', 'plus'];

// menu and arrow keys change what the panel displays, not a status bit, so they are
// sent once and never verified
var panelKeyListener = ((key, requestedBy) => {
    if (!panelKeys.includes(key)) {
        throw new Error(`'${key}' is not a panel navigation key`);
    }

    var press = new ControlEvent();
    press.toggleControls([key]);
    controlRequests.push({
        requestedChange: key,
        requestedBy: requestedBy,
        momentary: true,
        payload: press.payload()
    });
});

if (argv.d === 'file') {
    driver = fileHandler;
    logger.info('starting file processing of', argv.f);
    logger.info(`processing found ${processingErrors} event errors`);
} else if (argv.d === 'tail') {
    driver = tailHandler;
    logger.info('starting tail listening on', argv.f);
} else if (argv.d === 'sim') {
    driver = simulator;
    logger.info('starting simulated controller from', argv.f);
} else if (argv.d === 'serial') {
    driver = serial;
    logger.info('starting serial port listening to ', argv.f);
} else if (argv.d === 'none') {
    logger.info('no new data forthcoming');
}

environmentService.registerControlListener(controlListener);
deviceService.registerControlListener(controlListener);
panelService.registerKeyListener(panelKeyListener);
panelService.registerDisplaySource(() => latestDisplay);
waterService.registerModeListener(waterModeListener);

var knownTemp = (name) => {
    const value = Number(presentTemp[name]);
    return value > 0 ? value : undefined;
};
// the heater1 status bit is the heater firing; whether it is enabled is its Auto/Off mode
heatingService.registerStateSource(() => ({
    filter: isSwitchOn('filter'),
    spaFilter: isSwitchOn('aux14'),
    waterMode: currentWaterMode(),
    enabled: {
        heater1: typeof heaterAuto === 'undefined' ? undefined : heaterAuto === 1,
        heatpump: currentStatusMask === 0 ? undefined : isSwitchOn('valve4')
    },
    heaterFiring: currentEnabledSwitches.includes('heater1'),
    temperatures: { pool: knownTemp('pool temp'), spa: knownTemp('spa temp') }
}));
if (driver && driver.setpoints) {
    heatingService.registerSetpoints(driver.setpoints);
}

// after a factory reset, forget what has been seen so the next frames are stored as new history
systemService.registerResetListener(() => {
    Object.keys(presentTemp).forEach((name) => { presentTemp[name] = -1; previousTemp[name] = -1; });
    currentStatusMask = 0;
    currentEnabledSwitches = [];
    latestDisplay = undefined;
    heaterAuto = undefined;
    controlRequests = [];
    controlVerification = [];
    waterModeRequest = undefined;
});

// docker stop and Ctrl-C send these; exiting normally lets coverage and pending writes finish
['SIGTERM', 'SIGINT'].forEach((signal) => {
    process.once(signal, () => {
        logger.info(`${signal} received; shutting down`);
        mongoose.disconnect()
            .catch(() => {})
            .then(() => process.exit(0));
    });
});

mongoose.connection.asPromise()
    .then(() => systemService.commissionIfEmpty())
    .catch((e) => logger.error(`could not check for accounts: ${e}`));
if (argv.d === 'tail' && argv.fromStart) {
    logger.info('replay waits for a browser connection');
} else if (driver) {
    driver.listen(argv.f, handleHunk);
}
