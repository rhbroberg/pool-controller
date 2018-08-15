'use strict';
require('./config/config');

const { FrameParser } = require('./protocol/parse');
const log4js = require('log4js');
const yargs = require('yargs');
const { PingEvent, StatusEvent, DisplayUpdateEvent, ControlEvent, MotorTelemetryEvent, UnidentifiedPingEvent, UnidentifiedStatusEvent } = require('./protocol/events');
const _ = require('lodash'); // eslint-disable-line no-unused-vars
const { EventFactory } = require('./protocol/eventfactory');

var { mongoose } = require('./mongoose'); // eslint-disable-line no-unused-vars
var { ObjectID } = require('mongodb'); // eslint-disable-line no-unused-vars
var { Event } = require('./models/event');
var serial = require('./drivers/serial');
var fileHandler = require('./drivers/filehandler');
var tailHandler = require('./drivers/tailhandler');

var argv = yargs
    .default('f', __dirname + '/../test-data/sample-various-bin')
    .default('l', 'info')
    .default('d', 'file')
    .argv;

var logger = log4js.getLogger();
logger.level = argv.l;
var parser = new FrameParser();
var processingErrors = 0;

require('./index'); // route handler, courtesy of swagger.io

// create factory and register all (currently) known events
var factory = new EventFactory();

var saveSwitchState = (switchesEnabled, buf, category) => {
    if (switchesEnabled.length > 0) {
        var dbStatusEvent = new Event({
            _id: new mongoose.Types.ObjectId,
            source: 'panel',
            raw: buf,
            eventType: category,
            status: switchesEnabled,
            timestamp: new Date().getTime()
        });

        dbStatusEvent.save().then((doc) => {
            logger.trace('saved ', doc);
        }, (e) => {
            logger.info(`failed saving ${category} Event: ${e}`);
        });
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

// in reality, retrieve these from db at startup
var previousStatusMask = 0;
var presentTemp = {
    'pool temp': -1,
    'spa temp': -1,
    'ambient': -1
};

var maybeUpdateStatus = (statusChanges, newValue, statusName) => {
    if (newValue) {
        if (presentTemp[statusName] !== newValue) {
            statusChanges.push({
                name: statusName,
                value: newValue
            });
        } else {
            logger.info(`compressing ${statusName}`);
        }
        presentTemp[statusName] = newValue;
    }
}

var dispatchEvent = (buf) => {
    // change to a factory pattern and an observer pattern for action taken

    const event = factory.create(buf);
    if (!event) {
        logger.warn('cannot identify event');
        return false;
    }

    switch (event.constructor.name) {
        case 'DisplayUpdateEvent':
            {
                const salt = event.getSaltPPM();
                const ambientTemp = event.getAmbientTemp();
                const poolTemp = event.getPoolTemp();
                var statusChanges = [];

                logger.info('fixed screen: ', event.clearText(), salt ? salt : '', ambientTemp ? ambientTemp : '', poolTemp ? poolTemp : '');

                maybeUpdateStatus(statusChanges, poolTemp, 'pool temp');
                maybeUpdateStatus(statusChanges, salt, 'salt');
                maybeUpdateStatus(statusChanges, ambientTemp, 'ambient');

                if (statusChanges.length === 0) {
                    // always update the lastUpdated timestamp
                } else {
                    saveSwitchState(statusChanges, buf, 'info');
                }
            }
            break;
        case 'StatusEvent':
            const eventDiffs = event.diff(previousStatusMask);
            logger.info('status: ', event.asString(), ';', event.prettyBits(1));

            previousStatusMask = event.rawMask();
            logger.debug(eventDiffs);
            if (eventDiffs.nowEnabled.length > 0 || eventDiffs.nowDisabled.length > 0) {
                logger.debug('storing changes');
                const nowEnabled = switchStates(eventDiffs.nowEnabled, 1);
                const nowDisabled = switchStates(eventDiffs.nowDisabled, 0);

                saveSwitchState(nowEnabled.concat(nowDisabled), buf, 'status');
            } else {
                // always update the lastUpdated timestamp
            }
            break;
        case 'PingEvent':
            logger.debug('heartbeat');
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
                saveSwitchState(toggleBits, buf, 'control');
            }
            break;
        case 'UnidentifiedStatusEvent':
            logger.debug('unidentified status:');
            break;
        case 'UnidentifiedPingEvent':
            logger.debug('unidentified ping');
            break;
        default:
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
        }
    });
};

if (argv.d === 'file') {
    logger.info('starting file processing of', argv.f);
    fileHandler.listen(argv.f, handleHunk);
    logger.info(`processing found ${processingErrors} event errors`);
} else if (argv.d === 'tail') {
    logger.info('starting tail listening on', argv.f);
    tailHandler.listen(argv.f, handleHunk);
} else if (argv.d === 'serial') {
    logger.info('starting serial port listening to ', argv.f);
    serial.listen(argv.f, handleHunk);
} else if (argv.d === 'none') {
    logger.info('no new data forthcoming');
}
