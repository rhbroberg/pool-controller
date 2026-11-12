// The pool's state as the page shows it: readings, heating, the connection and the sign-in.

import { ApiError, isAbort, toReading } from './api.js';
import { canControl, isAdmin, isOn, stateText, heatingDeviceFor, waterModeOf, waterModeInfo } from './model.js';
import * as prefs from './prefs.js';

export const REFRESH_SECONDS = 15;
// while live updates arrive, polling only catches anything they missed
export const LIVE_REFRESH_SECONDS = 60;
// the server fetches the forecast every half hour, so the page needn't ask on every refresh
export const WEATHER_REFRESH_SECONDS = 300;
export const DEFAULT_RECONNECT_SECONDS = 30;
export const RECONNECT_CHOICES = [10, 30, 60, 120, 300];
// how long to keep polling for the controller to report a requested change
const CONFIRMATION_TIMEOUT_MS = 15000;
// longer than for a switch, since stepping to a water flow mode may take two presses
const WATER_MODE_TIMEOUT_MS = 45000;
const CONFIRMATION_POLL_MS = 1000;
// while live, how many confirmation polls' time to wait for a push before asking anyway
const LIVE_CONFIRMATION_POLLS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// what's kept of a sign-in: methods lists password and the services the account signs in with
const signedInAs = (result) => ({
    email: result.email,
    token: result.token,
    role: result.role || null,
    methods: Array.isArray(result.methods) ? result.methods : null
});

