// The pool server's REST API, reached through the web service that serves this page.

export const API_PATH = '/rhbroberg/pool-api/1.0.0';
const DEFAULT_TIMEOUT_MS = 10000;
const UNREACHABLE_HEADER = 'x-pool-web-unreachable';

const capitalized = (text) => text ? text.charAt(0).toUpperCase() + text.slice(1) : text;

/**
 * kind is unreachable (no answer from the pool server), unauthorized (401) or server (any other
 * failure the server reported)
 **/
export class ApiError extends Error {
    constructor(kind, { status, message } = {}) {
        super(capitalized(message) || ApiError.defaultMessage(kind, status));
        this.kind = kind;
        this.status = status;
    }

    static defaultMessage(kind, status) {
        switch (kind) {
        case 'unreachable': return 'The pool server isn’t answering.';
        case 'unauthorized': return 'Sign in to control equipment.';
        default: return `The server returned HTTP ${status}.`;
        }
    }
}

export const isAbort = (error) => error && (error.name === 'AbortError' || error.name === 'TimeoutError');

const toDate = (value) => value ? new Date(value) : null;

const anySignal = (signals) => {
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
    /**
     * origin is empty in the browser, where the API shares the page's origin
     **/
    constructor(origin = '', fetchImpl = (...args) => fetch(...args)) {
        this.origin = origin;
        this.fetch = fetchImpl;
    }

    url(path, query) {
        let url = `${this.origin}${API_PATH}/${path}`;
        if (query) {
            const params = new URLSearchParams();
            Object.entries(query).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    params.set(key, value);
                }
            });
            const text = params.toString();
            if (text) {
                url += `?${text}`;
            }
        }
        return url;
    }

    async send(method, path, { token, body, query, timeout = DEFAULT_TIMEOUT_MS, signal } = {}) {
        const headers = {
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
        } catch (error) {
            if (signal && signal.aborted) {
                throw error;
            }
            const message = error.name === 'TimeoutError' ? 'The pool server didn’t answer in time.' : 'Can’t reach the web service.';
            throw new ApiError('unreachable', { message });
        }
        const text = await response.text();
        let data;
        try {
            data = text ? JSON.parse(text) : undefined;
        } catch {
            data = undefined;
        }
        if (response.ok) {
            return data;
        }
        const message = data && typeof data.message === 'string' ? data.message : undefined;
        if (response.headers.get(UNREACHABLE_HEADER)) {
            throw new ApiError('unreachable', { status: response.status, message });
        }
        if (response.status === 401) {
            throw new ApiError('unauthorized', { status: 401, message });
        }
        throw new ApiError('server', { status: response.status, message });
    }

    // MARK: status

    async fetchStatus() {
        const readings = await this.send('GET', 'status');
        return readings.map((reading) => ({ ...reading, value: Number(reading.value), timestamp: toDate(reading.timestamp) }));
    }

    async fetchSystemInfo() {
        const info = await this.send('GET', 'system/info');
        return { ...info, startedAt: toDate(info.startedAt) };
    }

    fetchHeating() {
        return this.send('GET', 'heating');
    }

    // MARK: control

    setDevice(name, on, token) {
        return this.send('PUT', `devices/${encodeURIComponent(name)}/${on}`, { token });
    }

    setWaterMode(mode, token) {
        return this.send('PUT', `water/mode/${mode}`, { token });
    }

    setSetpoint(degrees, device, body, token) {
        return this.send('PUT', `heating/setpoints/${body}/${device}/${degrees}`, { token });
    }

    // MARK: panel

    async fetchPanelDisplay() {
        const display = await this.send('GET', 'panel/display');
        return { ...display, timestamp: toDate(display.timestamp) };
    }

    pressPanelKey(key, token) {
        return this.send('PUT', `panel/keys/${key}`, { token });
    }

    // MARK: history

    /**
     * readings for each name from `from` up to `to`, plus each one's value as the window opens;
     * times come back as milliseconds since the epoch. A series with more than maxPoints
     * readings comes back as buckets at least resolution seconds long: each point is the
     * bucket's time-weighted average, with its lowest (low) and highest (high) value.
     **/
    async fetchHistory(names, from, to, { signal, maxPoints, resolution } = {}) {
        const response = await this.send('GET', 'history', {
            query: { names: names.join(','), from: new Date(from).toISOString(), to: new Date(to).toISOString(), maxPoints, resolution },
            timeout: 30000,
            signal
        });
        const point = (p) => p ? { t: Date.parse(p.t), v: p.v, low: p.min ?? null, high: p.max ?? null } : null;
        return {
            from: Date.parse(response.from),
            to: Date.parse(response.to),
            timeZone: response.timeZone || null,
            earliest: response.earliest ? Date.parse(response.earliest) : null,
            series: (response.series || []).map((series) => ({
                name: series.name,
                resolution: series.resolution || 0,
                before: point(series.before),
                points: (series.points || []).map(point)
            }))
        };
    }

    /** the days (YYYY-MM-DD, in the server's time zone) with water temperature or salt readings */
    fetchAvailability(from, to) {
        return this.send('GET', 'history/availability', {
            query: { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
        });
    }

    async fetchEvents({ types, user, cursor, ascending, limit }) {
        const page = await this.send('GET', 'events', {
            query: { types: types.join(','), order: ascending ? 'asc' : 'desc', limit, user, cursor }
        });
        return { ...page, events: page.events.map((event) => ({ ...event, timestamp: toDate(event.timestamp) })) };
    }

    fetchEventUsers() {
        return this.send('GET', 'events/users');
    }

    // MARK: accounts

    signIn(email, password) {
        return this.send('POST', 'users/login', { body: { email, password } });
    }

    /**
     * renames the signed-in account and sets its password; returns a new token, since the old
     * one stops working
     **/
    changeCredentials(name, password, token) {
        return this.send('PUT', 'users/me/credentials', { token, body: { email: name, password } });
    }

    fetchAccount(token) {
        return this.send('GET', 'users/me', { token });
    }

    signOut(token) {
        return this.send('DELETE', 'users/me/token', { token });
    }

    listAccounts(token) {
        return this.send('GET', 'users', { token });
    }

    createAccount(name, password, role, token) {
        return this.send('POST', 'users', { token, body: { email: name, password, role } });
    }

    updateAccount(name, { role, password }, token) {
        const changes = {};
        if (role) {
            changes.role = role;
        }
        if (password) {
            changes.password = password;
        }
        return this.send('PUT', `users/${encodeURIComponent(name)}`, { token, body: changes });
    }

    deleteAccount(name, token) {
        return this.send('DELETE', `users/${encodeURIComponent(name)}`, { token });
    }

    // MARK: system

    async factoryReset(token) {
        const result = await this.send('POST', 'system/factory-reset', { token });
        return (result && result.message) || 'Factory reset complete.';
    }

    restartServer(token) {
        return this.send('POST', 'system/restart', { token });
    }

    /** the time zone history days follow and how long raw history is kept */
    fetchSettings(token) {
        return this.send('GET', 'system/settings', { token });
    }

    /** changes: { timeZone } (null for the server's own zone) and/or { rawRetentionDays } */
    updateSettings(changes, token) {
        return this.send('PUT', 'system/settings', { token, body: changes });
    }

    async fetchJobs(token) {
        const jobs = await this.send('GET', 'system/jobs', { token });
        return jobs.map(withJobDates);
    }

    /** runs a maintenance job now; answers once it has finished */
    async runJob(name, token) {
        return withJobDates(await this.send('POST', `system/jobs/${encodeURIComponent(name)}/run`, { token, timeout: 120000 }));
    }
}

const withJobDates = (job) => ({
    ...job,
    nextRunAt: toDate(job.nextRunAt),
    lastStartedAt: toDate(job.lastStartedAt),
    lastFinishedAt: toDate(job.lastFinishedAt)
});
