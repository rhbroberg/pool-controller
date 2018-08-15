const fs = require('fs');
const log4js = require('log4js');
var logger = log4js.getLogger();
var { mongoose } = require('../mongoose'); // eslint-disable-line no-unused-vars

var listen = ((filename, cb) => {
    fs.readFile(filename, async (err, data) => {
        logger.info('starting');
        if (err)
        {
            logger.error(err);
            return;
        }
        await cb(data);
        logger.info('done with file reading');
        // easiest hack to allow app to complete; mongoose is keeping everything alive, and there's no (easy) way to determine when it's done
        setTimeout(function() {
            logger.info('so long and thanks for all the fish');
            mongoose.disconnect();
        }, 1000)
    });
});

module.exports = { listen };