export class StatusStore {
    /**
     * live, a LiveConnection, pushes changes as the controller reports them; without it, or while
     * it can't reach the server, the store polls
     **/
    constructor(client, { pollSleep, confirmationPollMs = CONFIRMATION_POLL_MS, live = null } = {}) {
        this.client = client;
        this.readings = [];
        // setpoints and what the heater and heat pump are doing; null from a server without them
        this.heating = null;
        // today's forecast; null until it's been asked for or from a server without weather
        this.weather = null;
        this.weatherCheckedAt = 0;
        this.lastRefresh = null;
        this.errorMessage = null;
        this.isLoading = false;
        this.connection = 'connecting';
        // why the last attempt to reach the server failed
        this.connectionFailure = null;
        // when the next reconnection attempt is due, while disconnected
        this.nextAttempt = null;
        this.credentials = prefs.read('credentials', null);
        // the default admin account, signed in but not yet renamed; its token only works for
        // commissioning, so it isn't saved
        this.commissioning = null;
        // requested state for controls the controller hasn't confirmed yet
        this.pending = {};
        this.pendingWaterMode = null;
        // counts changes the controller has confirmed
        this.confirmedChanges = 0;
        // whether the saved account's role has been checked with the server since the page opened
        this.accountChecked = false;
        this.listeners = new Set();
        this.notifyQueued = false;
        this.pollGeneration = 0;
        this.wakePoll = null;
        this.pollSleep = pollSleep;
        this.confirmationPollMs = confirmationPollMs;
        // whether live updates are arriving
        this.isLive = false;
        this.pushWaiters = new Set();
        // counts pushes, so a refresh that asked before one doesn't put back what it replaced
        this.pushesApplied = 0;
        this.live = live;
        if (live) {
            live.onEvent = (name, data) => this.receivePush(name, data);
            live.onStateChange = (isLive) => this.liveChanged(isLive);
        }

        prefs.watch((key) => {
            if (key === 'credentials') {
                this.credentials = prefs.read('credentials', null);
                this.accountChecked = false;
                this.changed();
            }
        });
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    changed() {
        if (this.notifyQueued) {
            return;
        }
        this.notifyQueued = true;
        queueMicrotask(() => {
            this.notifyQueued = false;
            this.listeners.forEach((listener) => listener(this));
        });
    }

    // MARK: derived state

    get isConnected() {
        return this.connection === 'connected';
    }

    get role() {
        return this.credentials ? this.credentials.role || null : null;
    }

    /** signed in with a role that may change equipment and press panel keys */
    get canControl() {
        return canControl(this.role);
    }

    get isAdmin() {
        return isAdmin(this.role);
    }

    get waterMode() {
        return waterModeOf(this.readings);
    }

    get needsAttention() {
        return isOn(this.reading('check system'));
    }

    /** what the panel says is wrong, as "Low Salt"; null before it has said, or from an older server */
    get checkSystemReason() {
        const reason = this.reading('check system reason');
        return this.needsAttention && reason && reason.value > 0 && reason.message ? reason.message : null;
    }

    get lastSwitchChange() {
        const status = this.readings.find((reading) => reading.category === 'status');
        return status ? status.timestamp : null;
    }

    get reconnectSeconds() {
        return prefs.read('reconnectSeconds', DEFAULT_RECONNECT_SECONDS);
    }

    reading(name) {
        return this.readings.find((reading) => reading.name === name);
    }

    /** the state the controller last reported; a requested change shows only once it's confirmed */
    isOn(control) {
        return isOn(this.reading(control.stateName));
    }

    pendingState(name) {
        return this.pending[name];
    }

    /** what the heater or heat pump behind control is doing; null for other equipment */
    heatingFor(control) {
        const device = heatingDeviceFor(control.name);
        return device && this.heating && this.heating.devices ? this.heating.devices[device.id] || null : null;
    }

    // MARK: polling

    /**
     * refreshes every REFRESH_SECONDS while connected, or LIVE_REFRESH_SECONDS while live updates
     * arrive; after losing the server, retries every reconnectSeconds. Starting again, as from
     * Retry, restarts the cycle at once.
     **/
    startPolling() {
        this.stopPolling();
        if (this.live) {
            this.live.start();
        }
        const generation = this.pollGeneration;
        const run = async () => {
            while (generation === this.pollGeneration) {
                this.nextAttempt = null;
                await this.refresh();
                if (generation !== this.pollGeneration) {
                    return;
                }
                if (this.isConnected && this.credentials && !this.accountChecked) {
                    await this.refreshAccount();
                }
                const wait = !this.isConnected ? this.reconnectSeconds : this.isLive ? LIVE_REFRESH_SECONDS : REFRESH_SECONDS;
                if (this.connection === 'disconnected') {
                    this.nextAttempt = new Date(Date.now() + wait * 1000);
                    this.changed();
                }
                await this.waitForNextPoll(wait * 1000);
            }
        };
        run();
    }

    stopPolling() {
        this.pollGeneration += 1;
        this.nextAttempt = null;
        if (this.live) {
            this.live.stop();
        }
        if (this.wakePoll) {
            this.wakePoll();
        }
    }

    // MARK: live updates

    liveChanged(isLive) {
        this.isLive = isLive;
        // refresh at once: joining may have missed a change, and losing the live updates means
        // polling more often again, or finding the server is gone
        if (this.wakePoll) {
            this.wakePoll();
        }
        this.changed();
    }

    receivePush(name, data) {
        if (name === 'readings' && data && Array.isArray(data.readings)) {
            this.applyReadings(data.readings.map(toReading));
        } else if (name === 'heating' && data && typeof data === 'object') {
            this.heating = data;
            this.pushesApplied += 1;
            this.changed();
        }
    }

    /** replaces the readings the push carries, keeping the rest as they were */
    applyReadings(pushed) {
        const byName = new Map(pushed.map((reading) => [reading.name, reading]));
        const readings = this.readings.map((reading) => {
            const replacement = byName.get(reading.name);
            byName.delete(reading.name);
            return replacement || reading;
        });
        this.readings = readings.concat([...byName.values()]);
        this.lastRefresh = new Date();
        this.pushesApplied += 1;
        this.markConnected();
        this.pushWaiters.forEach((wake) => wake(true));
        this.changed();
    }

    /** true when a push arrives within ms, false otherwise */
    nextPush(ms) {
        return new Promise((resolve) => {
            const wake = (pushed) => {
                clearTimeout(timer);
                this.pushWaiters.delete(wake);
                resolve(pushed);
            };
            const timer = setTimeout(() => wake(false), ms);
            this.pushWaiters.add(wake);
        });
    }

    waitForNextPoll(ms) {
        if (this.pollSleep) {
            return this.pollSleep(ms);
        }
        return new Promise((resolve) => {
            const timer = setTimeout(done, ms);
            const self = this;
            function done() {
                clearTimeout(timer);
                self.wakePoll = null;
                resolve();
            }
            this.wakePoll = done;
        });
    }

    /**
     * replaces every reading with the server's current values; on failure the previous readings
     * stay on screen, marked stale by connection or errorMessage
     **/
    async refresh() {
        this.isLoading = true;
        this.changed();
        const pushesBefore = this.pushesApplied;
        try {
            // heating is extra detail; a server that doesn't offer it still counts as connected
            const heating = this.client.fetchHeating().catch(() => null);
            // weather is extra detail too; a failed check keeps the last forecast and, like a
            // successful one, waits before asking again, so a server without weather isn't pestered
            const weather = Date.now() - this.weatherCheckedAt >= WEATHER_REFRESH_SECONDS * 1000
                ? this.client.fetchWeather().catch(() => this.weather).then((answer) => {
                    this.weatherCheckedAt = Date.now();
                    return answer;
                })
                : null;
            const readings = await this.client.fetchStatus();
            const fetchedHeating = await heating;
            if (this.pushesApplied === pushesBefore) {
                this.readings = readings;
                this.heating = fetchedHeating;
            }
            if (weather) {
                this.weather = await weather;
            }
            this.lastRefresh = new Date();
            this.errorMessage = null;
            this.markConnected();
        } catch (error) {
            this.handle(error);
        } finally {
            this.isLoading = false;
            this.changed();
        }
    }

    // MARK: accounts

    async signIn(email, password) {
        const result = await this.client.signIn(email, password);
        const signedIn = signedInAs(result);
        this.markConnected();
        if (result.mustChangeCredentials === true) {
            this.commissioning = signedIn;
            this.changed();
            return;
        }
        this.save(signedIn);
    }

    /** finishes a sign-in through a service with the ticket it came back with */
    async signInWithTicket(ticket) {
        const result = await this.client.signInWithTicket(ticket);
        this.markConnected();
        this.save(signedInAs(result));
    }

    /** whether the signed-in account has a password; true until the server has said */
    get hasPassword() {
        const methods = this.credentials && this.credentials.methods;
        return !methods || methods.includes('password');
    }

    /** renames the default admin account and sets its password, then signs in as the new account */
    async commission(name, password) {
        if (!this.commissioning) {
            return;
        }
        const result = await this.client.changeCredentials(name, password, this.commissioning.token);
        this.commissioning = null;
        this.save(signedInAs(result));
    }

    cancelCommissioning() {
        this.commissioning = null;
        this.changed();
    }

    /**
     * sets a new password once current proves who is asking; the server signs the account out
     * everywhere else, so this keeps the new token it returns
     **/
    async changePassword(current, password) {
        const credentials = this.requireCredentials();
        let verified;
        try {
            verified = await this.client.signIn(credentials.email, current);
        } catch (error) {
            if (error instanceof ApiError && error.kind === 'unauthorized') {
                throw new Error('Your current password isn’t correct.');
            }
            throw error;
        }
        const result = await this.client.changeCredentials(credentials.email, password, verified.token);
        this.save({ ...signedInAs(result), role: result.role || credentials.role });
    }

    /** asks the server for the signed-in account's current role, which an admin may have changed */
    async refreshAccount() {
        const credentials = this.credentials;
        if (!credentials) {
            return;
        }
        try {
            const account = await this.client.fetchAccount(credentials.token);
            this.save(signedInAs({ ...account, token: credentials.token }));
        } catch (error) {
            if (error instanceof ApiError && error.kind === 'unauthorized') {
                this.signOut();
            }
        }
    }

    /** forgets the sign-in; with endSession, also ends the session on the server */
    signOut({ endSession = false } = {}) {
        if (endSession && this.credentials) {
            this.client.signOut(this.credentials.token).catch(() => {});
        }
        prefs.remove('credentials');
        this.credentials = null;
        this.accountChecked = false;
        this.changed();
    }

    save(credentials) {
        prefs.write('credentials', credentials);
        this.credentials = credentials;
        this.accountChecked = Boolean(credentials.role);
        this.changed();
    }

    requireCredentials() {
        if (!this.credentials) {
            throw new ApiError('unauthorized');
        }
        return this.credentials;
    }

    // MARK: administration

    /**
     * erases the server's history and accounts; every account is gone afterwards, so this signs
     * out. Returns the server's description of the result.
     **/
    async factoryReset() {
        const message = await this.client.factoryReset(this.requireCredentials().token);
        this.signOut();
        this.readings = [];
        this.changed();
        return message;
    }

    async restartServer() {
        await this.client.restartServer(this.requireCredentials().token);
    }

    serverSettings() {
        return this.adminRequest((token) => this.client.fetchSettings(token));
    }

    async updateServerSettings(changes) {
        const settings = await this.adminRequest((token) => this.client.updateSettings(changes, token));
        if ('zipCode' in changes || 'timeZone' in changes) {
            // the server fetches the new forecast straight away; the next refresh picks it up
            this.weatherCheckedAt = 0;
            if (!settings.location) {
                this.weather = null;
            }
        }
        return settings;
    }

    maintenanceJobs() {
        return this.adminRequest((token) => this.client.fetchJobs(token));
    }

    /** runs a maintenance job now; resolves with how the run went */
    runMaintenanceJob(name) {
        return this.adminRequest((token) => this.client.runJob(name, token));
    }

    /** starts reading stored frames again; resolves with the run, which goes on in the server */
    startReprocess(request) {
        return this.adminRequest((token) => this.client.startReprocess(request, token));
    }

    /** the reprocessing run under way or the last one, or null */
    reprocessRun() {
        return this.adminRequest((token) => this.client.fetchReprocess(token));
    }

    /** a request needing the admin role; a rejected token signs out */
    async adminRequest(request) {
        try {
            return await request(this.requireCredentials().token);
        } catch (error) {
            if (error instanceof ApiError && error.kind === 'unauthorized' && this.credentials) {
                this.signOut();
            }
            throw error;
        }
    }

    // MARK: control

    /**
     * requests the change, then polls status until the controller reports it or the
     * confirmation timeout passes
     **/
    async setControl(control, on) {
        if (!this.credentials) {
            this.errorMessage = new ApiError('unauthorized').message;
            this.changed();
            return;
        }
        this.pending = { ...this.pending, [control.name]: on };
        this.changed();
        try {
            await this.client.setDevice(control.name, on, this.credentials.token);
            const confirmed = await this.awaitConfirmation(() => this.isOn(control) === on, CONFIRMATION_TIMEOUT_MS);
            if (confirmed === false) {
                this.errorMessage = `The controller hasn’t switched ${control.title} to ${stateText(control, on)} yet.`;
            }
        } catch (error) {
            await this.handleControlError(error, 'Sign in again to control equipment.', 'Your account can’t change equipment.');
        } finally {
            const { [control.name]: _, ...rest } = this.pending; // eslint-disable-line no-unused-vars
            this.pending = rest;
            this.changed();
        }
    }

    /** asks the server for a water flow mode, then polls until the controller reports it */
    async setWaterMode(mode) {
        if (!this.credentials || mode === this.waterMode) {
            return;
        }
        this.pendingWaterMode = mode;
        this.changed();
        try {
            await this.client.setWaterMode(mode, this.credentials.token);
            const confirmed = await this.awaitConfirmation(() => this.waterMode === mode, WATER_MODE_TIMEOUT_MS);
            if (confirmed === false) {
                this.errorMessage = `The controller hasn’t switched to ${waterModeInfo(mode).title} yet.`;
            }
        } catch (error) {
            await this.handleControlError(error, 'Sign in again to change the water flow.', 'Your account can’t change the water flow.');
        } finally {
            this.pendingWaterMode = null;
            this.changed();
        }
    }

    /**
     * true once reached() holds, false at the timeout, null if the server is lost meanwhile.
     * While live, the controller's report arrives as a push; otherwise it's polled for.
     **/
    async awaitConfirmation(reached, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (this.isLive) {
                if (reached()) {
                    this.confirmedChanges += 1;
                    return true;
                }
                // a push missed while the connection changed is caught by refreshing now and then
                const pushed = await this.nextPush(Math.min(this.confirmationPollMs * LIVE_CONFIRMATION_POLLS, deadline - Date.now()));
                if (!pushed) {
                    await this.refresh();
                }
            } else {
                await sleep(this.confirmationPollMs);
                await this.refresh();
            }
            if (reached()) {
                this.confirmedChanges += 1;
                return true;
            }
            if (!this.isConnected) {
                return null;
            }
        }
        return false;
    }

