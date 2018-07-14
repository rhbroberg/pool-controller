var Tail = require('./../utils/tail');
const log4js = require('log4js');
var logger = log4js.getLogger();

var listen = ((filename, cb) => {
    logger.info('tailing file', filename);

    var tail = new Tail(filename, /\003/);
    tail.on('line', (data) => {
        logger.info('got another tail hunk');
        cb(data);
    });
});

module.exports = { listen };
