import log4js from 'log4js';
import { SerialPort } from 'serialport';

const logger = log4js.getLogger();
let port: SerialPort | undefined;

const writeEvent = ((message: Buffer) => {
    logger.trace('writing message', message.length, JSON.stringify(message));
    var result = port!.write(message, function(err) {
        if (err) {
            return logger.error('Error on write: ', err.message);
        }
        logger.trace('message written');
    });
    logger.trace('result of write is ', result);
    // per dox, only drain if write() returned false
    if (!result) {
        port!.drain(() => {
            logger.trace('drain callback complete');
        });
    }
});

const listen = ((filename: string, cb: (data: Buffer) => void) => {
    port = new SerialPort({ path: filename, baudRate: 19200, autoOpen: false });

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

export { listen, writeEvent };
