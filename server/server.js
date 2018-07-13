const parse = require('./../parser/parse');
const fs = require('fs');
const log4js = require('log4js');
const yargs = require('yargs');
const { StatusEvent, DisplayUpdateEvent } = require('./utils/messages');

var argv = yargs
    .default('f', './test-data/test-data/sample-mid-bin')
    .default('d', 'info')
    .argv;

var logger = log4js.getLogger();
logger.level = argv.d;

var isMessage = (buf, first, second) => {
    return (buf.readUInt8(0) === first && buf.readUInt8(1) === second) ? true : false;
};

fs.readFile(argv.f, (err, data) => {
    logger.info('starting');
    if (err)
    {
        logger.error(err);
        return;
    }
    parse.parse(data, (buf, len) => {
        logger.debug(parse.frameToString(buf, len));

        if (isMessage(buf, 0x01, 0x03)) {
            let event = new DisplayUpdateEvent(buf);
            const salt = event.getSaltPPM();
            const ambientTemp = event.getAmbientTemp();
            logger.info('fixed screen: ', buf.toString('ascii', 2, len - 2), salt ? salt : '', ambientTemp ? ambientTemp : '');
        }

        if (isMessage(buf, 0x01, 0x02)) {
            let event = new StatusEvent(buf);
            logger.info('status: ', event.printAllBits(), ';', event.prettyOnBits());
        }

        if (isMessage(buf, 0x01, 0x01)) {
            logger.debug('heartbeat');
        }

        if (isMessage(buf, 0x04, 0x0a)) {
            //    logger.info('wireless screen: ', buf.toString('ascii', 5, len - 5), '\n');
        }

        if (isMessage(buf, 0xe0, 0x18)) {
            logger.info('motor: ', buf.toString('ascii', 2, len - 2));
        }
    });
});
