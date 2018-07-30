require('./config/config');

const { FrameParser } = require('./utils/parse');
const log4js = require('log4js');
const yargs = require('yargs');
const { StatusEvent, DisplayUpdateEvent, ControlEvent, MotorTelemetryEvent } = require('./utils/events');
const _ = require('lodash'); // eslint-disable-line no-unused-vars

var { mongoose } = require('./mongoose'); // eslint-disable-line no-unused-vars
var { ObjectID } = require('mongodb'); // eslint-disable-line no-unused-vars
var { Event } = require('./models/event');
var serial = require('./drivers/serial');
var fileHandler = require('./drivers/filehandler');
var tailHandler = require('./drivers/tailhandler');

var argv = yargs
    .default('f', __dirname + '/../test-data/sample-all-bin')
    .default('l', 'info')
    .default('d', 'file')
    .argv;

var logger = log4js.getLogger();
logger.level = argv.l;
var parser = new FrameParser();
var processingErrors = 0;

var isMessage = (buf, first, second) => {
    return (buf.readUInt8(2) === first && buf.readUInt8(3) === second) ? true : false;
};

var dispatchEvent = (buf) => {
    // change to a factory pattern and an observer pattern for action taken
    try {
        if (isMessage(buf, 0x01, 0x03)) {
            let event = new DisplayUpdateEvent(buf);
            const salt = event.getSaltPPM();
            const ambientTemp = event.getAmbientTemp();
            logger.info('fixed screen: ', event.clearText(), salt ? salt : '', ambientTemp ? ambientTemp : '');

            var statusChanges = [];
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

            if (statusChanges.length > 0) {
                var dbEvent = new Event({
                    _id: new mongoose.Types.ObjectId,
                    source: 'panel',
                    raw: buf,
                    eventType: 'status',
                    status: statusChanges
                });

                dbEvent.save().then((doc) => {
                    logger.trace('saved ', doc);
                }, (e) => {
                    logger.debug('failed saving Event: ', e);
                });
            }
        }

        if (isMessage(buf, 0x01, 0x02)) {
            let event = new StatusEvent(buf);
            logger.info('status: ', event.asString(), ';', event.prettyOnBits());
        }

        if (isMessage(buf, 0x01, 0x01)) {
            logger.debug('heartbeat');
        }

        if (isMessage(buf, 0x04, 0x0a)) {
            //    logger.info('wireless screen: ', buf.toString('ascii', 5, len - 5), '\n');
        }

        if (isMessage(buf, 0xe0, 0x18)) {
            let event = new MotorTelemetryEvent(buf); // eslint-disable-line no-unused-vars
            logger.info('motor: ', buf.toString('ascii', 4, buf.length - 2));
        }

        if (isMessage(buf, 0x83, 0x01)) {
            let event = new ControlEvent(buf);
            logger.info('control: ', event.prettyOnBits());
        }
    }
    catch (e) {
        processingErrors++;
        logger.error(`event exception '${e}' received, continuing`);
    }
    // if message is unrecognized, log out hex bytes
};

var handleHunk = (data) => {
    parser.parse(data, (buf) => {
        logger.debug(parser.toHexString());
        dispatchEvent(buf);
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
