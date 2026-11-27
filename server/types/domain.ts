// Shared shapes used across services, the protocol layer and the REST API.

import type { Request } from 'express';

/** one switch or sensor reading as the API and live updates report it */
export interface Reading {
    name: string;
    category: string;
    value: number | boolean | string;
    timestamp: Date | string;
    message?: string;
}

/** geographic position from a configured zip code */
export interface GeoLocation {
    latitude: number;
    longitude: number;
    zipCode?: string;
    placeName?: string;
}

/** how fast each heat source warms a body of water, °F per hour */
export interface HeatingBodyRules {
    heater: number;
    heatPump: number;
}

export type HeatingRules = {
    pool: HeatingBodyRules;
    spa: HeatingBodyRules;
};

export type WeatherCondition =
    | 'sunny'
    | 'partly-cloudy'
    | 'cloudy'
    | 'fog'
    | 'rain'
    | 'snow'
    | 'storm';

/** account roles, each holding every OAuth2 scope of the roles before it */
export const USER_ROLES = ['viewer', 'user', 'admin'] as const;
export type UserRole = typeof USER_ROLES[number];

export type OAuthScope = 'account' | 'control' | 'admin';

/** everyday tasks the apps offer in place of single switches */
export const TASKS = ['pool', 'spaPreheat', 'spaParty'] as const;
export type TaskId = typeof TASKS[number];

/** bodies of water the heaters drive toward */
export const WATER_BODIES = ['pool', 'spa'] as const;
export type WaterBody = typeof WATER_BODIES[number];

/** heat sources with their own setpoints per body */
export const HEAT_DEVICES = ['heater1', 'heatpump'] as const;
export type HeatDevice = typeof HEAT_DEVICES[number];

/** panel keys the wireless remote and REST API can press */
export const PANEL_KEYS = ['menu', 'left', 'right', 'minus', 'plus'] as const;
export type PanelKey = typeof PANEL_KEYS[number];

/** water-flow modes the spillover key steps through */
export const WATER_MODES = ['pool', 'spa', 'spillover'] as const;
export type WaterMode = typeof WATER_MODES[number];

/** kinds of heating-model windows */
export const HEATING_SOURCES = ['heater', 'heatpump', 'both', 'cooling'] as const;
export type HeatingSource = typeof HEATING_SOURCES[number];

/** GET /heating estimate.status after atSetpoint is mapped to ready */
export type HeatingEstimateStatus = 'noReading' | 'ready' | 'unreachable' | 'insufficientData';

/** reprocess job lifecycle */
export type ReprocessRunState = 'waiting' | 'running' | 'finished' | 'failed';

/** one history point as stored/returned before the web client converts times */
export interface HistoryPoint {
    t: string | Date;
    v: number | null;
    min?: number | null;
    max?: number | null;
}

export interface HistorySeries {
    name: string;
    resolution?: number;
    before?: HistoryPoint | null;
    points: HistoryPoint[];
}

/** minimal user shape handlers attach to the request after authenticate */
export interface AuthUser {
    email: string;
    role: UserRole;
    mustChangeCredentials?: boolean;
    hasScope(scope: string): boolean;
}

export interface AuthedRequest extends Request {
    user?: AuthUser;
    token?: string;
    openapi?: {
        schema?: {
            operationId?: string;
            parameters?: unknown[];
            requestBody?: unknown;
            ['x-swagger-router-controller']?: string;
            ['x-codegen-request-body-name']?: string;
        };
        pathParams?: Record<string, unknown>;
    };
    /** set by the swagger router before every controller runs */
    swagger: {
        operation: unknown;
        params: Record<string, { value: unknown }>;
    };
}

/** API error body services throw via respondWithCode / ApiError */
export interface ApiErrorBody {
    code: number;
    message: string;
}

/** typed swagger param lookup used by controllers */
export function swaggerValue<T = unknown>(req: AuthedRequest, name: string): T {
    const params = req.swagger?.params;
    if (!params || !(name in params)) {
        throw new Error(`missing swagger param ${name}`);
    }
    return params[name].value as T;
}

/** message from an unknown catch / rejection value */
export function errorMessageOf(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
        return (error as { message: string }).message;
    }
    return String(error);
}
