const log4js = require('log4js');
var SerialPort = require('serialport');
var logger = log4js.getLogger();
var port;

var writeEvent = ((message) => {
    logger.trace('writing message', message.length, JSON.stringify(message));
    var result = port.write(message, 'binary', function(err) {
        if (err) {
            return logger.error('Error on write: ', err.message);
        }
        logger.trace('message written');
    });
    logger.trace('result of write is ', result);
    // per dox, only drain if write() returned false
    if (!result) {
        port.drain(() => {
            logger.trace('drain callback complete');
        });
    }
});

var listen = ((filename, cb) => {
    port = new SerialPort(filename, { baudRate: 19200, autoOpen: false });

    port.open(function(err) {
        if (err) {
            return logger.error('Error: ', err.message);
        }
    });

    // Switches the port into "flowing mode"
    port.on('data', function(data) {
        logger.trace('Data:', data);
        cb(data);
    });

    return port;
});

module.exports = { listen, writeEvent };
