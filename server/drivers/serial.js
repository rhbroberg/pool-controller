const log4js = require('log4js');
var SerialPort = require('serialport');
var logger = log4js.getLogger();
var port;

var writeEvent = ((message) => {
    port.write(message, function(err) {
        if (err) {
            return logger.error('Error on write: ', err.message);
        }
        logger.trace('message written');
    });
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
