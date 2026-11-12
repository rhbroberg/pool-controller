'use strict';
// Pushes changes to the apps the moment the controller reports them, over socket.io, so they
// needn't wait for their next poll:
//
//   readings  { readings }  entries as GET /status reports them: every switch when a status frame
//                           changes, the readings that changed on the display, or the check
//                           system reason when it or the check system switch changes
//   heating   the same body as GET /heating, once the switches or temperatures behind it change
//
// The apps keep polling, less often, in case a push is missed.

const log4js = require('log4js');
var logger = log4js.getLogger();

// a status change and the display reading after it often arrive together; one heating push covers both
const HEATING_DELAY_MS = 150;

var io;
var heatingSource = async () => null;
var heatingTimer;

/**
 * io is the socket.io server; heating() resolves with what GET /heating answers
 **/
exports.attach = function(server, { heating } = {}) {
    io = server;
    if (heating) {
        heatingSource = heating;
    }
};

exports.readings = function(entries) {
    if (!io || !entries || entries.length === 0) {
        return;
    }
    io.emit('readings', { readings: entries });
    exports.heatingChanged();
};

exports.heatingChanged = function() {
    if (!io || heatingTimer) {
        return;
    }
    heatingTimer = setTimeout(async () => {
        heatingTimer = undefined;
        try {
            const heating = await heatingSource();
            if (heating) {
                io.emit('heating', heating);
            }
        } catch (e) {
            logger.warn(`could not push heating: ${e.message}`);
        }
    }, HEATING_DELAY_MS);
    heatingTimer.unref();
};
