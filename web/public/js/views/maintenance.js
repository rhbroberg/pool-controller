// The pool's location for weather, the time zone and history settings, the maintenance jobs,
// restart and factory reset, kept off the main Settings page because they affect the server
// rather than this page.

import { h, confirmAction } from '../dom.js';
import { icon } from '../icons.js';
import { DEFAULT_ADMIN } from '../model.js';
import { relative } from '../format.js';
import { topbar, formSection, formRow, actionRow, select, spinner, renderer } from '../ui.js';

const RETENTION_CHOICES = [30, 90, 180, 365, 730, 1095, 1825, 3650];
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
    const { store } = app;
    let working = false;
    let message = null;
    let settings = null;
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

    const loadSettings = async () => {
        if (!store.isAdmin) {
            return;
        }
        try {
            [settings, jobs] = await Promise.all([store.serverSettings(), store.maintenanceJobs()]);
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

    const render = () => {
        const disabled = !store.isAdmin || working;
        return [
            topbar({ title: 'Server Maintenance', back: 'settings', backTitle: 'Settings' }),
            h('main', { class: 'page' },
                h('div', { class: 'form' },
                    settings ? locationSection() : null,
                    settings ? historySection() : null,
                    jobs.length
                        ? formSection({ header: 'Maintenance Jobs', footer: 'These run on their own. Run Now brings them up to date straight away.' }, ...jobs.map(jobRow))
                        : null,
                    settingsError ? formSection({}, h('div', { class: 'warning-line' }, icon('warning'), settingsError)) : null,
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
        }
        wasAdmin = store.isAdmin;
        redraw();
    });
    document.title = 'Server Maintenance';
    redraw();
    loadSettings();
    return unsubscribe;
};
