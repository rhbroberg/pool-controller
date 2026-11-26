import fs from 'fs';
import log4js from 'log4js';
import { mongoose } from '../mongoose';

const logger = log4js.getLogger();

const listen = ((filename: string, cb: (data: Buffer) => void | Promise<void>) => {
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
        }, 1000);
    });
});

export { listen };
