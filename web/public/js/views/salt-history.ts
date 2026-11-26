// Salt level against time. Zoom, pan, presets and restore match the temperature graphs.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { isAbort } from '../api.js';
import { TimeChart } from '../chart.js';
import { extended, valueAt, MAX_POINTS } from '../history.js';
import { openHistoryCalendar } from './history-calendar.js';
import * as prefs from '../prefs.js';
import { formatMonthDayTime, formatMonthDay, formatMonthYear, formatHour, formatSpan } from '../format.js';
import { topbar, barButton, backTo, spinner, renderer } from '../ui.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PRESETS = [
    { id: 'day', title: 'Day', length: DAY },
    { id: 'week', title: 'Week', length: 7 * DAY },
    { id: 'month', title: 'Month', length: 30 * DAY }
];
const MINIMUM_LENGTH = HOUR;
const MAXIMUM_LENGTH = 10 * 365 * DAY;
const ZOOM_STEP = 2;
const REFRESH_MS = 60 * 1000;
const LOAD_DELAY_MS = 300;
const LONG_PRESS_MS = 400;
const DRAG_THRESHOLD_PX = 6;
const READING = 'salt';
const COLOR = 'var(--teal)';
const RANGE_OPACITY = 0.16;
const VIEWPORT_KEY = 'saltHistoryViewport';

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

