const fs = require('fs');
const log4js = require('log4js');
var logger = log4js.getLogger();

var listen = ((filename, cb) => {
    fs.readFile(filename, (err, data) => {
        logger.info('starting');
        if (err)
        {
            logger.error(err);
            return;
        }
        cb(data);

    });
});

module.exports = { listen };
