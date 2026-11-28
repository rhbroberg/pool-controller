// The pool server's REST API, reached through the web service that serves this page.

import type { HistoryPoint, HistoryResponse, HistorySample, HistorySeries, Reading, ReprocessRun, SignInResult } from './types.js';
import { errorNameOf } from './types.js';

export const API_PATH = '/rhbroberg/pool-api/1.0.0';
const DEFAULT_TIMEOUT_MS = 10000;
const UNREACHABLE_HEADER = 'x-pool-web-unreachable';

const capitalized = (text?: string | null) => text ? text.charAt(0).toUpperCase() + text.slice(1) : text;

/** kind is unreachable, unauthorized (401) or server (any other failure the server reported) */
export type ApiErrorKind = 'unreachable' | 'unauthorized' | 'server';

/**
 * kind is unreachable (no answer from the pool server), unauthorized (401) or server (any other
 * failure the server reported)
 **/
export class ApiError extends Error {
    kind: ApiErrorKind;
    status?: number;
    constructor(kind: ApiErrorKind, { status, message }: { status?: number; message?: string } = {}) {
        super(capitalized(message) || ApiError.defaultMessage(kind, status));
        this.kind = kind;
        this.status = status;
    }

    static defaultMessage(kind: ApiErrorKind, status?: number) {
        switch (kind) {
        case 'unreachable': return 'The pool server isn’t answering.';
        case 'unauthorized': return 'Sign in to control equipment.';
        case 'server': return `The server returned HTTP ${status}.`;
        default: {
            const _exhaustive: never = kind;
            return _exhaustive;
        }
        }
    }
}

export const isAbort = (error: unknown) => {
    const name = errorNameOf(error);
    return name === 'AbortError' || name === 'TimeoutError';
};

export const toDate = (value: string | number | Date | null | undefined) => value ? new Date(value) : null;

/** a reading as GET /status and the live updates send it, with its value a number */
export const toReading = (reading: { name: string; category: string; value: unknown; timestamp?: unknown; message?: string }): Reading => ({
    name: reading.name,
    category: reading.category,
    value: Number(reading.value),
    timestamp: toDate(reading.timestamp as string | number | Date | null | undefined),
    message: reading.message
});

const anySignal = (signals: AbortSignal[]) => {
    if (AbortSignal.any) {
        return AbortSignal.any(signals);
    }
    const controller = new AbortController();
    signals.forEach((signal) => {
        if (signal.aborted) {
            controller.abort(signal.reason);
        } else {
            signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
        }
    });
    return controller.signal;
};

export class Client {
    origin: string;
    fetch: typeof fetch;
    /**
     * origin is empty in the browser, where the API shares the page's origin
     **/
    constructor(origin = '', fetchImpl: typeof fetch = ((input, init) => fetch(input, init)) as typeof fetch) {
        this.origin = origin;
        this.fetch = fetchImpl;
    }

