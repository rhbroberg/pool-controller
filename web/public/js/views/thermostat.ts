// Nest-style thermostat for one body of water: current temperature and the heater / heat-pump
// setpoints. By default both devices share one setpoint; they can be unlinked and set apart.

import { h, s } from '../dom.js';
import { icon } from '../icons.js';
import { waterBody, HEATING_DEVICES, setpointOf, measurement } from '../model.js';
import * as prefs from '../prefs.js';
import { topbar, spinner, renderer } from '../ui.js';

const DEFAULT_MIN = 65;
const DEFAULT_MAX = 104;
const DEFAULT_SETPOINT = 80;
const LINKED_PREF = 'thermostatLinkedSetpoints';
// SVG angles increase clockwise with y down: open arc along the bottom
const ARC_START = (135 * Math.PI) / 180;
const ARC_SWEEP = (270 * Math.PI) / 180;
const CX = 140;
const CY = 140;
const TRACK_R = 108;
const THUMB_R = 14;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const angleFor = (value: number, min: number, max: number) => {
    const t = max === min ? 0 : (value - min) / (max - min);
    return ARC_START + t * ARC_SWEEP;
};

const valueForAngle = (angle: number, min: number, max: number) => {
    let delta = angle - ARC_START;
    while (delta < 0) {
        delta += Math.PI * 2;
    }
    while (delta > Math.PI * 2) {
        delta -= Math.PI * 2;
    }
    const t = clamp(delta / ARC_SWEEP, 0, 1);
    return Math.round(min + t * (max - min));
};

const polar = (angle: number, radius: number) => ({
    x: CX + radius * Math.cos(angle),
    y: CY + radius * Math.sin(angle)
});