    async handleControlError(error, signInAgain, notAllowed) {
        if (error instanceof ApiError && error.kind === 'unauthorized') {
            this.signOut();
            this.errorMessage = `Your sign-in is no longer valid. ${signInAgain}`;
        } else if (error instanceof ApiError && error.status === 403) {
            // an admin may have changed this account's role
            await this.refreshAccount();
            this.errorMessage = notAllowed;
        } else {
            this.handle(error);
        }
        this.changed();
    }

    /**
     * saves each changed setpoint for the device, then refreshes so the tiles show the new
     * targets; setpoints is { pool, spa } in °F
     **/
    async setSetpoints(setpoints, deviceId) {
        const credentials = this.requireCredentials();
        try {
            for (const [body, degrees] of Object.entries(setpoints)) {
                const current = this.heating && this.heating.setpoints[body] ? this.heating.setpoints[body][deviceId] : undefined;
                if (degrees !== current) {
                    await this.client.setSetpoint(degrees, deviceId, body, credentials.token);
                }
            }
        } catch (error) {
            if (error instanceof ApiError && error.kind === 'unauthorized') {
                this.signOut();
                throw new Error('Your sign-in is no longer valid. Sign in again to change setpoints.');
            }
            if (error instanceof ApiError && error.status === 403) {
                await this.refreshAccount();
                throw new Error('Your account can’t change setpoints.');
            }
            throw error;
        }
        await this.refresh();
    }

    // MARK: errors

    markConnected() {
        this.connection = 'connected';
        this.connectionFailure = null;
    }

    handle(error) {
        if (isAbort(error)) {
            return;
        }
        if (error instanceof ApiError && error.kind === 'unreachable') {
            this.connection = 'disconnected';
            this.connectionFailure = error.message;
        } else {
            // the server answered, so the connection is fine even though the request failed
            this.markConnected();
            this.errorMessage = error.message;
        }
        this.changed();
    }
}
