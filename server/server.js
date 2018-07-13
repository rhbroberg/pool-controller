const { FrameParser } = require('./utils/parse');
const fs = require('fs');
const log4js = require('log4js');
const yargs = require('yargs');
const { StatusEvent, DisplayUpdateEvent, ControlEvent } = require('./utils/events');

var argv = yargs
    .default('f', __dirname + '/../test-data/sample-all-bin')
    .default('d', 'info')
    .argv;

var logger = log4js.getLogger();
logger.level = argv.d;
var parser = new FrameParser();

var isMessage = (buf, first, second) => {
    return (buf.readUInt8(2) === first && buf.readUInt8(3) === second) ? true : false;
};

fs.readFile(argv.f, (err, data) => {
    logger.info('starting');
    if (err)
    {
        logger.error(err);
        return;
    }
    parser.parse(data, (buf, len) => {
        logger.debug(parser.toHexString());

        try {
            if (isMessage(buf, 0x01, 0x03)) {
                let event = new DisplayUpdateEvent(buf, len);
                const salt = event.getSaltPPM();
                const ambientTemp = event.getAmbientTemp();
                logger.info('fixed screen: ', buf.toString('ascii', 4, len - 2), salt ? salt : '', ambientTemp ? ambientTemp : '');
            }

            if (isMessage(buf, 0x01, 0x02)) {
                let event = new StatusEvent(buf, len);
                logger.info('status: ', event.asString(), ';', event.prettyOnBits());
            }

            if (isMessage(buf, 0x01, 0x01)) {
                logger.debug('heartbeat');
            }

            if (isMessage(buf, 0x04, 0x0a)) {
                //    logger.info('wireless screen: ', buf.toString('ascii', 5, len - 5), '\n');
            }

            if (isMessage(buf, 0xe0, 0x18)) {
                logger.info('motor: ', buf.toString('ascii', 4, len - 2));
            }

            if (isMessage(buf, 0x83, 0x01)) {
                let event = new ControlEvent(buf, len);
                logger.info('control: ', event.asString());
            }
        } catch (e) {
            logger.error('event exception received, continuing');
        }
        // if message is unrecognized, log out hex bytes
    });
});