    url(path: string, query?: Record<string, any> | null) {
        let url = `${this.origin}${API_PATH}/${path}`;
        if (query) {
            const params = new URLSearchParams();
            Object.entries(query).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    params.set(key, String(value));
                }
            });
            const text = params.toString();
            if (text) {
                url += `?${text}`;
            }
        }
        return url;
    }

    async send<T = any>(method: string, path: string, { token, body, query, timeout = DEFAULT_TIMEOUT_MS, signal }: { token?: string | null; body?: unknown; query?: Record<string, string | number | boolean | undefined | null>; timeout?: number; signal?: AbortSignal } = {}): Promise<T> {
        const headers: Record<string, string> = {
            Accept: 'application/json',
            // the server's validator rejects any request without a JSON content type, body or not
            'Content-Type': 'application/json'
        };
        if (token) {
            headers['x-auth'] = token;
        }
        const signals = [AbortSignal.timeout(timeout)];
        if (signal) {
            signals.push(signal);
        }
        let response;
        try {
            response = await this.fetch(this.url(path, query), {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: anySignal(signals),
                cache: 'no-store'
            });
        } catch (error: unknown) {
            if (signal && signal.aborted) {
                throw error;
            }
            const message = errorNameOf(error) === 'TimeoutError' ? 'The pool server didn’t answer in time.' : 'Can’t reach the web service.';
            throw new ApiError('unreachable', { message });
        }
        const text = await response.text();
        let data: unknown;
        try {
            data = text ? JSON.parse(text) : undefined;
        } catch {
            data = undefined;
        }
        if (response.ok) {
            return data as T;
        }
        const message = data && typeof data === 'object' && data !== null && 'message' in data && typeof (data as { message: unknown }).message === 'string'
            ? (data as { message: string }).message
            : undefined;
        if (response.headers.get(UNREACHABLE_HEADER)) {
            throw new ApiError('unreachable', { status: response.status, message });
        }
        if (response.status === 401) {
            throw new ApiError('unauthorized', { status: 401, message });
        }
        throw new ApiError('server', { status: response.status, message });
    }

    // MARK: status

    async fetchStatus(): Promise<Reading[]> {
        const readings = await this.send('GET', 'status');
        return readings.map(toReading);
    }

    async fetchSystemInfo() {
        const info = await this.send('GET', 'system/info');
        return { ...info, startedAt: toDate(info.startedAt) };
    }

    fetchHeating() {
        return this.send('GET', 'heating');
    }

    /** the heating model in use, { model, defaultRange }; model is null until one is saved */
    fetchHeatingModel() {
        return this.send('GET', 'heating/model');
    }

    /** whether each task is on, and a spa preheat waiting for its time */
    fetchTasks() {
        return this.send('GET', 'tasks');
    }

    /** turns a task on or off; a spa preheat with readyAt (a Date) waits until it must start */
    setTask(task: string, on: boolean, readyAt: Date | string | null | undefined, token: string) {
        const body = readyAt ? { on, readyAt: new Date(readyAt).toISOString() } : { on };
        return this.send('PUT', `tasks/${task}`, { token, body });
    }

    /** today's forecast at the pool's zip code: { configured, location, today, fetchedAt, stale } */
    async fetchWeather() {
        const weather = await this.send('GET', 'weather');
        const today = weather.today ? { ...weather.today, sunrise: toDate(weather.today.sunrise), sunset: toDate(weather.today.sunset) } : null;
        return { ...weather, today, fetchedAt: toDate(weather.fetchedAt) };
    }

    // MARK: control

    setDevice(name: string, on: boolean, token: string) {
        return this.send('PUT', `devices/${encodeURIComponent(name)}/${on}`, { token });
    }

    setWaterMode(mode: string, token: string) {
        return this.send('PUT', `water/mode/${mode}`, { token });
    }

    setSetpoint(degrees: number, device: string, body: string, token: string) {
        // Settings-menu navigation on a live panel often needs a minute; the default 10s is too short
        return this.send('PUT', `heating/setpoints/${body}/${device}/${degrees}`, { token, timeout: 150000 });
    }

    // MARK: panel

    async fetchPanelDisplay() {
        const display = await this.send('GET', 'panel/display');
        return { ...display, timestamp: toDate(display.timestamp) };
    }

    pressPanelKey(key: string, token: string) {
        return this.send('PUT', `panel/keys/${key}`, { token });
    }

    // MARK: history

    /**
     * readings for each name from `from` up to `to`, plus each one's value as the window opens;
     * times come back as milliseconds since the epoch. A series with more than maxPoints
     * readings comes back as buckets at least resolution seconds long: each point is the
     * bucket's time-weighted average, with its lowest (low) and highest (high) value.
     **/
    async fetchHistory(names: string[], from: Date | string | number, to: Date | string | number, { signal, maxPoints, resolution }: { signal?: AbortSignal; maxPoints?: number; resolution?: number } = {}): Promise<HistoryResponse> {
        const response = await this.send<{
            from: string;
            to: string;
            timeZone?: string;
            earliest?: string;
            series?: Array<{ name: string; resolution?: number; before?: HistoryPoint | null; points?: HistoryPoint[] }>;
        }>('GET', 'history', {
            query: { names: names.join(','), from: new Date(from).toISOString(), to: new Date(to).toISOString(), maxPoints, resolution },
            timeout: 30000,
            signal
        });
        const point = (p: HistoryPoint | null | undefined): HistorySample | null => p ? {
            t: Date.parse(String(p.t)),
            v: p.v,
            low: p.min ?? null,
            high: p.max ?? null
        } : null;
        return {
            from: Date.parse(response.from),
            to: Date.parse(response.to),
            timeZone: response.timeZone || null,
            earliest: response.earliest ? Date.parse(response.earliest) : null,
            series: (response.series || []).map((series): HistorySeries => ({
                name: series.name,
                resolution: series.resolution || 0,
                before: point(series.before),
                points: (series.points || []).map((p) => point(p)!).filter(Boolean)
            }))
        };
    }

    /** the days (YYYY-MM-DD, in the server's time zone) with these readings, or any water reading when names is omitted */
    fetchAvailability(from: Date | string | number, to: Date | string | number, names?: string[]) {
        return this.send('GET', 'history/availability', {
            query: {
                names: names && names.length ? names.join(',') : undefined,
                from: new Date(from).toISOString(),
                to: new Date(to).toISOString()
            }
        });
    }

    async fetchEvents({ types, user, cursor, ascending, limit }: { types: string[]; user?: string; cursor?: string; ascending?: boolean; limit?: number }) {
        const page = await this.send('GET', 'events', {
            query: { types: types.join(','), order: ascending ? 'asc' : 'desc', limit, user, cursor }
        });
        return { ...page, events: page.events.map((event: any) => ({ ...event, timestamp: toDate(event.timestamp) })) };
    }

    fetchEventUsers() {
        return this.send('GET', 'events/users');
    }

    // MARK: accounts

    signIn(email: string, password: string): Promise<SignInResult> {
        return this.send('POST', 'users/login', { body: { email, password } });
    }

    /**
     * renames the signed-in account and sets its password; returns a new token, since the old
     * one stops working
     **/
    changeCredentials(name: string, password: string, token: string): Promise<SignInResult> {
        return this.send('PUT', 'users/me/credentials', { token, body: { email: name, password } });
    }

    fetchAccount(token: string): Promise<{ email: string; role: string; methods?: string[] }> {
        return this.send('GET', 'users/me', { token });
    }

    signOut(token: string) {
        return this.send('DELETE', 'users/me/token', { token });
    }

    /** every account, archived ones too, which an older server leaves out or doesn't have */
    listAccounts(token: string) {
        return this.send('GET', 'users', { token, query: { archived: 'include' } });
    }

    /** expiresAt is a Date, or null for an account that doesn't expire */
    createAccount(name: string, password: string, role: string, token: string, expiresAt: Date | null = null) {
        const body: { email: string; password: string; role: string; expiresAt?: string } = { email: name, password, role };
        if (expiresAt) {
            body.expiresAt = expiresAt.toISOString();
        }
        return this.send('POST', 'users', { token, body });
    }

    /** an operator with a generated name and a one-time code for its link; expiresAt is a Date, or null for never */
    createGuest(expiresAt: Date | null, token: string) {
        return this.send('POST', 'users/guests', { token, body: { expiresAt: expiresAt ? expiresAt.toISOString() : null } });
    }

    /** expiresAt, if given, is a Date or null for none */
    updateAccount(name: string, { role, password, expiresAt }: { role?: string; password?: string; expiresAt?: Date | null }, token: string) {
        const changes: Record<string, string | null> = {};
        if (role) {
            changes.role = role;
        }
        if (password) {
            changes.password = password;
        }
        if (expiresAt !== undefined) {
            changes.expiresAt = expiresAt ? expiresAt.toISOString() : null;
        }
        return this.send('PUT', `users/${encodeURIComponent(name)}`, { token, body: changes });
    }

    deleteAccount(name: string, token: string) {
        return this.send('DELETE', `users/${encodeURIComponent(name)}`, { token });
    }

    deleteArchivedAccounts(token: string) {
        return this.send('DELETE', 'users/archived', { token });
    }

    /** signs a guest in with the code from its link; the token is only good for setting a password */
    signInAsGuest(name: string, code: string): Promise<SignInResult> {
        return this.send('POST', 'users/login/guest', { body: { email: name, code } });
    }

    // MARK: sign-in services

    /** { passwordSignIn, providers: [{ id, displayName }] }: what the sign-in form offers */
    fetchSignInChoices() {
        return this.send('GET', 'auth/providers');
    }

    /** where the browser goes to sign in with a service; it comes back to #/signin/complete */
    signInUrl(provider: string) {
        return this.url(`auth/${encodeURIComponent(provider)}/start`, { client: 'web' });
    }

    /** trades the ticket a sign-in through a service came back with for a token */
    signInWithTicket(ticket: string): Promise<SignInResult> {
        return this.send('POST', 'users/login/external', { body: { ticket } });
    }

    /** resolves with { url } to send the browser to, to add the service to this account */
    linkIdentity(provider: string, token: string) {
        return this.send('POST', `users/me/identities/${encodeURIComponent(provider)}`, { token, body: { client: 'web' } });
    }

    unlinkIdentity(provider: string, token: string) {
        return this.send('DELETE', `users/me/identities/${encodeURIComponent(provider)}`, { token });
    }

    async listRequests(token: string) {
        const requests = await this.send('GET', 'users/requests', { token });
        return requests.map((request: any) => ({ ...request, firstSeen: toDate(request.firstSeen), lastSeen: toDate(request.lastSeen) }));
    }

    approveRequest(id: string, role: string, token: string) {
        return this.send('POST', `users/requests/${encodeURIComponent(id)}/approve`, { token, body: { role } });
    }

    denyRequest(id: string, token: string) {
        return this.send('POST', `users/requests/${encodeURIComponent(id)}/deny`, { token });
    }

    forgetRequest(id: string, token: string) {
        return this.send('DELETE', `users/requests/${encodeURIComponent(id)}`, { token });
    }

    listInvitations(token: string) {
        return this.send('GET', 'users/invitations', { token });
    }

    /** provider null works with any service trusted for email addresses */
    createInvitation({ email, role, provider }: { email: string; role: string; provider?: string | null }, token: string) {
        return this.send('POST', 'users/invitations', { token, body: { email, role, provider: provider || null } });
    }

    deleteInvitation(id: string, token: string) {
        return this.send('DELETE', `users/invitations/${encodeURIComponent(id)}`, { token });
    }

    fetchSignInSettings(token: string) {
        return this.send('GET', 'system/sign-in', { token });
    }

    /** changes: { passwordSignIn } and/or { signInRequests: 'ask' | 'refuse' } */
    updateSignInSettings(changes: Record<string, any>, token: string) {
        return this.send('PUT', 'system/sign-in', { token, body: changes });
    }

    createSignInService(service: any, token: string) {
        return this.send('POST', 'system/sign-in/providers', { token, body: service, timeout: 20000 });
    }

    updateSignInService(id: string, changes: any, token: string) {
        return this.send('PUT', `system/sign-in/providers/${encodeURIComponent(id)}`, { token, body: changes, timeout: 20000 });
    }

    deleteSignInService(id: string, token: string) {
        return this.send('DELETE', `system/sign-in/providers/${encodeURIComponent(id)}`, { token });
    }

    // MARK: system

    async factoryReset(token: string) {
        const result = await this.send('POST', 'system/factory-reset', { token });
        return (result && result.message) || 'Factory reset complete.';
    }

    restartServer(token: string) {
        return this.send('POST', 'system/restart', { token });
    }

    /** the time zone history days follow, how long raw history is kept and the weather's location */
    fetchSettings(token: string) {
        return this.send('GET', 'system/settings', { token });
    }

    /**
     * changes: { timeZone } (null for the server's own zone), { rawRetentionDays } and/or
     * { zipCode } (null to stop fetching weather); a new zip code is looked up before this answers
     **/
    updateSettings(changes: Record<string, any>, token: string) {
        return this.send('PUT', 'system/settings', { token, body: changes, timeout: 20000 });
    }

    async fetchJobs(token: string) {
        const jobs = await this.send('GET', 'system/jobs', { token });
        return jobs.map(withJobDates);
    }

    /** runs a maintenance job now; answers once it has finished */
    async runJob(name: string, token: string) {
        return withJobDates(await this.send('POST', `system/jobs/${encodeURIComponent(name)}/run`, { token, timeout: 120000 }));
    }

    /**
     * reads stored frames from `from` up to `to` again, rewriting events of eventTypes (every kind
     * when empty); with dryRun, only counts what would change. Answers at once with the run
     **/
    async startReprocess({ from, to, eventTypes, dryRun }: { from: Date | string | number; to: Date | string | number; eventTypes?: string[]; dryRun?: boolean }, token: string): Promise<ReprocessRun & { from: Date | null; to: Date | null; through: Date | null }> {
        const body: Record<string, unknown> = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), dryRun: Boolean(dryRun) };
        if (eventTypes && eventTypes.length) {
            body.eventTypes = eventTypes;
        }
        return withRunDates(await this.send<ReprocessRun & Record<string, unknown>>('POST', 'system/reprocess', { token, body }));
    }

    /** the reprocessing run under way or the last one, or null when there hasn't been one */
    async fetchReprocess(token: string) {
        try {
            return withRunDates(await this.send<ReprocessRun & Record<string, unknown>>('GET', 'system/reprocess', { token }));
        } catch (error: unknown) {
            if (error instanceof ApiError && error.status === 404) {
                return null;
            }
            throw error;
        }
    }
}

const withRunDates = <T extends Record<string, unknown>>(run: T) => ({
    ...run,
    from: toDate(run.from as string | number | Date | null | undefined),
    to: toDate(run.to as string | number | Date | null | undefined),
    requestedAt: toDate(run.requestedAt as string | number | Date | null | undefined),
    startedAt: toDate(run.startedAt as string | number | Date | null | undefined),
    finishedAt: toDate(run.finishedAt as string | number | Date | null | undefined),
    through: toDate(run.through as string | number | Date | null | undefined)
});

const withJobDates = <T extends Record<string, unknown>>(job: T) => ({
    ...job,
    nextRunAt: toDate(job.nextRunAt as string | number | Date | null | undefined),
    lastStartedAt: toDate(job.lastStartedAt as string | number | Date | null | undefined),
    lastFinishedAt: toDate(job.lastFinishedAt as string | number | Date | null | undefined)
});