export const mountSaltHistory = (root, app, query) => {
    let now = Date.now();
    let length = PRESETS[1].length;
    let start = now - length;
    // null once the window has been zoomed away from every preset: shown as Custom
    let preset: string | null = 'month';
    let samples: any[] = [];
    let earliest: any = null;
    let resolution = 0;
    let isLoading = false;
    let errorMessage: string | null = null;
    let selected: any = null;
    let chart: any = null;
    let loadTimer: any = null;
    let saveTimer: any = null;
    let generation = 0;
    let gesture: any = null;
    const pointers = new Map();
    const helpSeen = prefs.read('historyHelpSeen', false);

    const saved = prefs.read(VIEWPORT_KEY, null);
    if (saved && typeof saved.length === 'number' && typeof saved.start === 'number' && saved.length > 0) {
        length = Math.min(MAXIMUM_LENGTH, Math.max(MINIMUM_LENGTH, saved.length));
        start = Math.min(saved.start, now - length);
        preset = (PRESETS.find((choice) => Math.abs(choice.length - length) < 1) || {}).id || null;
    }

    // MARK: the window

    const domainStart = () => Math.min(earliest ?? now, start, now - length);
    const clampStart = (value) => Math.min(now - length, Math.max(domainStart(), value));
    const atNow = () => start + length >= now - length / 20;
    // about one point per pixel, so a long range comes back as daily buckets
    const maxPoints = () => Math.min(MAX_POINTS, Math.max(50, Math.round(chart ? chart.devicePixels : 1000)));

    const saveViewport = () => {
        clearTimeout(saveTimer);
        saveTimer = null;
        prefs.write(VIEWPORT_KEY, { length, start });
    };

    const scheduleViewportSave = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveViewport, 200);
    };

    const show = (newLength, endingAt) => {
        length = newLength;
        start = clampStart(endingAt - newLength);
        windowChanged();
        saveViewport();
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
            saveViewport();
        }
    };

    const zoom = (factor) => {
        preset = null;
        setLength(length * factor);
    };

    const pan = (ms) => {
        start = clampStart(start + ms);
        windowChanged();
        scheduleViewportSave();
    };

    /** shows the days picked in the calendar, as far as the zoom limits allow */
    const chooseDates = async () => {
        const picked = await openHistoryCalendar(app, [start, start + length]);
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

    const load = async () => {
        const loading = ++generation;
        const margin = length / 2;
        const from = start - margin;
        const to = Math.min(now, start + length + margin);
        if (!(from < to)) {
            return;
        }
        isLoading = true;
        redraw();
        try {
            const response = await app.client.fetchHistory([READING], from, to, { maxPoints: maxPoints() });
            if (loading !== generation) {
                return;
            }
            if (response.earliest !== null && response.earliest !== undefined) {
                earliest = earliest === null ? response.earliest : Math.min(earliest, response.earliest);
            }
            const series = response.series.find((s) => s.name === READING);
            const bucketed = series && series.resolution > 0;
            resolution = bucketed ? series.resolution : 0;
            const points = [...(series && series.before && !bucketed ? [series.before] : []), ...(series ? series.points : [])];
            const loaded = points.filter((p) => p.v !== null && p.v !== undefined)
                .map((p) => ({ t: Math.max(p.t, from), v: p.v, low: p.low, high: p.high, span: resolution * 1000 }));
            // readings are stored when they change, so the last one holds until now
            samples = extended(loaded, to);
            errorMessage = null;
            // domain may have widened with earliest; keep the restored pan in range
            start = clampStart(start);
        } catch (error) {
            if (!isAbort(error) && loading === generation) {
                errorMessage = error.message;
            }
        } finally {
            if (loading === generation) {
                isLoading = false;
                redraw();
            }
        }
    };

    const windowChanged = () => {
        redraw();
        clearTimeout(loadTimer);
        loadTimer = setTimeout(load, LOAD_DELAY_MS);
    };

    const refreshTimer = setInterval(() => {
        const following = atNow();
        now = Date.now();
        if (following) {
            start = now - length;
        }
        load();
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
            scheduleViewportSave();
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
        chart = new TimeChart(host, { yLabel: (v) => String(Math.round(v)), tickLabel });
        drawChart();
    };

    // MARK: drawing

    /** the longest bucket overlapping the time in view, in seconds */
    const bucketSeconds = () => {
        const end = start + length;
        return samples.reduce((span, sample) => {
            const stop = sample.span > 0 ? sample.t + sample.span : sample.t;
            return sample.span > 0 && sample.t < end && stop > start ? Math.max(span, sample.span) : span;
        }, 0) / 1000 || resolution;
    };

    /** fits the readings in view, with room above and below */
    const yDomain = () => {
        const end = start + length;
        const values = samples.flatMap((sample) => {
            if (sample.t < start || sample.t > end) {
                return [];
            }
            return [sample.v, sample.low, sample.high].filter((v) => v !== null && v !== undefined);
        });
        const opening = valueAt(samples, start);
        if (opening !== null) {
            values.push(opening);
        }
        if (!values.length) {
            return [2000, 4000];
        }
        return [Math.max(0, Math.floor(Math.min(...values) - 200)), Math.ceil(Math.max(...values) + 200)];
    };

    const drawChart = () => {
        if (!chart) {
            return;
        }
        const [yMin, yMax] = yDomain();
        const value = selected !== null ? valueAt(samples, selected) : null;
        // a reading or two make too short a line to see
        const dots = samples.length < 3 ? samples.map((sample) => ({ ...sample, color: COLOR })) : [];
        if (value !== null) {
            dots.push({ t: selected, v: value, color: COLOR, r: 5 });
        }
        chart.set({
            from: start,
            to: start + length,
            yMin,
            yMax,
            label: `Salt level from ${formatMonthDayTime(start)} to ${formatMonthDayTime(start + length)}`,
            ranges: [{ points: samples, color: COLOR, opacity: RANGE_OPACITY }],
            lines: [{ points: samples, color: COLOR, width: 2.5 }],
            dots,
            rule: selected
        });
    };

    const readout = () => {
        if (selected === null) {
            return h('span', null, `${formatMonthDayTime(start)} – ${formatMonthDayTime(start + length)}`);
        }
        const value = valueAt(samples, selected);
        return [
            h('span', { class: 'when' }, formatMonthDayTime(selected)),
            value !== null ? h('span', { style: { color: COLOR } }, `${Math.trunc(value)} ppm`) : null
        ];
    };

    const render = () => {
        drawChart();
        const summary = bucketSeconds();
        return [
            topbar({
                title: 'Salt Level',
                ...backTo(query, { back: '', backTitle: app.poolName() }),
                trailing: [
                    barButton({ label: 'Choose Dates', iconName: 'calendar', onClick: chooseDates }),
                    barButton({ label: 'Zoom Out', iconName: 'zoomOut', onClick: () => zoom(ZOOM_STEP), disabled: length >= MAXIMUM_LENGTH }),
                    barButton({ label: 'Zoom In', iconName: 'zoomIn', onClick: () => zoom(1 / ZOOM_STEP), disabled: length <= MINIMUM_LENGTH })
                ]
            }),
            h('main', { class: 'page full history-page' },
                h('div', { class: 'segmented', role: 'group', 'aria-label': 'Range' },
                    PRESETS.map((choice) => h('button', {
                        type: 'button',
                        'aria-pressed': String(preset === choice.id),
                        onClick: () => choosePreset(choice)
                    }, choice.title)),
                    h('button', { type: 'button', 'aria-pressed': String(preset === null), disabled: preset !== null, title: 'Zoomed away from the presets' }, 'Custom')),
                h('div', { class: 'history-readout', 'aria-live': 'polite' },
                    readout(),
                    isLoading ? spinner() : null),
                h('div', { class: 'card chart-card' },
                    h('div', {
                        class: ['chart', gesture && gesture.mode === 'pan' && gesture.pointerType === 'mouse' ? 'dragging' : ''],
                        'data-own': '',
                        tabindex: '0',
                        'aria-label': 'Salt level graph. Arrow keys move through time; plus and minus zoom.',
                        ref: attachChart,
                        onPointerdown: onPointerDown,
                        onPointermove: onPointerMove,
                        onPointerup: onPointerUp,
                        onPointercancel: onPointerUp,
                        onPointerleave: onPointerLeave,
                        onWheel,
                        onKeydown
                    }),
                    summary > 0 ? h('div', { class: 'chart-summary' }, `Summary · ${formatSpan(summary)} averages`) : null,
                    !samples.length && !isLoading && !errorMessage
                        ? h('div', { class: 'chart-empty' }, 'No salt readings in this range')
                        : null),
                errorMessage ? h('div', { class: 'warning-line' }, icon('warning'), errorMessage) : null,
                h('div', { class: 'help' },
                    summary > 0 ? h('span', null, `Each step averages ${formatSpan(summary)}; the shading behind it spans its lowest to highest reading.`) : null,
                    helpSeen ? null : h('span', null, 'Drag the graph to move through time, scroll or pinch to zoom, and point at it (or touch and hold) to read a level.')))
        ];
    };

    const redraw = renderer(root, render);
    const unwatch = app.onSettingsChanged(redraw);
    document.title = 'Salt Level';
    redraw();
    windowChanged();

    return () => {
        prefs.write('historyHelpSeen', true);
        saveViewport();
        generation++;
        clearInterval(refreshTimer);
        clearTimeout(loadTimer);
        clearTimeout(saveTimer);
        unwatch();
        if (chart) {
            chart.destroy();
        }
    };
};
