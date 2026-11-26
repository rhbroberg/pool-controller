'use strict';

import type { ServerResponse } from 'http';

export class ResponsePayload {
    code: number;
    payload: unknown;

    constructor(code: number, payload: unknown) {
        this.code = code;
        this.payload = payload;
    }
}

export function respondWithCode(code: number, payload: unknown): ResponsePayload {
    return new ResponsePayload(code, payload);
}

export function writeJson(response: ServerResponse, arg1?: unknown, arg2?: number): void {
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
