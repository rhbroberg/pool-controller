'use strict';
require('./config/config');

var socketIO = require('socket.io');
const { FrameParser, stuff } = require('./protocol/parse');
const { FrameInterpreter, CHECK_SYSTEM_REASON } = require('./protocol/interpreter');
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
const heatingModelService = require('./service/HeatingModelService');
const taskService = require('./service/TaskService');
const settingsService = require('./service/SettingsService');
const externalAuthService = require('./service/ExternalAuthService');
const liveService = require('./service/LiveService');
const statusService = require('./service/StatusService');
const scheduler = require('./jobs/scheduler');
const rollupsJob = require('./jobs/rollups');
const retentionJob = require('./jobs/retention');
const weatherJob = require('./jobs/weather');
const accountsJob = require('./jobs/accounts');

var { mongoose } = require('./mongoose');
var { ObjectID } = require('mongodb'); // eslint-disable-line no-unused-vars
var { Event } = require('./models/event');
var { Rollup } = require('./models/rollup');
var { WeatherHour, WeatherDay } = require('./models/weather');
var serial = require('./drivers/serial');
var fileHandler = require('./drivers/filehandler');
var tailHandler = require('./drivers/tailhandler');
var simulator = require('./drivers/simulator');
const express = require('express');
const publicPath = path.join(__dirname, './public');
var { initializeServer } = require('./index'); // route handler, courtesy of swagger.io
var io: any;
var replayStarted = false;
var controlRequests: any[] = [];
var controlVerification: any[] = [];
// filter shutdown has been seen to take about a dozen status frames
const CONTROL_VERIFY_STATUS_FRAMES = 40;
var driver: any;

var argv = yargs(hideBin(process.argv))
    .default('f', __dirname + '/test/test-data/sample-various-bin')
    .default('l', 'info')
    .default('d', 'file')
    .boolean('from-start')
    .default('from-start', false)
    .boolean('v')
    .alias('v', 'verbose')
    // --no-jobs leaves maintenance to another process; --jobs-only is that process
    .boolean('jobs')
    .default('jobs', true)
    .boolean('jobs-only')
    .default('jobs-only', false)
    .argv;

// info shows startup, REST changes and controller confirmations; -v adds every frame
var logger = log4js.getLogger();
logger.level = argv.v ? 'debug' : argv.l;
var parser = new FrameParser();
var processingErrors = 0;
// create factory and register all (currently) known events
var factory = new EventFactory();
// what has been seen, so only changes are stored; it starts empty rather than from the database
var interpreter = new FrameInterpreter();
var latestDisplay: any;

// drops indexes the models no longer list, such as the old status.0.name ones, and builds new ones
var syncIndexes = () => Promise.all([Event, Rollup, WeatherHour, WeatherDay].map((model) => model.syncIndexes().then((dropped: any) => {
    if (dropped.length > 0) {
        logger.info(`dropped unused ${model.collection.name} indexes: ${dropped.join(', ')}`);
    }
})));

// the API waits for this, so the default admin account exists before the first sign-in and
// history uses the configured time zone
const startupChecked = mongoose.connection.asPromise()
    .then(() => Promise.all([systemService.commissionIfEmpty(), settingsService.load(), externalAuthService.load(), heatingModelService.load(), syncIndexes()]))
    .catch((e: any) => logger.error(`startup checks failed: ${e}`));

// a new model changes every estimate at once
heatingModelService.onChange(() => liveService.heatingChanged());
// a preheat scheduled, cancelled or started shows on every app at once
taskService.onChange(() => liveService.tasksChanged());

scheduler.register(rollupsJob);
scheduler.register(retentionJob);
scheduler.register(weatherJob);
scheduler.register(accountsJob);
startupChecked.then(() => scheduler.start({ enabled: argv.jobs }));
// days begin at a different time in a new zone, so the daily rollups are redone right away, and
// the weather's days with them; a new zip code needs its forecast straight away too
settingsService.onChange((changes: any) => {
    // apps show the estimate as the server's settings say, and the zone sets the time of day it ends
    if (changes.heatingEstimateDisplay || changes.timeZone || changes.heatingRules) {
        liveService.heatingChanged();
    }
    // a scheduled preheat's start time, and whether it's dark, follow these
    if (changes.heatingRules || changes.preheatMarginMinutes || changes.location || changes.timeZone) {
        liveService.tasksChanged();
    }
    if (changes.timeZone) {
        scheduler.runNow(rollupsJob.name, 'time zone change').catch((e: any) => logger.error(`rollups after a time zone change: ${e.message}`));
    }
    if ((changes.timeZone && settingsService.location()) || changes.location) {
        scheduler.runNow(weatherJob.name, 'settings change').catch((e: any) => logger.error(`weather after a settings change: ${e.message}`));
    }
});

