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
export type UserRole = 'viewer' | 'user' | 'admin';

export type OAuthScope = 'account' | 'control' | 'admin';

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
    swagger?: {
        operation: unknown;
        params: Record<string, { value: unknown }>;
    };
}

/** API error body services throw via respondWithCode */
export interface ApiErrorBody {
    code: number;
    message: string;
}
