// The main page: temperatures, equipment and water flow, and the way to the panel's own menus.

import { h, confirmAction } from '../dom.js';
import { icon } from '../icons.js';
import { GROUPS, WATER_MODES, controlsIn, heatingDeviceFor, measurement, tileState, waterModeInfo } from '../model.js';
import { relative, countdown } from '../format.js';
import { topbar, barButton, navigate, signInPrompt, spinner, renderer } from '../ui.js';
import { openSetpoints } from './setpoints.js';

const CONNECTION_TITLES = { connecting: 'Connecting', connected: 'Connected', disconnected: 'Offline' };
// redraws this often so "Updated just now" and the retry countdown stay current
const TICK_MS = 1000;

export const mountDashboard = (root, app) => {
    const { store } = app;

    const request = (control) => {
        if (!store.credentials) {
            navigate('settings');
            return;
        }
        if (!store.canControl) {
            return;
        }
        const turnOn = !store.isOn(control);
        const confirmation = turnOn ? control.confirmOn : control.confirmOff;
        if (!confirmation) {
            store.setControl(control, turnOn);
            return;
        }
        confirmAction(confirmation).then((confirmed) => {
            if (confirmed) {
                store.setControl(control, turnOn);
            }
        });
    };

    const requestWaterMode = (mode) => {
        if (mode.id === store.waterMode) {
            return;
        }
        confirmAction({
            title: `Switch water flow to ${mode.title}?`,
            message: `${mode.summary} The valves can take up to a minute to turn.`,
            action: `Switch to ${mode.title}`
        }).then((confirmed) => {
            if (confirmed) {
                store.setWaterMode(mode.id);
            }
        });
    };

    // MARK: pieces

    const connectionIndicator = () => h('span', { class: ['connection-indicator', store.connection], 'aria-label': `Server ${CONNECTION_TITLES[store.connection]}` },
        h('span', { class: 'dot' }), CONNECTION_TITLES[store.connection]);

    const checkSystemBar = () => h('div', { class: 'check-system-bar', role: 'alert', 'aria-label': 'Check system: the controller reports a fault' },
        icon('warning'), 'Check System');

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
                measurementRow('salt', '#/history/salt')));
    };

    const accessNote = () => {
        if (!store.credentials) {
            return h('div', { class: 'span-all' }, signInPrompt('Sign in to change equipment and water flow', () => navigate('settings')));
        }
        if (!store.canControl) {
            return h('div', { class: 'access-note span-all' }, icon('eye'), 'View only. Your account can see equipment but not change it.');
        }
        return null;
    };

    /**
     * one piece of equipment: outlined in its colour while the controller reports it on, and
     * filled while it's running. For the heater and heat pump those differ: on is enabled,
     * running is producing heat, and a thermometer opens their setpoints.
     **/
    const tile = (control) => {
        const on = store.isOn(control);
        const pending = store.pendingState(control.name);
        const heating = store.heatingFor(control);
        const state = tileState(control, on, pending, heating);
        const device = heatingDeviceFor(control.name);
        const locked = !store.canControl;
        const accessibleState = state.targetSetpoint !== null && heating && heating.body
            ? `${state.text}, ${heating.body} setpoint ${state.targetSetpoint} degrees`
            : state.text;
        return h('div', {
            class: ['tile', on ? 'on' : '', state.running ? 'running' : ''],
            style: { '--tint': `var(--${control.tint})` },
            'data-key': control.name
        },
        h('button', {
            class: 'tile-main',
            type: 'button',
            disabled: pending !== undefined || !store.isConnected,
            'aria-pressed': String(on),
            'aria-label': `${control.title}: ${accessibleState}${locked ? ', locked' : ''}`,
            onClick: () => request(control)
        },
        h('span', { class: 'tile-icon' }, icon(control.icon, { filled: state.running })),
        h('span', { class: 'tile-text' },
            h('span', { class: 'tile-title' }, control.title),
            h('span', { class: 'tile-state' }, state.text)),
        pending !== undefined ? spinner('small') : locked ? icon('lock', { className: 'tile-lock' }) : null),
        device && store.heating
            ? h('button', {
                class: 'tile-setpoint',
                type: 'button',
                title: `${control.title} Setpoints`,
                'aria-label': `${control.title} Setpoints`,
                onClick: () => openSetpoints(app, device)
            }, icon('thermometer'), state.targetSetpoint !== null ? h('span', null, `${state.targetSetpoint}°`) : null)
            : null);
    };

    const tileGrid = (group) => h('div', { class: 'tile-grid' }, controlsIn(group).map(tile));

    /** pool, spa or spillover: shows the controller's mode and asks for the one picked */
    const waterFlow = () => {
        const current = store.waterMode;
        const pending = store.pendingWaterMode;
        const locked = !store.canControl;
        let status = null;
        if (pending) {
            status = `Switching to ${waterModeInfo(pending).title}…`;
        } else if (!current) {
            status = 'Waiting for the controller';
        }
        // no segment is selected until the controller reports a mode, and the highlight moves
        // only when it reaches the one requested
        return h('div', { class: 'card water-flow', title: 'Spillover pumps pool water through the spa so it spills back into the pool.' },
            h('div', { class: 'water-flow-header' },
                icon('branch'),
                h('span', null, 'Water Flow'),
                status ? h('span', { class: 'status' }, status) : null,
                pending ? spinner('small') : locked ? icon('lock', { className: 'tile-lock' }) : null),
            h('div', { class: 'segmented', role: 'group', 'aria-label': 'Water Flow' },
                WATER_MODES.map((mode) => h('button', {
                    type: 'button',
                    'aria-pressed': String(mode.id === current),
                    disabled: locked || Boolean(pending) || !current || !store.isConnected,
                    onClick: () => requestWaterMode(mode)
                }, mode.title))));
    };

    const controlSection = (group, ...content) => h('section', { class: 'control-section' },
        h('h2', { class: 'section-title' }, GROUPS.find((g) => g.id === group).title),
        h('div', { class: 'section-body' }, ...content));

    const panelLink = () => h('a', { class: 'card panel-link', href: '#/panel' },
        h('span', { class: 'badge' }, icon('dpad')),
        h('span', { class: 'text' },
            h('strong', null, 'Panel Control'),
            h('span', null, 'Every menu and setting on the controller')),
        icon('chevronRight'));

    const updateFooter = () => {
        const last = store.lastSwitchChange;
        return last ? h('div', { class: 'update-footer' }, `Equipment last changed ${relative(last)}`) : null;
    };

    const dashboard = () => [
        temperatureCard(),
        h('div', { class: ['dashboard-controls', store.isConnected ? '' : 'disabled'] },
            accessNote(),
            controlSection('heating', tileGrid('heating')),
            controlSection('circulation', waterFlow(), tileGrid('circulation')),
            controlSection('features', tileGrid('features'))),
        panelLink(),
        updateFooter()
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
