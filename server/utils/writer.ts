'use strict';

import type { ServerResponse } from 'http';
import type { ApiErrorBody } from '../types/domain';

/**
 * an HTTP error the API answers with { code, message }; controllers write its code and body
 **/
export class ApiError extends Error {
    readonly code: number;

    constructor(code: number, message: string) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
    }

    get body(): ApiErrorBody {
        return { code: this.code, message: this.message };
    }

    /** historical name used by catch sites that read e.payload.message */
    get payload(): ApiErrorBody {
        return this.body;
    }
}

/** builds an ApiError to throw (or return) for a failed request */
export function fail(code: number, message: string): ApiError {
    return new ApiError(code, message);
}

/**
 * a non-200 success the OpenAPI handlers return, such as 202 Accepted; writeJson sends the
 * payload with this status code
 **/
export class ResponsePayload {
    code: number;
    payload: unknown;

    constructor(code: number, payload: unknown) {
        this.code = code;
        this.payload = payload;
    }
}

/**
 * wraps a payload in a ResponsePayload for non-error statuses, or an ApiError when the payload
 * is an { code, message } error body (the historical shape services throw)
 **/
export function respondWithCode(code: number, payload: unknown): ResponsePayload | ApiError {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const body = payload as Record<string, unknown>;
        if (typeof body.code === 'number' && typeof body.message === 'string' && code >= 400) {
            return new ApiError(code, body.message);
        }
    }
    return new ResponsePayload(code, payload);
}

export function writeJson(response: ServerResponse, arg1?: unknown, arg2?: number): void {
    if (arg1 instanceof ApiError) {
        writeJson(response, arg1.body, arg1.code);
        return;
    }
    if (arg1 instanceof ResponsePayload) {
        writeJson(response, arg1.payload, arg1.code);
        return;
    }

    let code: number | undefined;
    let payload: unknown;

    if (arg2 && Number.isInteger(arg2)) {
        code = arg2;
    } else if (arg1 && Number.isInteger(arg1)) {
        code = arg1 as number;
    }

    if (code && arg1) {
        payload = arg1;
    } else if (arg1) {
        payload = arg1;
    }

    if (!code) {
        code = 200;
    }
    if (typeof payload === 'object') {
        payload = JSON.stringify(payload, null, 2);
    }
    response.writeHead(code, { 'Content-Type': 'application/json' });
    response.end(payload as string | undefined);
}
