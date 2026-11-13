'use strict';
// Pushes changes to the apps the moment the controller reports them, over socket.io, so they
// needn't wait for their next poll:
//
//   readings  { readings }  entries as GET /status reports them: every switch when a status frame
//                           changes, the readings that changed on the display, or the check
//                           system reason when it or the check system switch changes
//   heating   the same body as GET /heating, once the switches or temperatures behind it change
//   tasks     the same body as GET /tasks, once the switches change or a preheat is scheduled,
//             cancelled or started
//
// The apps keep polling, less often, in case a push is missed.

const log4js = require('log4js');
var logger = log4js.getLogger();

// a status change and the display reading after it often arrive together; one heating push covers both
const HEATING_DELAY_MS = 150;

var io;
var sources = { heating: async () => null, tasks: async () => null };
var timers = {};

/**
 * io is the socket.io server; heating() and tasks() resolve with what GET /heating and
 * GET /tasks answer
 **/
exports.attach = function(server, { heating, tasks } = {}) {
    io = server;
    if (heating) {
        sources.heating = heating;
    }
    if (tasks) {
        sources.tasks = tasks;
    }
};

exports.readings = function(entries) {
    if (!io || !entries || entries.length === 0) {
        return;
    }
    io.emit('readings', { readings: entries });
    exports.heatingChanged();
    exports.tasksChanged();
};

// pushes `name` once, a moment after the first change asks for it
var pushSoon = (name) => {
    if (!io || timers[name]) {
        return;
    }
    timers[name] = setTimeout(async () => {
        timers[name] = undefined;
        try {
            const body = await sources[name]();
            if (body) {
                io.emit(name, body);
            }
        } catch (e) {
            logger.warn(`could not push ${name}: ${e.message}`);
        }
    }, HEATING_DELAY_MS);
    timers[name].unref();
};

exports.heatingChanged = function() {
    pushSoon('heating');
};

exports.tasksChanged = function() {
    pushSoon('tasks');
};
