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

var storeEnabledSwitches = (buf, category, enabled) => {
    var switchesEnabled = [];

    // need to determine the last time a bit was turned on (keep cache); when it goes off, the event needs to include that bit changing state
    enabled.forEach(function(name) {
        switchesEnabled.push({
            name: name,
            value: 1
        });
    });

    saveSwitchState(switchesEnabled, buf, category);
};

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

                if (poolTemp) {
                    statusChanges.push({
                        name: 'pool temp',
                        value: poolTemp
                    });
                }

                if (salt) {
                    statusChanges.push({
                        name: 'salt',
                        value: salt
                    });
                }

                if (ambientTemp) {
                    statusChanges.push({
                        name: 'ambient',
                        value: ambientTemp
                    });
                }

                saveSwitchState(statusChanges, buf, 'info');
            }
            break;
        case 'StatusEvent':
            logger.info('status: ', event.asString(), ';', event.prettyOnBits());
            storeEnabledSwitches(buf, 'status', event.enabledSwitches());
            break;
        case 'PingEvent':
            logger.debug('heartbeat');
            break;
        case 'MotorTelemetryEvent':
            logger.info('motor: ', buf.toString('ascii', 4, buf.length - 2));
            break;
        case 'ControlEvent':
            logger.info('control: ', event.prettyOnBits());
            storeEnabledSwitches(buf, 'control', event.enabledSwitches());
            break;
        case 'UnidentifiedStatusEvent':
            logger.info('unidentified status: ');
            break;
        case 'UnidentifiedPingEvent':
            logger.info('unidentified ping');
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
}
