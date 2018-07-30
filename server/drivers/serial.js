const log4js = require('log4js');
var SerialPort = require('serialport');
var logger = log4js.getLogger();

var writeEvent = ((port, message) => {
    port.write(message, function(err) {
        if (err) {
            return logger.error('Error on write: ', err.message);
        }
        logger.trace('message written');
    });
});

var listen = ((filename, cb) => {
    var port = new SerialPort(filename, {baudRate: 9600, autoOpen: false});

	port.open(function (err) {
        if (err) {
            return logger.error('Error: ', err.message);
        }
    });

    // Switches the port into "flowing mode"
    port.on('data', function(data) {
//        logger.info('Data:', data);
        cb(data);
    });

});

module.exports = { listen, writeEvent };
