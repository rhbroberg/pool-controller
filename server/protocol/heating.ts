'use strict';
// The heater and heat pump are in series, so both send their heat to the same water. Each has
// its own setpoint for the pool and for the spa, and drives toward the one for whichever body
// the water is flowing through.

import { WATER_BODIES, HEAT_DEVICES } from '../types/domain';
import type { WaterBody, HeatDevice } from '../types/domain';

export type { WaterBody, HeatDevice };

const BODIES: WaterBody[] = [...WATER_BODIES];
const DEVICES: HeatDevice[] = [...HEAT_DEVICES];
const SETPOINT_MIN_F = 65;
const SETPOINT_MAX_F = 104;

const bodyLabels: Record<WaterBody, string> = { pool: 'pool', spa: 'spa' };
const deviceLabels: Record<HeatDevice, string> = { heater1: 'heater', heatpump: 'heat pump' };

export interface FlowState {
    filter: boolean;
    spaFilter: boolean;
    waterMode?: string;
}

/**
 * the body whose setpoint the heaters drive toward: the spa while the spa filter runs; otherwise,
 * while the filter runs, the spa in spa flow and the pool in pool or spillover flow. With neither
 * pump running no water reaches the heaters, so there is none.
 *
 * state  { filter, spaFilter, waterMode }
 * returns 'pool', 'spa' or undefined
 **/
const targetBody = ({ filter, spaFilter, waterMode }: FlowState): WaterBody | undefined => {
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
const callsForHeat = (temperature: number | undefined, setpoint: number | undefined): boolean =>
    typeof temperature === 'number' && typeof setpoint === 'number' && temperature < setpoint;

const isSetpoint = (degrees: unknown): degrees is number =>
    Number.isInteger(degrees) && (degrees as number) >= SETPOINT_MIN_F && (degrees as number) <= SETPOINT_MAX_F;

export {
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
