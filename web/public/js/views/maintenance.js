// The accounts and how people sign in, the pool's location for weather, the time zone and
// history settings, the maintenance jobs, restart and factory reset: everything an admin keeps
// the server running with.

import { h, confirmAction } from '../dom.js';
import { icon } from '../icons.js';
import { DEFAULT_ADMIN, HEATING_SOURCES, WATER_BODIES, rateBasis } from '../model.js';
import { relative } from '../format.js';
import { topbar, formSection, formRow, actionRow, linkRow, select, spinner, renderer } from '../ui.js';

const RETENTION_CHOICES = [30, 90, 180, 365, 730, 1095, 1825, 3650];
const RULE_CHOICES = { pool: [0.25, 0.5, 0.75, 1, 1.5, 2, 3], spa: [2, 4, 6, 10, 15, 20, 30, 40, 60] };
const PREHEAT_MARGIN_CHOICES = [0, 10, 15, 30, 45, 60];
// the server's own zone; the server takes null as "follow the host"
const SERVER_ZONE = '';

const JOB_TITLES = { rollups: 'History Summaries', retention: 'Old History Cleanup', weather: 'Weather Forecast' };
const ZIP_CODE = /^\d{5}(-\d{4})?$/;

export const retentionTitle = (days) => {
    const plural = (count, unit) => `${count} ${unit}${count === 1 ? '' : 's'}`;
    if (days % 365 === 0) {
        return plural(days / 365, 'year');
    }
    if (days % 30 === 0) {
        return plural(days / 30, 'month');
    }
    return plural(days, 'day');
};

const allTimeZones = (current) => {
    const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    return [...new Set([...zones, current])].sort();
};

