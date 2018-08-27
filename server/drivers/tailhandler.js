var Tail = require('./tail');
const log4js = require('log4js');
var logger = log4js.getLogger();
const { PingEvent, StatusEvent, DisplayUpdateEvent, ControlEvent, MotorTelemetryEvent, UnidentifiedPingEvent, UnidentifiedStatusEvent } = require('../protocol/events'); // eslint-disable-line no-unused-vars

var listen = ((filename, cb) => {
    logger.info('tailing file', filename);

    var tail = new Tail(filename, /\003/, { 'interval': 500 });
    tail.on('line', (data) => {
        logger.debug('got another tail hunk');
        cb(data);
    });
});

var writeEvent = ((message) => {
    const myControl = new ControlEvent(message);
    logger.info('writing control event: ', myControl.asString());
});

module.exports = { listen, writeEvent };
