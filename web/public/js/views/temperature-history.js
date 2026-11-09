// Temperature against time for the pool or spa, with air temperature and the times the heater
// and heat pump were warming it.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { TemperatureHistory, HEATER, HEAT_PUMP, valueAt, levelFor } from '../history.js';
import { openHistoryCalendar } from './history-calendar.js';
import { TimeChart } from '../chart.js';
import { waterBody } from '../model.js';
import * as prefs from '../prefs.js';
import { formatMonthDayTime, formatMonthDay, formatMonthYear, formatHour, formatSpan } from '../format.js';
import { topbar, barButton, spinner, renderer } from '../ui.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PRESETS = [
    { id: 'day', title: 'Day', length: DAY },
    { id: 'week', title: 'Week', length: 7 * DAY },
    { id: 'month', title: 'Month', length: 30 * DAY }
];
const MINIMUM_LENGTH = HOUR;
// years of history are summarized by day, so even the longest view stays light
const MAXIMUM_LENGTH = 10 * 365 * DAY;
const ZOOM_STEP = 2;
// how often to fetch readings newer than the last fetch while the page is open
const REFRESH_MS = 60 * 1000;
// lets dragging and zooming settle before asking for more data
const LOAD_DELAY_MS = 300;
const LONG_PRESS_MS = 400;
const DRAG_THRESHOLD_PX = 6;
const COLORS = {
    water: 'var(--blue)',
    air: 'var(--gray)',
    heater: 'var(--orange)',
    heatPump: 'var(--pink)'
};
// the heating bands and their legend swatches share these, so the legend matches the plot
const HEATER_OPACITY = 0.28;
const HEAT_PUMP_OPACITY = 0.24;
// a bucket's range, behind its average
const RANGE_OPACITY = 0.16;

const timeLabel = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const tickLabel = (t, step) => {
    if (step < HOUR) {
        return timeLabel.format(t);
    }
    if (step < DAY) {
        return formatHour(t);
    }
    return step < 30 * DAY ? formatMonthDay(t) : formatMonthYear(t);
};

