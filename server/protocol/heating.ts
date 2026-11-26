'use strict';
// The heater and heat pump are in series, so both send their heat to the same water. Each has
// its own setpoint for the pool and for the spa, and drives toward the one for whichever body
// the water is flowing through.

const BODIES = ['pool', 'spa'];
const DEVICES = ['heater1', 'heatpump'];
const SETPOINT_MIN_F = 65;
const SETPOINT_MAX_F = 104;

const bodyLabels = { pool: 'pool', spa: 'spa' };
const deviceLabels = { heater1: 'heater', heatpump: 'heat pump' };

/**
 * the body whose setpoint the heaters drive toward: the spa while the spa filter runs; otherwise,
 * while the filter runs, the spa in spa flow and the pool in pool or spillover flow. With neither
 * pump running no water reaches the heaters, so there is none.
 *
 * state  { filter, spaFilter, waterMode }
 * returns 'pool', 'spa' or undefined
 **/
var targetBody = ({ filter, spaFilter, waterMode }) => {
    if (spaFilter) {
        return 'spa';
    }
    if (filter) {
        return waterMode === 'spa' ? 'spa' : 'pool';
    }
    return undefined;
};

/**
 * an enabled heater calls for heat only while its body is below the setpoint, and calls again
 * once the water cools below it
 **/
var callsForHeat = (temperature, setpoint) =>
    typeof temperature === 'number' && typeof setpoint === 'number' && temperature < setpoint;

var isSetpoint = (degrees) =>
    Number.isInteger(degrees) && degrees >= SETPOINT_MIN_F && degrees <= SETPOINT_MAX_F;

module.exports = {
    BODIES,
    DEVICES,
    SETPOINT_MIN_F,
    SETPOINT_MAX_F,
    bodyLabels,
    deviceLabels,
    targetBody,
    callsForHeat,
    isSetpoint
};
