// Shared shapes the status store, API client and views share.

export type UserRole = 'viewer' | 'user' | 'admin';

/** what's kept of a sign-in after login or ticket exchange */
export interface Credentials {
    email: string;
    token: string;
    role: UserRole | string | null;
    methods?: string[] | null;
}

export interface SignInResult {
    email: string;
    token: string;
    role?: UserRole | string;
    methods?: string[];
    mustChangeCredentials?: boolean;
}

/** one switch or sensor reading as GET /status and live updates send it */
export interface Reading {
    name: string;
    category: string;
    value: number;
    timestamp: Date | null;
    message?: string;
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/** GET /heating estimate.status after the server maps atSetpoint → ready */
export type HeatingEstimateStatus =
    | 'noReading'
    | 'ready'
    | 'unreachable'
    | 'insufficientData';

/** heating estimate as GET /heating reports it; status drives which fields matter */
export type HeatingEstimate =
    | { status: 'noReading'; body: string; temperature: number | null; setpoint: number; readyAt?: null; minutes?: null; reachesAtMost?: null; settling?: boolean; timeZone?: string }
    | { status: 'ready'; body: string; temperature: number | null; setpoint: number; minutes: number; readyAt: string; reachesAtMost?: null; settling?: boolean; timeZone?: string }
    | { status: 'unreachable'; body: string; temperature: number | null; setpoint: number; reachesAtMost: number | null; minutes?: null; readyAt?: null; settling?: boolean; timeZone?: string }
    | { status: 'insufficientData'; body: string; temperature: number | null; setpoint: number; minutes?: null; readyAt?: null; reachesAtMost?: null; settling?: boolean; timeZone?: string };

export type ReprocessRunState = 'waiting' | 'running' | 'finished' | 'failed';

export type ReprocessTransition = { from: string; to: string; count: number };

/** reprocess run; switch on state for what the page shows next */
export type ReprocessRun =
    | { state: 'waiting'; dryRun: boolean; through?: Date | string | null; transitions: ReprocessTransition[]; examined?: number; updated?: number; removed?: number; unchanged?: number; error?: string | null }
    | { state: 'running'; dryRun: boolean; through?: Date | string | null; transitions: ReprocessTransition[]; examined?: number; updated?: number; removed?: number; unchanged?: number; error?: string | null }
    | { state: 'finished'; dryRun: boolean; examined: number; updated: number; removed: number; unchanged: number; transitions: ReprocessTransition[]; error?: string | null }
    | { state: 'failed'; dryRun: boolean; error: string; transitions: ReprocessTransition[]; examined?: number; updated?: number; removed?: number; unchanged?: number };

/** one history point as the API returns it (ISO times, min/max for buckets) */
export interface HistoryPoint {
    t: string | Date;
    v: number | null;
    min?: number | null;
    max?: number | null;
}

/** one history sample after the client converts ISO times to epoch ms */
export interface HistorySample {
    t: number;
    v: number | null;
    low: number | null;
    high: number | null;
}

export interface HistorySeries {
    name: string;
    resolution: number;
    before: HistorySample | null;
    points: HistorySample[];
}

export interface HistoryResponse {
    from: number;
    to: number;
    timeZone: string | null;
    earliest: number | null;
    series: HistorySeries[];
}

/** live push payloads the store understands */
export type LiveReadingsPush = { readings: Array<{ name: string; category: string; value: unknown; timestamp?: unknown; message?: string }> };

/** narrow an unknown catch value to an Error-like message when present */
export const errorMessageOf = (error: unknown): string | undefined => {
    if (error instanceof Error) {
        return error.message;
    }
    if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
        return (error as { message: string }).message;
    }
    return undefined;
};

export const errorNameOf = (error: unknown): string | undefined => {
    if (error && typeof error === 'object' && 'name' in error && typeof (error as { name: unknown }).name === 'string') {
        return (error as { name: string }).name;
    }
    return undefined;
};
