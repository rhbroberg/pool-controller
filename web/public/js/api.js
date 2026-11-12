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

/** a reading as GET /status and the live updates send it, with its value a number */
export const toReading = (reading) => ({ ...reading, value: Number(reading.value), timestamp: toDate(reading.timestamp) });

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
    setTask(task, on, readyAt, token) {
        const body = readyAt ? { on, readyAt: readyAt.toISOString() } : { on };
        return this.send('PUT', `tasks/${task}`, { token, body });
    }

    /** today's forecast at the pool's zip code: { configured, location, today, fetchedAt, stale } */
    async fetchWeather() {
        const weather = await this.send('GET', 'weather');
        const today = weather.today ? { ...weather.today, sunrise: toDate(weather.today.sunrise), sunset: toDate(weather.today.sunset) } : null;
        return { ...weather, today, fetchedAt: toDate(weather.fetchedAt) };
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

    /** the days (YYYY-MM-DD, in the server's time zone) with these readings, or any water reading when names is omitted */
    fetchAvailability(from, to, names) {
        return this.send('GET', 'history/availability', {
            query: {
                names: names && names.length ? names.join(',') : undefined,
                from: new Date(from).toISOString(),
                to: new Date(to).toISOString()
            }
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

    // MARK: sign-in services

    /** { passwordSignIn, providers: [{ id, displayName }] }: what the sign-in form offers */
    fetchSignInChoices() {
        return this.send('GET', 'auth/providers');
    }

    /** where the browser goes to sign in with a service; it comes back to #/signin/complete */
    signInUrl(provider) {
        return this.url(`auth/${encodeURIComponent(provider)}/start`, { client: 'web' });
    }

    /** trades the ticket a sign-in through a service came back with for a token */
    signInWithTicket(ticket) {
        return this.send('POST', 'users/login/external', { body: { ticket } });
    }

    /** resolves with { url } to send the browser to, to add the service to this account */
    linkIdentity(provider, token) {
        return this.send('POST', `users/me/identities/${encodeURIComponent(provider)}`, { token, body: { client: 'web' } });
    }

    unlinkIdentity(provider, token) {
        return this.send('DELETE', `users/me/identities/${encodeURIComponent(provider)}`, { token });
    }

    async listRequests(token) {
        const requests = await this.send('GET', 'users/requests', { token });
        return requests.map((request) => ({ ...request, firstSeen: toDate(request.firstSeen), lastSeen: toDate(request.lastSeen) }));
    }

    approveRequest(id, role, token) {
        return this.send('POST', `users/requests/${encodeURIComponent(id)}/approve`, { token, body: { role } });
    }

    denyRequest(id, token) {
        return this.send('POST', `users/requests/${encodeURIComponent(id)}/deny`, { token });
    }

    forgetRequest(id, token) {
        return this.send('DELETE', `users/requests/${encodeURIComponent(id)}`, { token });
    }

    listInvitations(token) {
        return this.send('GET', 'users/invitations', { token });
    }

    /** provider null works with any service trusted for email addresses */
    createInvitation({ email, role, provider }, token) {
        return this.send('POST', 'users/invitations', { token, body: { email, role, provider: provider || null } });
    }

    deleteInvitation(id, token) {
        return this.send('DELETE', `users/invitations/${encodeURIComponent(id)}`, { token });
    }

    fetchSignInSettings(token) {
        return this.send('GET', 'system/sign-in', { token });
    }

    /** changes: { passwordSignIn } and/or { signInRequests: 'ask' | 'refuse' } */
    updateSignInSettings(changes, token) {
        return this.send('PUT', 'system/sign-in', { token, body: changes });
    }

    createSignInService(service, token) {
        return this.send('POST', 'system/sign-in/providers', { token, body: service, timeout: 20000 });
    }

    updateSignInService(id, changes, token) {
        return this.send('PUT', `system/sign-in/providers/${encodeURIComponent(id)}`, { token, body: changes, timeout: 20000 });
    }

    deleteSignInService(id, token) {
        return this.send('DELETE', `system/sign-in/providers/${encodeURIComponent(id)}`, { token });
    }

    // MARK: system

    async factoryReset(token) {
        const result = await this.send('POST', 'system/factory-reset', { token });
        return (result && result.message) || 'Factory reset complete.';
    }

    restartServer(token) {
        return this.send('POST', 'system/restart', { token });
    }

    /** the time zone history days follow, how long raw history is kept and the weather's location */
    fetchSettings(token) {
        return this.send('GET', 'system/settings', { token });
    }

    /**
     * changes: { timeZone } (null for the server's own zone), { rawRetentionDays } and/or
     * { zipCode } (null to stop fetching weather); a new zip code is looked up before this answers
     **/
    updateSettings(changes, token) {
        return this.send('PUT', 'system/settings', { token, body: changes, timeout: 20000 });
    }

    async fetchJobs(token) {
        const jobs = await this.send('GET', 'system/jobs', { token });
        return jobs.map(withJobDates);
    }

    /** runs a maintenance job now; answers once it has finished */
    async runJob(name, token) {
        return withJobDates(await this.send('POST', `system/jobs/${encodeURIComponent(name)}/run`, { token, timeout: 120000 }));
    }

    /**
     * reads stored frames from `from` up to `to` again, rewriting events of eventTypes (every kind
     * when empty); with dryRun, only counts what would change. Answers at once with the run
     **/
    async startReprocess({ from, to, eventTypes, dryRun }, token) {
        const body = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), dryRun: Boolean(dryRun) };
        if (eventTypes && eventTypes.length) {
            body.eventTypes = eventTypes;
        }
        return withRunDates(await this.send('POST', 'system/reprocess', { token, body }));
    }

    /** the reprocessing run under way or the last one, or null when there hasn't been one */
    async fetchReprocess(token) {
        try {
            return withRunDates(await this.send('GET', 'system/reprocess', { token }));
        } catch (error) {
            if (error instanceof ApiError && error.status === 404) {
                return null;
            }
            throw error;
        }
    }
}

const withRunDates = (run) => ({
    ...run,
    from: toDate(run.from),
    to: toDate(run.to),
    requestedAt: toDate(run.requestedAt),
    startedAt: toDate(run.startedAt),
    finishedAt: toDate(run.finishedAt),
    through: toDate(run.through)
});

const withJobDates = (job) => ({
    ...job,
    nextRunAt: toDate(job.nextRunAt),
    lastStartedAt: toDate(job.lastStartedAt),
    lastFinishedAt: toDate(job.lastFinishedAt)
});
