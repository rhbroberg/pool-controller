// The main page: the pool and spa and the tasks, with the air and today's weather in the top bar
// and the equipment, the panel's own menus, the event log and server maintenance along the bottom.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { WATER_BODIES, bodyHeating, measurement, weatherSummary } from '../model.js';
import { relative, countdown } from '../format.js';
import { topbar, barButton, navigate, spinner, renderer } from '../ui.js';
import { accessNote, updateFooter } from './equipment.js';
import { taskSection } from './tasks.js';

const CONNECTION_TITLES = { connecting: 'Connecting', connected: 'Connected', disconnected: 'Offline' };
// redraws this often so "Updated just now" and the retry countdown stay current
const TICK_MS = 1000;

export const mountDashboard = (root, app) => {
    const { store } = app;

    // MARK: pieces

    const connectionIndicator = () => h('span', { class: ['connection-indicator', store.connection], 'aria-label': `Server ${CONNECTION_TITLES[store.connection]}` },
        h('span', { class: 'dot' }), CONNECTION_TITLES[store.connection]);

    const checkSystemBar = () => {
        const reason = store.checkSystemReason;
        return h('div', { class: 'check-system-bar', role: 'alert', 'aria-label': reason ? `Check system: ${reason}` : 'Check system: the controller reports a fault' },
            icon('warning'), reason ? `Check System: ${reason}` : 'Check System');
    };

    const offlineBanner = () => {
        const host = app.apiServer || 'the pool server';
        let detail = null;
        if (store.isLoading) {
            detail = 'Reconnecting…';
        } else if (store.nextAttempt && store.nextAttempt > new Date()) {
            detail = `Retrying in ${countdown(store.nextAttempt)}`;
        }
        return h('div', { class: 'card offline-banner', role: 'status' },
            h('div', { class: 'message' },
                icon('wifiOff'),
                h('div', null,
                    h('strong', null, `Can’t reach ${host}`),
                    store.connectionFailure ? h('div', { class: 'detail' }, store.connectionFailure) : null,
                    detail ? h('div', { class: 'detail mono' }, detail) : null)),
            h('div', { class: 'buttons' },
                store.isLoading
                    ? spinner('small')
                    : h('button', { class: 'button prominent small', type: 'button', onClick: () => store.startPolling() }, 'Retry')));
    };

    /** how old the readings are; nothing while live updates keep them current */
    const freshness = () => {
        if (!store.lastRefresh || (store.isConnected && store.isLive)) {
            return null;
        }
        const age = Date.now() - store.lastRefresh.getTime();
        const when = age < 60000 ? 'just now' : relative(store.lastRefresh);
        return h('div', { class: ['freshness', store.isConnected ? '' : 'stale'] },
            store.isConnected ? `Updated ${when}` : `Last reading ${when}`);
    };

    /** the air at the pool and today's forecast, beside the pool's name in the top bar */
    const weatherBadge = () => {
        const air = measurement(store.readings, 'ambient');
        const weather = weatherSummary(store.weather);
        const details = [`Air ${air.value}`];
        if (weather) {
            details.push(`${weather.place ? `Today in ${weather.place}` : 'Today'}: ${weather.title}, high ${weather.highLow.replace(' / ', ', low ')}`,
                weather.rain, weather.isStale ? 'Forecast out of date' : null);
        }
        const summary = details.filter(Boolean).join(' · ');
        return h('span', { class: 'weather-badge', title: summary, 'aria-label': summary, role: 'img' },
            icon(weather ? weather.icon : 'thermometer', { className: `weather-icon ${weather ? weather.icon : ''}` }),
            h('span', { class: 'air' }, air.value),
            weather ? h('span', { class: ['high-low', weather.isStale ? 'dimmed' : ''] }, weather.highLow) : null);
    };

    /** where a body of water is headed and by when, or that its pump is off */
    const waterDetail = (water, heating) => {
        if (heating && heating.setpoint !== null) {
            return h('span', { class: 'water-detail', style: { '--tint': `var(--${heating.sources[0].control.tint})` } },
                h('span', { class: 'target' }, icon('target'), `${heating.setpoint}°`),
                heating.ready ? h('span', { class: 'ready' }, `by ${heating.ready}`) : null);
        }
        return h('span', { class: ['water-detail', 'pump-off', water.isDimmed ? '' : 'placeholder'] }, icon('pause'), 'Pump off');
    };

    const waterColumn = (body) => {
        const water = measurement(store.readings, body.temperatureName);
        const heating = bodyHeating(store.heating, body.id);
        const sources = heating ? heating.sources : [];
        const spoken = [water.title, water.value];
        if (heating && heating.setpoint !== null) {
            spoken.push(`heading for ${heating.setpoint}°${heating.ready ? ` by ${heating.ready}` : ''}`);
        }
        spoken.push(...sources.map((source) => `${source.title} ${source.heating ? 'heating' : 'on'}`));
        return h('a', { class: 'water-column', href: `#/history/${body.id}`, title: 'Show the temperature history', 'aria-label': spoken.join(', ') },
            h('span', { class: 'link-title' },
                water.title,
                icon('chevronRight'),
                h('span', { class: 'sources' }, sources.map((source) => h('span', {
                    class: 'source',
                    style: { '--tint': `var(--${source.control.tint})` },
                    title: `${source.title} ${source.heating ? 'heating' : 'on'}`
                }, icon(source.control.icon, { filled: source.heating }))))),
            h('span', { class: ['water-value', water.isDimmed ? 'dimmed' : ''] }, water.value),
            waterDetail(water, heating));
    };

    const temperatureCard = () => h('div', { class: 'card temperature-card' },
        h('div', { class: 'water-columns' },
            waterColumn(WATER_BODIES[0]),
            h('div', { class: 'temperature-divider' }),
            waterColumn(WATER_BODIES[1])),
        freshness());

    /** the pages the main page opens, as a row of icons along the bottom */
    const bottomBar = () => {
        const item = (href, iconName, title) => h('a', { class: 'bottom-bar-item', href }, icon(iconName), h('span', null, title));
        return h('nav', { class: 'bottom-bar', 'aria-label': 'Pages' },
            h('div', { class: 'bottom-bar-items' },
                item('#/equipment', 'toggle', 'Equipment'),
                item('#/panel', 'dpad', 'Remote Menu'),
                item('#/events', 'list', 'Event Log'),
                store.isAdmin ? item('#/maintenance', 'wrench', 'Maintenance') : null));
    };

    const dashboard = () => [
        temperatureCard(),
        h('div', { class: ['dashboard-controls', store.isConnected ? '' : 'disabled'] },
            accessNote(store),
            taskSection(app)),
        updateFooter(store)
    ];

    const placeholder = () => {
        if (store.connection === 'connecting') {
            return h('div', { class: 'center-message' }, spinner('large'), 'Connecting…');
        }
        if (store.isConnected && !store.errorMessage) {
            return h('div', { class: 'center-message' }, icon('drop'), h('h2', null, 'No Readings'), 'The server hasn’t recorded any status yet.');
        }
        return null;
    };

    const render = () => {
        const name = app.poolName();
        document.title = name;
        return [
            topbar({
                title: name,
                leading: store.connection !== 'connected' ? connectionIndicator() : store.readings.length ? weatherBadge() : null,
                trailing: barButton({ label: 'Settings', iconName: 'userCircle', onClick: () => navigate('settings') })
            }),
            store.needsAttention ? checkSystemBar() : null,
            h('main', { class: ['page', 'wide', store.readings.length ? 'above-bottom-bar' : ''] },
                h('div', { class: 'dashboard' },
                    store.connection === 'disconnected' ? offlineBanner() : null,
                    store.errorMessage && store.isConnected
                        ? h('div', { class: 'card error-note', role: 'alert' }, icon('warning'), store.errorMessage)
                        : null,
                    store.readings.length ? dashboard() : placeholder())),
            store.readings.length ? bottomBar() : null
        ];
    };

    const redraw = renderer(root, render);
    const unsubscribe = store.subscribe(redraw);
    const unwatch = app.onSettingsChanged(redraw);
    const ticker = setInterval(redraw, TICK_MS);
    redraw();
    return () => {
        unsubscribe();
        unwatch();
        clearInterval(ticker);
    };
};