export const mountMaintenance = (root, app) => {
    const { store, client } = app;
    // whether the server has sign-in services to set up; null until it says, or from one too old
    let choices = null;
    let pendingRequests = 0;
    let working = false;
    let message = null;
    let settings = null;
    // the heating model in use, to say which rates it learned; null until one is saved
    let heatingModel = null;
    let jobs = [];
    // settings or jobs that couldn't be read or changed
    let settingsError = null;
    let runningJob = null;
    // the zip code being typed; null shows the saved one
    let zipDraft = null;
    let savingZip = false;
    let locationError = null;

    const run = async (action, done) => {
        working = true;
        message = null;
        redraw();
        try {
            await action();
            message = done;
        } catch (error) {
            message = error.message;
        } finally {
            working = false;
            redraw();
        }
    };

    const loadChoices = async () => {
        try {
            choices = await client.fetchSignInChoices();
        } catch {
            choices = null;
        }
        redraw();
    };

    const loadPendingRequests = async () => {
        if (!store.isAdmin) {
            return;
        }
        try {
            const requests = await client.listRequests(store.credentials.token);
            pendingRequests = requests.filter((request) => request.status === 'pending').length;
            redraw();
        } catch {
            // the count is a hint; Accounts shows any error
        }
    };

    const loadSettings = async () => {
        if (!store.isAdmin) {
            return;
        }
        try {
            [settings, jobs, heatingModel] = await Promise.all([
                store.serverSettings(),
                store.maintenanceJobs(),
                store.client.fetchHeatingModel().then((state) => state.model).catch(() => null)
            ]);
            settingsError = null;
        } catch (error) {
            settingsError = error.message;
        }
        redraw();
    };

    const apply = async (changes) => {
        try {
            settings = await store.updateServerSettings(changes);
            settingsError = null;
            // a new time zone redoes the daily summaries, which shows in the jobs
            jobs = await store.maintenanceJobs().catch(() => jobs);
        } catch (error) {
            settingsError = error.message;
        }
        redraw();
    };

    /** a zip code is looked up by the server before it answers; null stops fetching weather */
    const saveZip = async (zipCode) => {
        savingZip = true;
        locationError = null;
        redraw();
        try {
            settings = await store.updateServerSettings({ zipCode });
            zipDraft = null;
            jobs = await store.maintenanceJobs().catch(() => jobs);
        } catch (error) {
            locationError = error.message;
        } finally {
            savingZip = false;
            redraw();
        }
    };

    const runJob = async (job) => {
        runningJob = job.name;
        redraw();
        try {
            const ran = await store.runMaintenanceJob(job.name);
            jobs = jobs.map((each) => each.name === ran.name ? ran : each);
            settingsError = ran.more ? `${JOB_TITLES[ran.name] || ran.name} has more to do and carries on by itself.` : null;
        } catch (error) {
            settingsError = error.message;
        } finally {
            runningJob = null;
            redraw();
        }
    };

    const restart = async () => {
        const confirmed = await confirmAction({
            title: 'Restart the server?',
            message: 'Status, equipment changes and panel keys stop for everyone until it’s back, usually within a minute.',
            action: 'Restart Server'
        });
        if (confirmed) {
            run(() => store.restartServer(), 'The server is restarting. This page reconnects when it’s back.');
        }
    };

    const factoryReset = async () => {
        const confirmed = await confirmAction({
            title: 'Are you sure?',
            message: `This erases all history and accounts on the server and recreates the ${DEFAULT_ADMIN} / ${DEFAULT_ADMIN} account. It can’t be undone.`,
            action: 'Factory Reset',
            destructive: true
        });
        if (confirmed) {
            run(() => store.factoryReset(), `Factory reset complete. Sign in as ${DEFAULT_ADMIN} / ${DEFAULT_ADMIN} to set up the server.`);
        }
    };

    const historyFooter = () => {
        const zone = {
            configured: 'Days start at midnight in this time zone, which an admin chose.',
            system: 'Days start at midnight in this time zone, the server’s own.',
            default: 'The server couldn’t find its time zone, so days start at midnight UTC. Choose the pool’s time zone.'
        }[settings.timeZoneSource];
        return `${zone} Raw history older than this is removed; graphs keep showing it from hourly and daily summaries.`;
    };

    const historySection = () => {
        const zoneValue = settings.timeZoneSource === 'configured' ? settings.timeZone : SERVER_ZONE;
        const retention = [...new Set([...RETENTION_CHOICES.filter((days) => days >= settings.minimumRetentionDays && days <= settings.maximumRetentionDays), settings.rawRetentionDays])].sort((a, b) => a - b);
        return formSection({ header: 'History', footer: historyFooter() },
            formRow(h('span', { class: 'label' }, 'Time Zone'),
                select({
                    label: 'Time zone',
                    value: zoneValue,
                    options: [
                        { value: SERVER_ZONE, label: `Server’s own (${settings.detectedTimeZone || 'not found; UTC'})` },
                        ...allTimeZones(settings.timeZone).map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ') }))
                    ],
                    onChange: (value) => apply({ timeZone: value === SERVER_ZONE ? null : value })
                })),
            formRow(h('span', { class: 'label' }, 'Keep Raw History'),
                select({
                    label: 'Keep raw history',
                    value: String(settings.rawRetentionDays),
                    options: retention.map((days) => ({ value: String(days), label: retentionTitle(days) })),
                    onChange: (value) => apply({ rawRetentionDays: Number(value) })
                })));
    };

    const perHour = (rate) => `${rate}°F an hour`;

    /**
     * how each body of water is timed: each source's rate as learned from history, or the rule
     * standing in for it and why, which is set here; a server without heating rules doesn't say
     **/
    const heatingSections = () => {
        if (!settings.heatingRules) {
            return [];
        }
        const keeping = (choices, current) => [...new Set([...choices, current])].sort((a, b) => a - b);
        const minutes = (count) => count === 0 ? 'No margin' : count % 60 === 0 ? `${count / 60} hr` : `${count} min`;
        const footer = 'A rule stands in for what history hasn’t shown yet, and its estimates say “by rule”. A model that learns the rate takes over from it.';
        const sourceRow = (body, source) => {
            const basis = rateBasis(heatingModel, body.id, source.id);
            const caption = basis.why
                ? h('small', { class: 'warning' }, `By rule · ${basis.why}`)
                : h('small', { class: 'learned' }, 'Learned from history');
            const label = h('div', { class: 'row-text' }, h('span', null, source.title), caption);
            if (!basis.why) {
                return formRow(label, h('span', { class: 'value' }, `${Math.round(basis.learned * 100) / 100}°F an hour`));
            }
            const current = settings.heatingRules[body.id][source.id];
            return formRow(label, select({
                label: `${body.title} ${source.title.toLowerCase()} rule`,
                value: String(current),
                options: keeping(RULE_CHOICES[body.id], current).map((rate) => ({ value: String(rate), label: perHour(rate) })),
                onChange: (value) => apply({ heatingRules: { [body.id]: { [source.id]: Number(value) } } })
            }));
        };
        return WATER_BODIES.map((body) => {
            const rows = HEATING_SOURCES.map((source) => sourceRow(body, source));
            if (body.id === 'spa' && typeof settings.preheatMarginMinutes === 'number') {
                rows.push(formRow(h('span', { class: 'label' }, 'Preheat Starts Early By'),
                    select({
                        label: 'Preheat starts early by',
                        value: String(settings.preheatMarginMinutes),
                        options: keeping(PREHEAT_MARGIN_CHOICES, settings.preheatMarginMinutes).map((count) => ({ value: String(count), label: minutes(count) })),
                        onChange: (value) => apply({ preheatMarginMinutes: Number(value) })
                    })));
            }
            return formSection({
                header: `How the ${body.title} Is Timed`,
                footer: body.id === 'spa' ? `${footer} A spa preheat scheduled to be ready by a time starts this much earlier than it needs to.` : footer
            }, ...rows);
        });
    };

    const locationSection = () => {
        const saved = settings.location ? settings.location.zipCode : '';
        const draft = zipDraft === null ? saved : zipDraft;
        const changed = draft.trim() !== saved;
        const canSave = changed && ZIP_CODE.test(draft.trim()) && !savingZip;
        const footer = locationError
            || (settings.location
                ? 'The server fetches the forecast for this zip code every half hour, shows today’s on the main page and keeps the conditions with the water temperature history.'
                : 'Give the pool’s zip code to show today’s forecast on the main page. Weather comes from Open-Meteo.');
        return formSection({ header: 'Location', footer, footerClass: locationError ? 'error' : '' },
            formRow(h('label', { for: 'zip-code', class: 'label' }, 'Zip Code'),
                h('input', {
                    id: 'zip-code',
                    class: 'trailing',
                    value: draft,
                    placeholder: '32801',
                    inputmode: 'numeric',
                    autocomplete: 'postal-code',
                    maxlength: 10,
                    disabled: savingZip,
                    onInput: (event) => {
                        zipDraft = event.target.value;
                        locationError = null;
                        redraw();
                    },
                    onKeydown: (event) => {
                        if (event.key === 'Enter' && canSave) {
                            event.preventDefault();
                            saveZip(draft.trim());
                        }
                    }
                }),
                savingZip
                    ? spinner('small')
                    : h('button', { class: 'button small', type: 'button', disabled: !canSave, onClick: () => saveZip(draft.trim()) }, 'Save')),
            settings.location
                ? formRow(h('span', { class: 'label' }, 'Place'), h('span', { class: 'value' }, settings.location.placeName))
                : null,
            settings.location
                ? actionRow('Stop Fetching Weather', () => saveZip(null), { destructive: true, disabled: savingZip })
                : null);
    };

    const jobRow = (job) => {
        const failed = job.lastResult === 'failed';
        const lastRun = job.lastFinishedAt
            ? (failed ? `Failed ${relative(job.lastFinishedAt)}: ${job.lastError || ''}` : `Ran ${relative(job.lastFinishedAt)}`)
            : 'Hasn’t run yet';
        return formRow(
            h('div', { class: 'row-text' },
                h('span', null, JOB_TITLES[job.name] || job.name),
                h('small', { class: failed ? 'warning' : '' }, lastRun),
                job.lastSummary ? h('small', null, job.lastSummary) : null),
            h('div', { style: { marginLeft: 'auto' } },
                runningJob === job.name || job.running
                    ? spinner('small')
                    : h('button', { class: 'button', type: 'button', disabled: runningJob !== null, onClick: () => runJob(job) }, 'Run Now')));
    };

    const accountsSection = () => formSection({ footer: 'Who can sign in, what each may do, and how they sign in.' },
        h('a', { class: 'form-row', href: '#/accounts' },
            h('span', null, 'Accounts'),
            pendingRequests > 0 ? h('span', { class: 'count-badge', title: `${pendingRequests} waiting for approval` }, String(pendingRequests)) : null,
            icon('chevronRight')),
        choices ? linkRow('Sign-In', '#/sign-in') : null);

    const render = () => {
        const disabled = !store.isAdmin || working;
        return [
            topbar({ title: 'Server Maintenance', back: '', backTitle: app.poolName() }),
            h('main', { class: 'page' },
                h('div', { class: 'form' },
                    store.isAdmin ? accountsSection() : null,
                    settings ? locationSection() : null,
                    settings ? historySection() : null,
                    ...(settings ? heatingSections() : []),
                    jobs.length
                        ? formSection({ header: 'Maintenance Jobs', footer: 'These run on their own. Run Now brings them up to date straight away.' }, ...jobs.map(jobRow))
                        : null,
                    settingsError ? formSection({}, h('div', { class: 'warning-line' }, icon('warning'), settingsError)) : null,
                    store.isAdmin
                        ? formSection({ footer: 'Reads stored history again with the server’s current decoding, as after a fix to how it reads the controller.' },
                            linkRow('Reprocess History', '#/maintenance/reprocess'))
                        : null,
                    formSection({ footer: 'The server stops and its container starts it again. This page reconnects when it’s back.' },
                        actionRow('Restart Server', restart, { disabled, busy: working })),
                    formSection({ footer: `Erases all history and accounts on the server and recreates the ${DEFAULT_ADMIN} / ${DEFAULT_ADMIN} account.` },
                        actionRow('Factory Reset', factoryReset, { destructive: true, disabled })),
                    message
                        ? formSection({}, h('div', { class: 'message-box' }, message))
                        : !store.credentials
                            ? formSection({}, h('div', { class: 'message-box secondary' }, 'Sign in to restart or reset the server.'))
                            : null))
        ];
    };

    const redraw = renderer(root, render);
    let wasAdmin = store.isAdmin;
    const unsubscribe = store.subscribe(() => {
        // signing in as an admin on this page shows the settings without leaving it
        if (store.isAdmin && !wasAdmin) {
            loadSettings();
            loadPendingRequests();
        }
        wasAdmin = store.isAdmin;
        redraw();
    });
    document.title = 'Server Maintenance';
    redraw();
    loadSettings();
    loadChoices();
    loadPendingRequests();
    return unsubscribe;
};
