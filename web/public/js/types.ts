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

export interface Location {
    zipCode?: string;
    countryCode?: string;
    placeName?: string;
    latitude?: number;
    longitude?: number;
}

export interface HeatingRule {
    heater?: number;
    heatPump?: number;
}

export interface HeatingRules {
    pool?: HeatingRule;
    spa?: HeatingRule;
}

/** GET /system/settings and PUT /system/settings */
export interface SystemSettings {
    timeZone?: string;
    timeZoneSource?: 'configured' | 'system' | 'default';
    detectedTimeZone?: string | null;
    rawRetentionDays?: number;
    minimumRetentionDays?: number;
    maximumRetentionDays?: number;
    location?: Location | null;
    heatingEstimateDisplay?: 'remaining' | 'readyAt';
    heatingRules?: HeatingRules;
    preheatMarginMinutes?: number;
}

export type SystemSettingsUpdate = Partial<{
    timeZone: string | null;
    rawRetentionDays: number;
    zipCode: string | null;
    heatingEstimateDisplay: 'remaining' | 'readyAt';
    heatingRules: HeatingRules;
    preheatMarginMinutes: number;
}>;

/** one maintenance job after the client turns ISO dates into Date */
export interface MaintenanceJob {
    name: string;
    description?: string;
    intervalSeconds?: number;
    scheduled?: boolean;
    running?: boolean;
    nextRunAt?: Date | null;
    lastStartedAt?: Date | null;
    lastFinishedAt?: Date | null;
    lastDurationMs?: number;
    lastResult?: 'ok' | 'failed';
    lastError?: string;
    lastSummary?: string;
    runs?: number;
    more?: boolean;
}

/** one heater or heat pump as GET /heating devices reports it */
export interface HeatingDeviceStatus {
    enabled?: boolean | null;
    heating?: boolean;
    callingForHeat?: boolean;
    body?: string | null;
    setpoint?: number | null;
    temperature?: number | null;
}

export interface HeatingStatus {
    estimate?: HeatingEstimate | null;
    devices?: Record<string, HeatingDeviceStatus>;
    setpoints?: Record<string, Record<string, number>>;
    [key: string]: unknown;
}

export interface ScheduledPreheat {
    readyAt: string | Date;
    startAt: string | Date;
    leadMinutes?: number;
    leadFrom?: string;
    fromTemperature?: number;
    setpoint?: number;
    requestedBy?: string | null;
}

export interface SpaPreheatTask {
    on?: boolean;
    scheduled?: ScheduledPreheat | null;
}

/** GET /tasks */
export interface TasksState {
    pool?: { on?: boolean };
    spaPreheat?: SpaPreheatTask;
    spaParty?: { on?: boolean };
    dark?: boolean;
}

export interface WeatherDay {
    date?: string;
    high?: number | null;
    low?: number | null;
    condition?: string | null;
    precipitationProbability?: number | null;
}

/** GET /weather */
export interface WeatherForecast {
    configured?: boolean;
    location?: { zipCode?: string; placeName?: string } | null;
    today?: WeatherDay | null;
    fetchedAt?: Date | string | null;
    stale?: boolean;
}

/** GET /system/info — commit and apiVersion are what aboutLine needs */
export interface SystemInfo {
    commit?: string | null;
    apiVersion?: string | null;
    [key: string]: unknown;
}

export interface HeatingBodyModel {
    available: boolean;
    reason?: string;
    heater?: number | null;
    heatPump?: { base: number; slope?: number; referenceAirTemperature?: number; minimumAirTemperature?: number | null } | null;
}

/** the model in HeatingModelState, for heating rules learned from history */
export interface HeatingModel {
    bodies?: {
        pool?: HeatingBodyModel;
        spa?: HeatingBodyModel;
    };
}

export interface AuthProvider {
    id: string;
    displayName?: string;
}
