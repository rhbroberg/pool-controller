// Every switch the page offers, the water flow, and the heaters with their setpoints: what the
// main page showed before tasks.

import { h, confirmAction } from '../dom.js';
import { icon } from '../icons.js';
import { GROUPS, WATER_MODES, controlsIn, heatingDeviceFor, tileState, waterModeInfo } from '../model.js';
import { relative } from '../format.js';
import { topbar, spinner, renderer } from '../ui.js';
import { openSetpoints } from './setpoints.js';

export const accessNote = (store) => store.canControl
    ? null
    : h('div', { class: 'access-note span-all' }, icon('eye'), 'View only. Your account can see equipment but not change it.');

export const updateFooter = (store) => {
    const last = store.lastSwitchChange;
    return last ? h('div', { class: 'update-footer' }, `Equipment last changed ${relative(last)}`) : null;
};

export const mountEquipment = (root, app) => {
    const { store } = app;

    const request = (control) => {
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

    const render = () => {
        document.title = `Equipment · ${app.poolName()}`;
        return [
            topbar({ title: 'Equipment', back: '', backTitle: app.poolName() }),
            h('main', { class: 'page wide' },
                h('div', { class: 'dashboard' },
                    store.errorMessage && store.isConnected
                        ? h('div', { class: 'card error-note', role: 'alert' }, icon('warning'), store.errorMessage)
                        : null,
                    h('div', { class: ['dashboard-controls', store.isConnected ? '' : 'disabled'] },
                        accessNote(store),
                        controlSection('heating', tileGrid('heating')),
                        controlSection('circulation', waterFlow(), tileGrid('circulation')),
                        controlSection('features', tileGrid('features'))),
                    updateFooter(store)))
        ];
    };

    const redraw = renderer(root, render);
    const unsubscribe = store.subscribe(redraw);
    redraw();
    return unsubscribe;
};