// if webserver is run app will not exit in 'file' mode (which is only used for testing)
if (argv.d !== 'file' && !argv.jobsOnly) {
    logger.info('web server is active');

    // only the process that talks to the controller starts scheduled preheats
    startupChecked.then(() => taskService.load()).catch((e: any) => logger.error(`could not load scheduled tasks: ${e.message}`));

    startupChecked.then(() => initializeServer((app: any, server: any) => {
        app.use(express.static(publicPath));
        io = socketIO(server);
        liveService.attach(io, { heating: () => heatingService.getHeating(), tasks: () => taskService.getTasks() });

        io.on('connection', (socket: any) => {
            logger.debug('connecting from client', socket);
            if (argv.fromStart && argv.d === 'tail' && !replayStarted) {
                replayStarted = true;
                logger.info('browser connected, replaying', argv.f);
                driver.listen(argv.f, handleHunk, { fromStart: true });
            }
            socket.on('join', (params: any, callback: any) => {
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
    }));
}

var saveStatus = (switchesEnabled: any, buf: any, category: string, timestamp: any, message?: string) => {
    var dbStatusEvent = new Event({
        _id: new mongoose.Types.ObjectId,
        source: 'panel',
        raw: buf,
        eventType: category,
        status: switchesEnabled,
        timestamp: timestamp,
        message: message
    });

    return dbStatusEvent.save().then((doc: any) => {
        logger.trace('saved ', doc);
    }, (e: any) => {
        logger.error(`failed saving ${category} Event: ${e}`);
    });
};

/**
 * resolves once saved, or once saving failed
 **/
var saveSwitchState = (switchesEnabled: any, buf: any, category: string, timestamp: any, message?: string) => {
    if (switchesEnabled.length > 0) {
        return saveStatus(switchesEnabled, buf, category, timestamp, message);
    }
    return Promise.resolve();
};

var streamEvent = (kind: string, text?: any, timestamp?: any) => {
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

/**
 * buf is the frame with the bus's escaping undone; wire is how it arrived, which is stored
 **/
var dispatchEvent = (buf: Buffer, wire = stuff(buf)) => {
    // maybe change to an observer pattern for action taken
    const event = factory.create(buf);
    if (!event) {
        logger.warn('cannot identify event');
        return false;
    }

    const timestamp = new Date().getTime();
    const stored = interpreter.interpret(event);
    switch (event.constructor.name) {
        case 'DisplayUpdateEvent':
        case 'WirelessDisplayEvent':
            // the remote's screens carry readings too, but the panel's display is what's shown
            if (event.constructor.name === 'DisplayUpdateEvent') {
                latestDisplay = Object.assign(event.panelLines(), { timestamp: new Date(timestamp).toISOString() });
            }
            logger.debug('info: ', event.clearText());
            if (stored) {
                const at = new Date(timestamp);
                const readings = stored.status.map((entry: any) => entry.name === CHECK_SYSTEM_REASON
                    ? statusService.reasonReading(interpreter.checkSystemReasons(), at)
                    : { name: entry.name, category: 'info', value: entry.value, timestamp: at });
                if (stored.message) {
                    logger.info(`the panel says to check the system: ${stored.message}`);
                }
                // pushed once saved, so an app asking GET /status after the push sees it too
                saveSwitchState(stored.status, wire, 'info', timestamp, stored.message).then(() => liveService.readings(readings));
                streamEvent('info', stored.status, timestamp);
            }
            break;
        case 'StatusEvent':
            logger.debug('status: ', event.asString(), ';', event.prettyBits(1));
            if (stored) {
                logger.debug('storing changes', stored.diffs);
                const switches = statusService.switchesOf(event, new Date(timestamp));
                // the last fault's reasons don't belong to the next one
                const reason = stored.status.some((entry: any) => entry.name === 'check system')
                    ? [statusService.reasonReading(interpreter.checkSystemReasons(), new Date(timestamp))]
                    : [];
                saveSwitchState(stored.status, wire, 'status', timestamp).then(() => {
                    liveService.readings(switches);
                    liveService.readings(reason);
                });
                streamEvent('status', {
                    nowEnabled: stored.diffs.nowEnabled,
                    nowDisabled: stored.diffs.nowDisabled
                }, timestamp);
            }
            // the moment a pump starts matters to the heating estimate
            heatingService.stateChanged();
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
            break;
        case 'MotorTelemetryEvent':
            logger.debug('motor: ', buf.toString('ascii', 4, buf.length - 2));
            break;
        case 'ControlEvent':
            if (!stored) {
                logger.debug('control: zeroed out all bits');
            } else {
                logger.debug('control: ', event.asString(), ' is toggling ', event.prettyBits(1));
                saveSwitchState(stored.status, wire, 'control', timestamp);
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
            saveStatus([], wire, 'unrecognized', timestamp);
            return false;
    }
    return true;
};

var handleHunk = (data: Buffer) => {
    parser.parse(data, (buf: any, length: any, wire: any) => {
        logger.debug(parser.toHexString());
        // maybe change Event to take the FrameParser instead of the buf?
        try {
            if (!dispatchEvent(buf, wire)) {
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
                logger.error(String(e));
            }
            saveStatus([], wire, 'failed', new Date().getTime());
        }
    });
};

// the heater's on/off is its mode from the display, not its status bit
var labelled = (name: string) => panelLabels[name] ? `${name} (${panelLabels[name]})` : name;

var isSwitchOn = (name: string) => name === 'heater1' ? interpreter.heaterAuto === 1 : interpreter.enabledSwitches.includes(name);

// a keypress only toggles, so a request is confirmed by watching status frames rather than
// pressed again; pressing again while a slow change (filter shutdown) is underway would reverse it.
// Re-send early when USB-RS485 misses the keep-alive window; waiting until frame 20 (~40s)
// outran the app's confirmation timeout. A second try mid-window covers a flaky first resend.
const CONTROL_RESEND_AT_STATUS_FRAMES = [5, 15];
var verifyControlRequests = () => {
    controlVerification = controlVerification.filter((request) => {
        const on = isSwitchOn(request.requestedChange);
        if (on === request.desiredOn) {
            logger.info(`controller confirmed ${labelled(request.requestedChange)} ${request.desiredOn ? 'on' : 'off'} for ${request.requestedBy}`);
            if (driver.cancelPending) {
                driver.cancelPending();
            }
            // half duplex means we won't actually receive this event we just sent, so fake it
            dispatchEvent(request.payload);
            return false;
        }
        request.statusFramesWaited = (request.statusFramesWaited || 0) + 1;
        if (request.statusFramesWaited <= 3 || request.statusFramesWaited % 10 === 0) {
            logger.debug(`waiting for ${request.requestedChange} ${request.desiredOn ? 'on' : 'off'}; now ${on ? 'on' : 'off'}; mask=0x${(interpreter.statusMask >>> 0).toString(16)}; frame ${request.statusFramesWaited}; switches=${interpreter.enabledSwitches.join(',')}`);
        }
        if (request.statusFramesWaited >= CONTROL_VERIFY_STATUS_FRAMES) {
            logger.warn(`controller did not confirm ${labelled(request.requestedChange)} ${request.desiredOn ? 'on' : 'off'} for ${request.requestedBy}`);
            return false;
        }
        if (CONTROL_RESEND_AT_STATUS_FRAMES.includes(request.statusFramesWaited)) {
            logger.debug(`re-sending ${request.requestedChange} for ${request.requestedBy} (status frame ${request.statusFramesWaited})`);
            driver.writeEvent(request.wire || stuff(request.payload));
        }
        return true;
    });
};

var controlListener = ((whatChange: string, desiredOn: boolean, requestedBy: string) => {
    if (!ControlEvent.isControl(whatChange)) {
        throw new Error(`'${whatChange}' is not a controller button`);
    }
    if (whatChange === 'spillover') {
        throw new Error('the spillover key cycles the water flow mode; set the mode with PUT /water/mode/{mode}');
    }
    if (whatChange === 'heater1' && typeof interpreter.heaterAuto === 'undefined') {
        throw new Error('the panel has not shown the heater mode yet; try again shortly');
    }

    const isOn = isSwitchOn(whatChange);
    if (isOn === desiredOn) {
        return isOn;
    }

    logger.debug(`scheduling ${whatChange} ${desiredOn ? 'on' : 'off'}`);
    var updateIt = new ControlEvent();
    updateIt.toggleControls([whatChange]);
    const payload = updateIt.payload();
    const wire = stuff(payload);
    // Queue immediately; the serial driver transmits on each keep-alive (~1ms window).
    // Wireless remotes repeat a held key every poll; three copies covers a missed USB turnaround
    // without looking like separate toggles once the panel sees the press.
    controlVerification.push({
        requestedChange: whatChange,
        desiredOn: desiredOn,
        requestedBy: requestedBy,
        payload: payload,
        wire: wire,
        statusFramesWaited: 0
    });
    // USB delivers keep-alives in batches, so many polls miss the ~1ms reply window. Queue
    // enough held-key repeats to cover ~1s of polls; cancelPending drops the rest on confirm.
    const copies = Math.max(1, Number(process.env.POOL_CONTROL_TX_COPIES || 12) || 12);
    for (let n = 0; n < copies; n++) {
        driver.writeEvent(wire);
    }
    logger.debug(`queued ${whatChange} ×${copies} for ${requestedBy}`);

    return isOn;
});

// The spillover key steps the water flow through pool, spa and spillover in that order. A
// request presses it once, waits for the status bits to show the next mode, and presses
// again until the requested mode is reached.
const WATER_MODES = ['pool', 'spa', 'spillover'];
var waterModeRequest: { target: string; requestedBy: string; pressesLeft?: number; lastMode?: string; statusFramesWaited?: number } | undefined;

var currentWaterMode = (): string | undefined => {
    if (isSwitchOn('spillover')) {
        return 'spillover';
    }
    if (isSwitchOn('spa')) {
        return 'spa';
    }
    return isSwitchOn('pool') ? 'pool' : undefined;
};

var pressSpillover = (requestedBy: string) => {
    var press = new ControlEvent();
    press.toggleControls(['spillover']);
    driver.writeEvent(stuff(press.payload()));
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
    } else if ((waterModeRequest.statusFramesWaited = (waterModeRequest.statusFramesWaited || 0) + 1) >= CONTROL_VERIFY_STATUS_FRAMES) {
        logger.warn(`controller did not reach water flow ${waterModeRequest.target} for ${waterModeRequest.requestedBy}; it is ${mode}`);
        waterModeRequest = undefined;
    }
};

var waterModeListener = ((target: string, requestedBy: string) => {
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
var panelKeyListener = ((key: string, requestedBy: string) => {
    if (!panelKeys.includes(key)) {
        throw new Error(`'${key}' is not a panel navigation key`);
    }

    var press = new ControlEvent();
    press.toggleControls([key]);
    // three keep-alive-timed presses: USB-RS485 drops frames often enough that one is unreliable
    const wire = stuff(press.payload());
    for (let n = 0; n < 3; n++) {
        driver.writeEvent(wire);
    }
    logger.debug(`queued panel key ${key} ×3 for ${requestedBy}`);
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

var knownTemp = (name: string) => {
    const value = Number(interpreter.present[name]);
    return value > 0 ? value : undefined;
};
// the heater1 status bit is the heater firing; whether it is enabled is its Auto/Off mode
heatingService.registerStateSource(() => ({
    filter: isSwitchOn('filter'),
    spaFilter: isSwitchOn('aux14'),
    waterMode: currentWaterMode(),
    enabled: {
        heater1: typeof interpreter.heaterAuto === 'undefined' ? undefined : interpreter.heaterAuto === 1,
        heatpump: interpreter.statusMask === 0 ? undefined : isSwitchOn('valve4')
    },
    heaterFiring: interpreter.enabledSwitches.includes('heater1'),
    temperatures: { pool: knownTemp('pool temp'), spa: knownTemp('spa temp') },
    ambient: knownTemp('ambient')
}));
if (driver && driver.setpoints) {
    heatingService.registerSetpoints(driver.setpoints);
}
// heater1 counts as on in Auto, as isSwitchOn has it
taskService.registerStateSource(() => ({
    isOn: isSwitchOn,
    waterMode: currentWaterMode(),
    ambient: knownTemp('ambient')
}));

// after a factory reset, forget what has been seen so the next frames are stored as new history
systemService.registerResetListener(() => {
    interpreter.reset();
    latestDisplay = undefined;
    controlRequests = [];
    controlVerification = [];
    waterModeRequest = undefined;
    // the reset erased the settings along with everything else
    settingsService.load().catch((e: any) => logger.error(`could not reload settings: ${e.message}`));
    heatingModelService.load().then(() => liveService.heatingChanged()).catch((e: any) => logger.error(`could not reload the heating model: ${e.message}`));
    externalAuthService.load().catch((e: any) => logger.error(`could not reload sign-in settings: ${e.message}`));
    taskService.load().then(() => liveService.tasksChanged()).catch((e: any) => logger.error(`could not reload scheduled tasks: ${e.message}`));
});

// docker stop and Ctrl-C send these; exiting normally lets coverage and pending writes finish
['SIGTERM', 'SIGINT'].forEach((signal) => {
    process.once(signal, () => {
        logger.info(`${signal} received; shutting down`);
        scheduler.stop();
        mongoose.disconnect()
            .catch(() => {})
            .then(() => process.exit(0));
    });
});

if (argv.jobsOnly) {
    logger.info('running maintenance jobs only; no web server or controller');
} else if (argv.d === 'tail' && argv.fromStart) {
    logger.info('replay waits for a browser connection');
} else if (driver) {
    driver.listen(argv.f, handleHunk);
}