const arcPath = (from: number, to: number, radius: number) => {
    const start = polar(from, radius);
    const end = polar(to, radius);
    const large = to - from > Math.PI ? 1 : 0;
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${large} 1 ${end.x} ${end.y}`;
};

const angleAtEvent = (svg: SVGSVGElement, event: PointerEvent) => {
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 280 - CX;
    const y = ((event.clientY - rect.top) / rect.height) * 280 - CY;
    return Math.atan2(y, x);
};

export const mountThermostat = (root: any, app: any, waterId: any) => {
    const body = waterBody(waterId)!;
    const { store } = app;
    let linked = prefs.read(LINKED_PREF, true) !== false;
    let activeDevice = HEATING_DEVICES[0].id;
    let draft: number | null = null;
    let saving = false;
    let errorMessage: string | null = null;
    let drag: { pointerId: number } | null = null;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;

    const range = () => {
        const heating = store.heating;
        return heating ? [heating.minimum, heating.maximum] as const : [DEFAULT_MIN, DEFAULT_MAX] as const;
    };

    const readingDegrees = () => {
        const reading = store.reading(body.temperatureName);
        return reading && typeof reading.value === 'number' ? Math.round(reading.value) : null;
    };

    const deviceSetpoint = (deviceId: string) => setpointOf(store.heating, deviceId, body.id) ?? DEFAULT_SETPOINT;

    const displaySetpoint = () => {
        if (draft !== null) {
            return draft;
        }
        if (linked) {
            return Math.max(...HEATING_DEVICES.map((device) => deviceSetpoint(device.id)));
        }
        return deviceSetpoint(activeDevice);
    };

    const setLinked = (next: boolean) => {
        linked = next;
        prefs.write(LINKED_PREF, linked);
        draft = null;
        redraw();
    };

    const apply = (degrees: number) => {
        const [min, max] = range();
        draft = clamp(degrees, min, max);
        redraw();
        if (saveTimer) {
            clearTimeout(saveTimer);
        }
        saveTimer = setTimeout(() => {
            saveTimer = null;
            commit();
        }, drag ? 400 : 0);
    };

    const commit = async () => {
        if (draft === null || !store.canControl || saving) {
            return;
        }
        const degrees = draft;
        const targets = linked ? HEATING_DEVICES.map((device) => device.id) : [activeDevice];
        const pending = targets.filter((deviceId) => deviceSetpoint(deviceId) !== degrees);
        if (!pending.length) {
            draft = null;
            redraw();
            return;
        }
        saving = true;
        errorMessage = null;
        redraw();
        try {
            for (const deviceId of pending) {
                await store.setSetpoints({ [body.id]: degrees }, deviceId);
            }
            draft = null;
        } catch (error: any) {
            errorMessage = error.message || 'Couldn’t save the setpoint.';
        } finally {
            saving = false;
            redraw();
        }
    };

    const step = (delta: number) => {
        if (!store.canControl) {
            return;
        }
        apply(displaySetpoint() + delta);
    };

    const onPointerDown = (event: PointerEvent) => {
        if (!store.canControl || event.button !== 0) {
            return;
        }
        const svg = event.currentTarget as SVGSVGElement;
        svg.setPointerCapture(event.pointerId);
        drag = { pointerId: event.pointerId };
        const [min, max] = range();
        apply(valueForAngle(angleAtEvent(svg, event), min, max));
        event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
        if (!drag || drag.pointerId !== event.pointerId) {
            return;
        }
        const svg = event.currentTarget as SVGSVGElement;
        const [min, max] = range();
        apply(valueForAngle(angleAtEvent(svg, event), min, max));
        event.preventDefault();
    };

    const onPointerUp = (event: PointerEvent) => {
        if (!drag || drag.pointerId !== event.pointerId) {
            return;
        }
        drag = null;
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        commit();
    };

    const gauge = () => {
        const [min, max] = range();
        const setpoint = displaySetpoint();
        const current = readingDegrees();
        const setAngle = angleFor(setpoint, min, max);
        const currentAngle = current === null ? null : angleFor(clamp(current, min, max), min, max);
        const thumb = polar(setAngle, TRACK_R);
        const water = measurement(store.readings, body.temperatureName);
        const fill = arcPath(ARC_START, setAngle, TRACK_R);
        const track = arcPath(ARC_START, ARC_START + ARC_SWEEP, TRACK_R);
        const currentMark = currentAngle === null ? null : polar(currentAngle, TRACK_R);

        return h('div', { class: 'thermostat-gauge' },
            s('svg', {
                class: ['thermostat-dial', drag ? 'dragging' : ''],
                viewBox: '0 0 280 280',
                role: 'slider',
                'aria-valuemin': min,
                'aria-valuemax': max,
                'aria-valuenow': setpoint,
                'aria-valuetext': `${setpoint} degrees`,
                'aria-label': `${body.title} setpoint`,
                'aria-disabled': String(!store.canControl),
                onPointerdown: onPointerDown,
                onPointermove: onPointerMove,
                onPointerup: onPointerUp,
                onPointercancel: onPointerUp
            },
                s('path', { class: 'thermostat-track', d: track, fill: 'none' }),
                s('path', { class: 'thermostat-fill', d: fill, fill: 'none' }),
                currentMark ? s('circle', { class: 'thermostat-current-dot', cx: currentMark.x, cy: currentMark.y, r: 5 }) : null,
                s('circle', { class: 'thermostat-thumb', cx: thumb.x, cy: thumb.y, r: THUMB_R }),
                s('text', { class: 'thermostat-setpoint', x: CX, y: CY - 6, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, `${setpoint}°`),
                s('text', { class: 'thermostat-caption', x: CX, y: CY + 28, 'text-anchor': 'middle' }, 'Set to'),
                s('text', { class: 'thermostat-water', x: CX, y: CY + 52, 'text-anchor': 'middle' },
                    water.isDimmed ? `${body.title} ${water.value}` : `Now ${water.value}`)),
            h('div', { class: 'thermostat-steps', role: 'group', 'aria-label': `${body.title} setpoint` },
                h('button', {
                    class: 'thermostat-step',
                    type: 'button',
                    'aria-label': `Raise the ${body.title.toLowerCase()} setpoint`,
                    disabled: !store.canControl || saving || setpoint >= max,
                    onClick: () => step(1)
                }, icon('chevronUp')),
                h('button', {
                    class: 'thermostat-step',
                    type: 'button',
                    'aria-label': `Lower the ${body.title.toLowerCase()} setpoint`,
                    disabled: !store.canControl || saving || setpoint <= min,
                    onClick: () => step(-1)
                }, icon('chevronDown'))));
    };

    const deviceToggle = () => {
        if (linked) {
            return null;
        }
        return h('div', { class: 'segmented thermostat-devices', role: 'group', 'aria-label': 'Heating device' },
            HEATING_DEVICES.map((device) => h('button', {
                type: 'button',
                'aria-pressed': String(activeDevice === device.id),
                onClick: () => {
                    activeDevice = device.id;
                    draft = null;
                    redraw();
                }
            }, device.title)));
    };

    const summary = () => h('div', { class: 'thermostat-summary' },
        HEATING_DEVICES.map((device) => {
            const value = linked
                ? displaySetpoint()
                : (device.id === activeDevice && draft !== null ? draft : deviceSetpoint(device.id));
            return h('button', {
                class: ['thermostat-device', !linked && activeDevice === device.id ? 'active' : ''],
                type: 'button',
                disabled: linked,
                onClick: () => {
                    activeDevice = device.id;
                    draft = null;
                    redraw();
                }
            },
                h('span', { class: 'title' }, device.title),
                h('span', { class: 'value' }, `${value}°F`));
        }));

    const note = () => {
        const parts = [] as string[];
        if (store.heating && store.heating.setpointsReachController === false) {
            parts.push('The server keeps these setpoints itself for now; they aren’t sent to the controller yet.');
        } else if (saving) {
            parts.push('Writing to the controller’s Settings menu; this can take up to a minute per heat source.');
        }
        if (!store.credentials) {
            parts.push('Sign in to change the setpoint.');
        } else if (!store.canControl) {
            parts.push('Your account can see the setpoint but not change it.');
        }
        return parts.length ? h('p', { class: 'thermostat-note' }, parts.join(' ')) : null;
    };

    const render = () => [
        topbar({
            title: `${body.title} Thermostat`,
            back: '',
            backTitle: app.poolName(),
            trailing: h('a', {
                class: 'bar-button',
                href: `#/history/${body.id}`,
                title: 'Temperature history',
                'aria-label': `${body.title} temperature history`
            }, icon('thermometer'), h('span', null, 'History'))
        }),
        h('main', { class: 'page full thermostat-page' },
            h('div', { class: 'card thermostat-card' },
                gauge(),
                h('div', { class: 'thermostat-link-row' },
                    h('label', { class: 'thermostat-link' },
                        h('input', {
                            type: 'checkbox',
                            checked: linked,
                            disabled: !store.canControl,
                            onChange: (event: any) => setLinked(event.target.checked)
                        }),
                        'Keep heater and heat pump together'),
                    saving ? spinner() : null),
                deviceToggle(),
                summary(),
                errorMessage ? h('div', { class: 'message-box error-text' }, errorMessage) : null,
                note()))
    ];

    const redraw = renderer(root, render);
    const unsubscribe = store.subscribe(redraw);
    redraw();
    return () => {
        unsubscribe();
        if (saveTimer) {
            clearTimeout(saveTimer);
        }
    };
};

export const thermostatMath = { angleFor, valueForAngle, clamp, ARC_START, ARC_SWEEP };
