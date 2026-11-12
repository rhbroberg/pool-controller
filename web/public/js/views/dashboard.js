// The main page: temperatures, the tasks, and the way to the equipment and the panel's own menus.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { measurement, weatherSummary } from '../model.js';
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

    const freshness = () => {
        if (!store.lastRefresh) {
            return null;
        }
        if (store.isConnected && store.isLive) {
            return h('span', { class: 'freshness live', title: 'Changes appear as the controller reports them' }, 'Live');
        }
        const age = Date.now() - store.lastRefresh.getTime();
        const when = age < 60000 ? 'just now' : relative(store.lastRefresh);
        return h('span', { class: ['freshness', store.isConnected ? '' : 'stale'] },
            store.isConnected ? `Updated ${when}` : `Last reading ${when}`);
    };

    const measurementRow = (name, href) => {
        const m = measurement(store.readings, name);
        const content = [
            h('span', { class: 'row-title' }, m.title),
            m.isDimmed ? icon('pause', { className: 'pause-icon', label: 'Pump off' }) : null,
            h('span', { class: ['row-value', m.isDimmed ? 'dimmed' : ''] }, m.value),
            icon('chevronRight', { className: 'chevron' })
        ];
        return href
            ? h('a', { class: 'measurement-row linked', href, title: 'Show the history' }, content)
            : h('div', { class: 'measurement-row' }, content);
    };

    /** today's forecast at the pool's zip code; nothing until an admin sets one */
    const weatherRow = () => {
        const weather = weatherSummary(store.weather);
        if (!weather) {
            return null;
        }
        const details = [weather.place ? `Today in ${weather.place}` : 'Today', weather.rain, weather.isStale ? 'Forecast out of date' : null];
        return h('div', { class: 'measurement-row weather-row', title: details.filter(Boolean).join(' · ') },
            icon(weather.icon, { className: `weather-icon ${weather.icon}` }),
            h('span', { class: 'row-title' }, weather.title),
            h('span', { class: ['row-value', weather.isStale ? 'dimmed' : ''], 'aria-label': `High ${weather.highLow.replace(' / ', ', low ')}` }, weather.highLow),
            icon('chevronRight', { className: 'chevron' }));
    };

    const temperatureCard = () => {
        const pool = measurement(store.readings, 'pool temp');
        return h('div', { class: 'card temperature-card' },
            h('a', { class: 'temperature-hero', href: '#/history/pool', title: 'Show the temperature history' },
                h('span', { class: 'link-title' },
                    pool.title,
                    icon('chevronRight'),
                    pool.isDimmed ? h('span', { class: 'pump-off' }, icon('pause'), 'Pump off') : null),
                h('span', { class: ['hero-value', pool.isDimmed ? 'dimmed' : ''] }, pool.value),
                freshness()),
            h('div', { class: 'temperature-divider' }),
            h('div', { class: 'measurements' },
                measurementRow('spa temp', '#/history/spa'),
                measurementRow('ambient'),
                weatherRow(),
                measurementRow('salt', '#/history/salt')));
    };

    const pageLink = (href, iconName, title, detail) => h('a', { class: 'card panel-link', href },
        h('span', { class: 'badge' }, icon(iconName)),
        h('span', { class: 'text' },
            h('strong', null, title),
            h('span', null, detail)),
        icon('chevronRight'));

    const dashboard = () => [
        temperatureCard(),
        h('div', { class: ['dashboard-controls', store.isConnected ? '' : 'disabled'] },
            accessNote(store),
            taskSection(app)),
        pageLink('#/equipment', 'toggle', 'Equipment', 'Every switch, the water flow and the heaters'),
        pageLink('#/panel', 'dpad', 'Panel Control', 'Every menu and setting on the controller'),
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
                leading: store.connection !== 'connected' ? connectionIndicator() : null,
                trailing: barButton({ label: 'Settings', iconName: 'gear', onClick: () => navigate('settings') })
            }),
            store.needsAttention ? checkSystemBar() : null,
            h('main', { class: 'page wide' },
                h('div', { class: 'dashboard' },
                    store.connection === 'disconnected' ? offlineBanner() : null,
                    store.errorMessage && store.isConnected
                        ? h('div', { class: 'card error-note', role: 'alert' }, icon('warning'), store.errorMessage)
                        : null,
                    store.readings.length ? dashboard() : placeholder()))
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
