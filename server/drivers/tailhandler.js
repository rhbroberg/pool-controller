var Tail = require('./tail');
const log4js = require('log4js');
var logger = log4js.getLogger();

var listen = ((filename, cb) => {
    logger.info('tailing file', filename);

    var tail = new Tail(filename, /\003/, { 'interval': 500 });
    tail.on('line', (data) => {
        logger.debug('got another tail hunk');
        cb(data);
    });
});

module.exports = { listen };