export const mountTemperatureHistory = (root, app, water) => {
    const body = waterBody(water);
    const model = new TemperatureHistory(water, app.client, () => redraw());
    let now = Date.now();
    let length = PRESETS[0].length;
    let start = now - length;
    // null once the window has been zoomed away from every preset: shown as Custom
    let preset = 'day';
    // the time under the pointer while reading values off the graph
    let selected = null;
    // what the legend's switches show on the graph, kept between visits
    const shown = {
        air: prefs.read('showAirTemperature', true),
        heater: prefs.read('showHeater', true),
        heatPump: prefs.read('showHeatPump', true)
    };
    const helpSeen = prefs.read('historyHelpSeen', false);
    let chart = null;
    let loadTimer = null;
    let gesture = null;
    const pointers = new Map();

    // MARK: the window

    const domainStart = () => Math.min(model.earliest ?? now, now - length);
    const clampStart = (value) => Math.min(now - length, Math.max(domainStart(), value));
    const atNow = () => start + length >= now - length / 20;
    /** the bucket length that gives about one point per pixel at this zoom */
    const level = () => levelFor(length, chart ? chart.devicePixels : 1000);
    const drawnLevel = () => model.displayLevel(level(), start, start + length, now);

    const show = (newLength, endingAt) => {
        length = newLength;
        start = clampStart(endingAt - newLength);
        windowChanged();
    };

    /** changes the zoom, keeping the right edge on now if it was there, or the center otherwise */
    const setLength = (requested) => {
        const newLength = Math.min(MAXIMUM_LENGTH, Math.max(MINIMUM_LENGTH, requested));
        if (atNow()) {
            show(newLength, now);
        } else {
            const center = start + length / 2;
            length = newLength;
            start = clampStart(Math.min(center - newLength / 2, now - newLength));
            windowChanged();
        }
    };

    const zoom = (factor) => {
        preset = null;
        setLength(length * factor);
    };

    const pan = (ms) => {
        start = clampStart(start + ms);
        windowChanged();
    };

    /** shows the days picked in the calendar, as far as the zoom limits allow */
    const chooseDates = async () => {
        const picked = await openHistoryCalendar(app, [start, start + length], model.temperatureName);
        if (!picked) {
            return;
        }
        preset = null;
        now = Date.now();
        const end = Math.min(picked[1], now);
        show(Math.min(MAXIMUM_LENGTH, Math.max(MINIMUM_LENGTH, end - picked[0])), end);
    };

    const choosePreset = (choice) => {
        preset = choice.id;
        now = Date.now();
        show(choice.length, now);
    };

    const windowChanged = () => {
        redraw();
        clearTimeout(loadTimer);
        loadTimer = setTimeout(() => {
            const margin = length / 2;
            model.ensureLoaded(start - margin, Math.min(now, start + length + margin), level());
        }, LOAD_DELAY_MS);
    };

    const refreshTimer = setInterval(() => {
        const following = atNow();
        now = Date.now();
        if (following) {
            start = now - length;
        }
        const through = model.loadedThrough(level());
        if (through !== null) {
            model.ensureLoaded(through, now, level());
        }
        redraw();
    }, REFRESH_MS);

    // MARK: pointer and keyboard

    const onPointerDown = (event) => {
        const host = event.currentTarget;
        host.setPointerCapture(event.pointerId);
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.size === 2) {
            clearTimeout(gesture && gesture.pressTimer);
            const [a, b] = [...pointers.values()];
            gesture = { mode: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, length };
            selected = null;
            return;
        }
        gesture = { mode: 'pending', x: event.clientX, start, pointerType: event.pointerType };
        if (event.pointerType === 'mouse') {
            gesture.mode = 'pan';
        } else {
            // touch and hold reads values off the graph; a drag moves through time
            gesture.pressTimer = setTimeout(() => {
                if (gesture && gesture.mode === 'pending') {
                    gesture.mode = 'select';
                    selected = chart.timeAt(gesture.x);
                    redraw();
                }
            }, LONG_PRESS_MS);
        }
    };

    const onPointerMove = (event) => {
        if (pointers.has(event.pointerId)) {
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }
        if (!gesture) {
            if (event.pointerType === 'mouse' && chart) {
                selected = chart.timeAt(event.clientX);
                redraw();
            }
            return;
        }
        if (gesture.mode === 'pinch' && pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
            preset = null;
            setLength(gesture.length / (distance / gesture.distance));
            return;
        }
        const moved = event.clientX - gesture.x;
        if (gesture.mode === 'pending' && Math.abs(moved) > DRAG_THRESHOLD_PX) {
            clearTimeout(gesture.pressTimer);
            gesture.mode = 'pan';
        }
        if (gesture.mode === 'pan') {
            selected = null;
            start = clampStart(gesture.start - moved * chart.msPerPixel);
            windowChanged();
        } else if (gesture.mode === 'select') {
            selected = chart.timeAt(event.clientX);
            redraw();
        }
    };

    const onPointerUp = (event) => {
        pointers.delete(event.pointerId);
        if (gesture) {
            clearTimeout(gesture.pressTimer);
            if (gesture.mode === 'select') {
                selected = null;
            }
        }
        gesture = null;
        if (event.pointerType === 'mouse' && event.type === 'pointerup' && chart) {
            selected = chart.timeAt(event.clientX);
        }
        redraw();
    };

    const onPointerLeave = (event) => {
        if (event.pointerType === 'mouse' && !gesture) {
            selected = null;
            redraw();
        }
    };

    const onWheel = (event) => {
        event.preventDefault();
        const scale = event.deltaMode === 1 ? 16 : 1;
        if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && !event.ctrlKey) {
            pan(event.deltaX * scale * chart.msPerPixel);
            return;
        }
        // a trackpad pinch arrives as a wheel with ctrlKey, in smaller steps
        const factor = Math.exp(event.deltaY * scale * (event.ctrlKey ? 0.01 : 0.002));
        zoom(factor);
    };

    const onKeydown = (event) => {
        const actions = {
            ArrowLeft: () => pan(-length / 10),
            ArrowRight: () => pan(length / 10),
            '+': () => zoom(1 / ZOOM_STEP),
            '=': () => zoom(1 / ZOOM_STEP),
            '-': () => zoom(ZOOM_STEP),
            Escape: () => { selected = null; redraw(); }
        };
        if (actions[event.key]) {
            event.preventDefault();
            actions[event.key]();
        }
    };

    const attachChart = (host) => {
        if (chart && chart.container === host) {
            return;
        }
        if (chart) {
            chart.destroy();
        }
        chart = new TimeChart(host, { yLabel: (v) => `${Math.round(v)}°F`, tickLabel });
        drawChart();
    };

    // MARK: drawing

    const lines = () => {
        const drawn = drawnLevel();
        const through = model.loadedThrough(drawn);
        const end = through !== null ? Math.min(through, now) : now;
        return {
            resolution: model.resolution(drawn),
            segments: model.waterSegments(end, drawn),
            air: shown.air ? model.airLine(end, drawn) : [],
            heater: shown.heater ? model.heatingSpans(HEATER, end, drawn) : [],
            heatPump: shown.heatPump ? model.heatingSpans(HEAT_PUMP, end, drawn) : []
        };
    };

    /** the water temperature at t, or null when the pump was off and the line has a gap */
    const waterValue = (t, segments) => {
        for (const segment of segments) {
            if (segment[0].t <= t && t <= segment[segment.length - 1].t) {
                return valueAt(segment, t);
            }
        }
        return null;
    };

    /** fits the readings in view, with a little room above and below */
    const yDomain = ({ segments, air }) => {
        const end = start + length;
        const values = [];
        [...segments, air].forEach((line) => {
            line.forEach((sample) => {
                if (sample.t >= start && sample.t <= end) {
                    values.push(...[sample.v, sample.low, sample.high].filter((v) => v !== null && v !== undefined));
                }
            });
            const opening = valueAt(line, start);
            if (opening !== null) {
                values.push(opening);
            }
        });
        if (!values.length) {
            return [40, 100];
        }
        return [Math.floor(Math.min(...values) - 3), Math.ceil(Math.max(...values) + 3)];
    };

    const drawChart = () => {
        if (!chart) {
            return;
        }
        const data = lines();
        const [yMin, yMax] = yDomain(data);
        const value = selected !== null ? waterValue(selected, data.segments) : null;
        chart.set({
            from: start,
            to: start + length,
            yMin,
            yMax,
            label: `${body.title} temperature from ${formatMonthDayTime(start)} to ${formatMonthDayTime(start + length)}`,
            // a bucket is shaded by how much of it the heat was on
            bands: [
                ...data.heater.map((band) => ({ ...band, color: COLORS.heater, opacity: HEATER_OPACITY * band.intensity })),
                ...data.heatPump.map((band) => ({ ...band, color: COLORS.heatPump, opacity: HEAT_PUMP_OPACITY * band.intensity }))
            ],
            ranges: data.segments.map((points) => ({ points, color: COLORS.water, opacity: RANGE_OPACITY })),
            lines: [
                { points: data.air, color: COLORS.air, width: 1.5, dash: '4 3' },
                ...data.segments.map((points) => ({ points, color: COLORS.water, width: 2.5 }))
            ],
            dots: value !== null ? [{ t: selected, v: value, color: COLORS.water, r: 5 }] : [],
            rule: selected
        });
        return data;
    };

    const readout = (data) => {
        if (selected === null) {
            return h('span', null, `${formatMonthDayTime(start)} – ${formatMonthDayTime(start + length)}`);
        }
        const water = waterValue(selected, data.segments);
        const air = valueAt(data.air, selected);
        const heated = [...data.heater, ...data.heatPump].some((band) => band.start <= selected && selected <= band.end);
        return [
            h('span', { class: 'when' }, formatMonthDayTime(selected)),
            h('span', { style: { color: COLORS.water } }, water !== null ? `${body.title} ${Math.trunc(water)}°F` : `${body.title} pump off`),
            air !== null ? h('span', { class: 'secondary' }, `Air ${Math.trunc(air)}°F`) : null,
            heated ? h('span', { style: { color: COLORS.heater } }, icon('flame', { filled: true, label: 'Heating' })) : null
        ];
    };

    // the air, heater and heat pump entries double as their show/hide switches
    const legendToggle = (key, pref, title, tooltip, swatch) => h('button', {
        class: ['legend-toggle legend-item', shown[key] ? '' : 'off'],
        type: 'button',
        'aria-pressed': String(shown[key]),
        title: tooltip,
        onClick: () => {
            shown[key] = !shown[key];
            prefs.write(pref, shown[key]);
            redraw();
        }
    }, swatch, title, icon(shown[key] ? 'eye' : 'eyeOff'));

    const legend = () => h('div', { class: 'legend' },
        h('span', { class: 'legend-item', style: { color: COLORS.water } }, h('span', { class: 'legend-line' }), h('span', { style: { color: 'var(--text)' } }, body.title)),
        legendToggle('air', 'showAirTemperature', 'Air', 'Shows or hides air temperature on the graph', h('span', { class: 'legend-line' })),
        legendToggle('heater', 'showHeater', 'Heater', 'Shows or hides when the heater was on',
            h('span', { class: 'legend-band', style: { background: COLORS.heater, opacity: HEATER_OPACITY } })),
        legendToggle('heatPump', 'showHeatPump', 'Heat Pump', 'Shows or hides when the heat pump was on',
            h('span', { class: 'legend-band', style: { background: COLORS.heatPump, opacity: HEAT_PUMP_OPACITY } })));

    const render = () => {
        const data = drawChart() || lines();
        return [
            topbar({
                title: `${body.title} Temperature`,
                back: '',
                backTitle: app.poolName(),
                trailing: [
                    barButton({ label: 'Choose Dates', iconName: 'calendar', onClick: chooseDates }),
                    barButton({ label: 'Zoom Out', iconName: 'zoomOut', onClick: () => zoom(ZOOM_STEP), disabled: length >= MAXIMUM_LENGTH }),
                    barButton({ label: 'Zoom In', iconName: 'zoomIn', onClick: () => zoom(1 / ZOOM_STEP), disabled: length <= MINIMUM_LENGTH })
                ]
            }),
            h('main', { class: 'page full history-page' },
                h('div', { class: 'segmented', role: 'group', 'aria-label': 'Range' },
                    PRESETS.map((choice) => h('button', { type: 'button', 'aria-pressed': String(preset === choice.id), onClick: () => choosePreset(choice) }, choice.title)),
                    h('button', { type: 'button', 'aria-pressed': String(preset === null), disabled: preset !== null, title: 'Zoomed away from the presets' }, 'Custom')),
                h('div', { class: 'history-readout', 'aria-live': 'polite' },
                    readout(data),
                    model.isLoading ? spinner() : null),
                h('div', { class: 'card chart-card' },
                    h('div', {
                        class: ['chart', gesture && gesture.mode === 'pan' && gesture.pointerType === 'mouse' ? 'dragging' : ''],
                        'data-own': '',
                        tabindex: '0',
                        'aria-label': `${body.title} temperature graph. Arrow keys move through time; plus and minus zoom.`,
                        ref: attachChart,
                        onPointerdown: onPointerDown,
                        onPointermove: onPointerMove,
                        onPointerup: onPointerUp,
                        onPointercancel: onPointerUp,
                        onPointerleave: onPointerLeave,
                        onWheel,
                        onKeydown
                    }),
                    !data.segments.length && !model.isLoading
                        ? h('div', { class: 'chart-empty' }, `No ${body.title.toLowerCase()} temperature readings yet`)
                        : null),
                legend(),
                model.errorMessage ? h('div', { class: 'warning-line' }, icon('warning'), model.errorMessage) : null,
                h('div', { class: 'help' },
                    h('span', null, 'Gaps in the line are times the pump was off, when the sensor can’t read the water.'),
                    data.resolution > 0 ? h('span', null, `Each step averages ${formatSpan(data.resolution)}; the shading behind it spans its lowest to highest reading.`) : null,
                    helpSeen ? null : h('span', null, 'Drag the graph to move through time, scroll or pinch to zoom, and point at it (or touch and hold) to read a temperature.')))
        ];
    };

    const redraw = renderer(root, render);
    const unwatch = app.onSettingsChanged(redraw);
    document.title = `${body.title} Temperature`;
    redraw();
    windowChanged();

    return () => {
        prefs.write('historyHelpSeen', true);
        clearInterval(refreshTimer);
        clearTimeout(loadTimer);
        unwatch();
        if (chart) {
            chart.destroy();
        }
    };
};
