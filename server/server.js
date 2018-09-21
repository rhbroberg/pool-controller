'use strict';
require('./config/config');
// eslint and js-beautify fight about having scopes in a switch 'case'; if you make a scope, js-beautify
// fails to properly indent it; if you don't make a scope, eslint complaints about it
/* eslint-disable no-case-declarations */

var socketIO = require('socket.io');
const { FrameParser } = require('./protocol/parse');
const log4js = require('log4js');
const yargs = require('yargs');
const { PingEvent, StatusEvent, DisplayUpdateEvent, ControlEvent, MotorTelemetryEvent, UnidentifiedPingEvent, UnidentifiedStatusEvent } = require('./protocol/events'); // eslint-disable-line no-unused-vars
const _ = require('lodash'); // eslint-disable-line no-unused-vars
const { EventFactory } = require('./protocol/eventfactory');
const path = require('path');
const environmentService = require('./service/EnvironmentService');
const deviceService = require('./service/DeviceService');
const { User } = require('./models/user');

var { mongoose } = require('./mongoose'); // eslint-disable-line no-unused-vars
var { ObjectID } = require('mongodb'); // eslint-disable-line no-unused-vars
var { Event } = require('./models/event');
var serial = require('./drivers/serial');
var fileHandler = require('./drivers/filehandler');
var tailHandler = require('./drivers/tailhandler');
const express = require('express');
const publicPath = path.join(__dirname, './public');
var { initializeServer } = require('./index'); // route handler, courtesy of swagger.io
var io;
var controlRequests = [];
var controlVerification = [];
var driver;

var argv = yargs
    .default('f', __dirname + '/../test-data/sample-various-bin')
    .default('l', 'info')
    .default('d', 'file')
    .argv;

var logger = log4js.getLogger();
logger.level = argv.l;
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

// if webserver is run app will not exit in 'file' mode (which is only used for testing)
if (argv.d !== 'file') {
    logger.info('web server is active');

    initializeServer((app, server) => {
        app.use(express.static(publicPath));
        io = socketIO(server);

        io.on('connection', (socket) => { // eslint-disable-line no-unused-vars// eslint-disable-line no-unused-vars
            logger.debug('connecting from client', socket);
            socket.on('join', (params, callback) => {
                socket.join('datastream');

                socket.emit('catchup', 'here is where i would stream the data up to this point');
                socket.broadcast.emit('datastream').emit('peers', 'hey everybody, another streamer attached');

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
        logger.info(`failed saving ${category} Event: ${e}`);
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
                logger.info(`hystereses prevention for ${statusName} : ${newValue}, ${previousTemp[statusName]}, ${presentTemp[statusName]} `);
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
                var statusChanges = [];

                logger.info('info: ', event.clearText(), salt ? salt : '', ambientTemp ? ambientTemp : '', poolTemp ? poolTemp : '');

                addIfChanged(statusChanges, poolTemp, 'pool temp');
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
            logger.info('status: ', event.asString(), ';', event.prettyBits(1));
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

                if (controlVerification.length > 0) {
                    const request = controlVerification.shift();
                    logger.info('verified control change: ', request.requestedChange, request.presentStatus, event.enabledSwitches());
                    // half duplex means we won't actually receive this event we just sent, so fake it
                    dispatchEvent(request.payload);
                }
            } else {
                if (controlVerification.length > 0) {
                    logger.info('verification failed! retrying');
                    controlRequests.push(controlVerification.shift());
                }
                // always update the lastUpdated timestamp
                // maybe update streamers with 'last updated'
            }
            break;
        case 'PingEvent':
            logger.debug('heartbeat');
            if (logger.isTraceEnabled()) {
                streamEvent('heartbeat', undefined);
            }
            if (controlRequests.length > 0) {
                const request = controlRequests.shift();
                controlVerification.push(request);

                logger.debug('ping calling queued callback');
                driver.writeEvent(request.payload);
            }
            break;
        case 'MotorTelemetryEvent':
            logger.info('motor: ', buf.toString('ascii', 4, buf.length - 2));
            break;
        case 'ControlEvent':
            if (event.enabledSwitches().length === 0) {
                logger.info('control: zeroed out all bits');
            } else {
                logger.info('control: ', event.asString(), ' is toggling ', event.prettyBits(1));
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

var controlListener = ((whatChange) => {
    logger.info('scheduling control change for', whatChange);

    const enabledDevices = currentEnabledSwitches;
    var updateIt = new ControlEvent();
    updateIt.toggleControls([whatChange]);

    const payload = updateIt.payload();
    controlRequests.push({
        requestedChange: whatChange,
        payload: payload,
        presentStatus: enabledDevices
    });

    return (enabledDevices.includes(whatChange)) ? true : false;
});

if (argv.d === 'file') {
    driver = fileHandler;
    logger.info('starting file processing of', argv.f);
    logger.info(`processing found ${processingErrors} event errors`);
} else if (argv.d === 'tail') {
    driver = tailHandler;
    logger.info('starting tail listening on', argv.f);
} else if (argv.d === 'serial') {
    driver = serial;
    logger.info('starting serial port listening to ', argv.f);
} else if (argv.d === 'none') {
    logger.info('no new data forthcoming');
}

environmentService.registerControlListener(controlListener);
deviceService.registerControlListener(controlListener);
driver.listen(argv.f, handleHunk);
