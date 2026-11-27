// Temperature against time for the pool or spa, with air temperature. The heater and heat pump
// color the water line itself while they were warming it.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { TemperatureHistory, HEATER, HEAT_PUMP, valueAt, levelFor, coloredWaterLines, heatingAt, historyWindow, clipped } from '../history.js';
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
// a bucket's range, behind its average
const RANGE_OPACITY = 0.16;

const timeLabel = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const tickLabel = (t: any, step: any) => {
    if (step < HOUR) {
        return timeLabel.format(t);
    }
    if (step < DAY) {
        return formatHour(t);
    }
    return step < 30 * DAY ? formatMonthDay(t) : formatMonthYear(t);
};

export const mountTemperatureHistory = (root: any, app: any, water: any) => {
    const body = waterBody(water)!;
    let dataEpoch = 0;
    const model = new TemperatureHistory(water, app.client, () => {
        dataEpoch += 1;
        redraw();
    });
    const viewportKey = water === 'pool' ? 'poolTemperatureHistoryViewport' : 'spaTemperatureHistoryViewport';
    let now = Date.now();
    let length = PRESETS[0].length;
    let start = now - length;
    // null once the window has been zoomed away from every preset: shown as Custom
    let preset: string | null = 'day';
    // the time under the pointer while reading values off the graph
    let selected: any = null;
    // what the legend's switches show on the graph, kept between visits
    const shown: Record<string, boolean> = {
        air: prefs.read('showAirTemperature', true),
        heater: prefs.read('showHeater', true),
        heatPump: prefs.read('showHeatPump', true)
    };
    const helpSeen = prefs.read('historyHelpSeen', false);
    let chart: any = null;
    let loadTimer: any = null;
    let saveTimer: any = null;
    let gesture: any = null;
    /** the strip last drawn into the chart; a pan only slides it when this is unchanged */
    let drawnStrip: { from: number; to: number; level: number; epoch: number; flags: string } | null = null;
    const pointers = new Map();

    const saved = prefs.read(viewportKey, null);
    if (saved && typeof saved.length === 'number' && typeof saved.start === 'number' && saved.length > 0) {
        length = Math.min(MAXIMUM_LENGTH, Math.max(MINIMUM_LENGTH, saved.length));
        start = Math.min(saved.start, now - length);
        preset = (PRESETS.find((choice) => Math.abs(choice.length - length) < 1) || {}).id || null;
    }

    // MARK: the window

    /** Left edge may not go earlier than the first reading the server has. */
    const domainStart = () => {
        const latest = now - length;
        return model.earliest != null ? Math.min(model.earliest, latest) : latest;
    };
    const clampStart = (value: any) => Math.min(now - length, Math.max(domainStart(), value));
    const atNow = () => start + length >= now - length / 20;
    /** the bucket length that gives about one point per pixel at this zoom */
    const level = () => levelFor(length, chart ? chart.devicePixels : 1000);
    const drawnLevel = () => model.displayLevel(level(), start, start + length, now);
    /** the strip of history drawn around the view; scales stay put while scrolling inside it */
    const stripBounds = () => {
        const window = historyWindow(start, length);
        const from = model.earliest != null ? Math.max(window.from, model.earliest) : window.from;
        return { from: Math.min(from, now), to: Math.min(window.to, now) };
    };

    const saveViewport = () => {
        clearTimeout(saveTimer);
        saveTimer = null;
        prefs.write(viewportKey, { length, start });
    };

    const scheduleViewportSave = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveViewport, 200);
    };

    const show = (newLength: any, endingAt: any) => {
        length = newLength;
        start = clampStart(endingAt - newLength);
        windowChanged();
        saveViewport();
    };

    /** changes the zoom, keeping the right edge on now if it was there, or the center otherwise */
    const setLength = (requested: any) => {
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

    const zoom = (factor: any) => {
        preset = null;
        setLength(length * factor);
    };

    const pan = (ms: any) => {
        start = clampStart(start + ms);
        windowChanged();
        scheduleViewportSave();
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

    const choosePreset = (choice: any) => {
        preset = choice.id;
        now = Date.now();
        show(choice.length, now);
    };

    const windowChanged = () => {
        redraw();
        clearTimeout(loadTimer);
        loadTimer = setTimeout(() => {
            // fetch the drawn strip, not every scroll tick
            const strip = stripBounds();
            if (strip.from < strip.to) {
                model.ensureLoaded(strip.from, strip.to, level());
            }
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

    const onPointerDown = (event: any) => {
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

    const onPointerMove = (event: any) => {
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

    const onPointerUp = (event: any) => {
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

    const onPointerLeave = (event: any) => {
        if (event.pointerType === 'mouse' && !gesture) {
            selected = null;
            redraw();
        }
    };

    const onWheel = (event: any) => {
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

    const onKeydown = (event: any) => {
        const actions: Record<string, () => void> = {
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

    const attachChart = (host: any) => {
        if (chart && chart.container === host) {
            return;
        }
        if (chart) {
            chart.destroy();
        }
        chart = new TimeChart(host, { yLabel: (v) => `${Math.round(v)}°F`, tickLabel });
        drawnStrip = null;
        drawChart();
    };

    // MARK: drawing

    /** the longest bucket overlapping the time in view, in seconds, or 0 for readings as recorded */
    const bucketSeconds = (samples: any) => {
        const end = start + length;
        return samples.reduce((span: any, sample: any) => {
            const stop = sample.span > 0 ? sample.t + sample.span : sample.t;
            return sample.span > 0 && sample.t < end && stop > start ? Math.max(span, sample.span) : span;
        }, 0) / 1000;
    };

    const lines = () => {
        const drawn = drawnLevel();
        const through = model.loadedThrough(drawn);
        const end = through !== null ? Math.min(through, now) : now;
        const strip = stripBounds();
        const segments = model.waterSegments(end, drawn)
            .map((segment: any) => clipped(segment, strip.from, strip.to))
            .filter((segment: any) => segment.length);
        const air = shown.air ? clipped(model.airLine(end, drawn), strip.from, strip.to) : [];
        const heater = shown.heater
            ? model.heatingSpans(HEATER, end, drawn).filter((span: any) => span.end >= strip.from && span.start <= strip.to)
            : [];
        const heatPump = shown.heatPump
            ? model.heatingSpans(HEAT_PUMP, end, drawn).filter((span: any) => span.end >= strip.from && span.start <= strip.to)
            : [];
        return {
            waterResolution: bucketSeconds(segments.flat()),
            airResolution: bucketSeconds(air),
            segments,
            air,
            heater,
            heatPump,
            strip
        };
    };

    /** a label for the graph while a line is averages rather than the readings */
    const summaryText = (waterSeconds: any, airSeconds: any) => {
        if (waterSeconds > 0) {
            return `Summary · ${formatSpan(waterSeconds)} averages`;
        }
        if (airSeconds > 0) {
            return `Air summary · ${formatSpan(airSeconds)} averages`;
        }
        return null;
    };

    /** the water temperature at t, or null when the pump was off and the line has a gap */
    const waterValue = (t: any, segments: any) => {
        for (const segment of segments) {
            if (segment[0].t <= t && t <= segment[segment.length - 1].t) {
                return valueAt(segment, t);
            }
        }
        return null;
    };

    /** fits the readings in the drawn strip, so a small pan doesn't rescale the graph */
    const yDomain = ({segments, air}: any) => {
        const values: any[] = [];
        [...segments, air].forEach((line) => {
            line.forEach((sample: any) => {
                values.push(...[sample.v, sample.low, sample.high].filter((v) => v !== null && v !== undefined));
            });
        });
        if (!values.length) {
            return [40, 100];
        }
        return [Math.floor(Math.min(...values) - 3), Math.ceil(Math.max(...values) + 3)];
    };

    const selectionOverlay = (data: any) => {
        const value = selected !== null ? waterValue(selected, data.segments) : null;
        const heatedAt = selected !== null ? heatingAt(selected, data.heater, data.heatPump) : null;
        const stroke = (source: string) => COLORS[source as keyof typeof COLORS] || COLORS.water;
        return {
            label: `${body.title} temperature from ${formatMonthDayTime(start)} to ${formatMonthDayTime(start + length)}`,
            dots: value !== null ? [{ t: selected, v: value, color: stroke(heatedAt || 'water'), r: 5 }] : [],
            rule: selected
        };
    };

    const drawChart = () => {
        if (!chart) {
            return;
        }
        const data = lines();
        const [yMin, yMax] = yDomain(data);
        const waterLines = coloredWaterLines(data.segments, data.heater, data.heatPump);
        const stroke = (source: string) => COLORS[source as keyof typeof COLORS] || COLORS.water;
        const overlay = selectionOverlay(data);
        const flags = `${shown.air}|${shown.heater}|${shown.heatPump}`;
        const drawn = drawnLevel();
        const sameStrip = drawnStrip
            && drawnStrip.from === data.strip.from
            && drawnStrip.to === data.strip.to
            && drawnStrip.level === drawn
            && drawnStrip.epoch === dataEpoch
            && drawnStrip.flags === flags;
        if (sameStrip) {
            chart.show({ from: start, to: start + length, ...overlay });
        } else {
            chart.set({
                from: start,
                to: start + length,
                stripFrom: data.strip.from,
                stripTo: data.strip.to,
                yMin,
                yMax,
                bands: [],
                ranges: waterLines.map((line) => ({ points: line.points, color: stroke(line.source), opacity: RANGE_OPACITY })),
                lines: [
                    { points: data.air, color: COLORS.air, width: 1.5, dash: '4 3' },
                    ...waterLines.map((line) => ({ points: line.points, color: stroke(line.source), width: 2.5 }))
                ],
                ...overlay
            });
            drawnStrip = { from: data.strip.from, to: data.strip.to, level: drawn, epoch: dataEpoch, flags };
        }
        return data;
    };

    const readout = (data: any) => {
        if (selected === null) {
            return h('span', null, `${formatMonthDayTime(start)} – ${formatMonthDayTime(start + length)}`);
        }
        const water = waterValue(selected, data.segments);
        const air = valueAt(data.air, selected);
        const heated = heatingAt(selected, data.heater, data.heatPump);
        return [
            h('span', { class: 'when' }, formatMonthDayTime(selected)),
            h('span', { style: { color: COLORS[heated || 'water'] } }, water !== null ? `${body.title} ${Math.trunc(water)}°F` : `${body.title} pump off`),
            air !== null ? h('span', { class: 'secondary' }, `Air ${Math.trunc(air)}°F`) : null,
            heated ? h('span', { style: { color: COLORS[heated] } }, icon('flame', { filled: true, label: heated === 'heater' ? 'Heater' : 'Heat pump' })) : null
        ];
    };

    // the air, heater and heat pump entries double as their show/hide switches
    const legendToggle = (key: any, pref: any, title: any, tooltip: any, swatch: any) => h('button', {
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
        legendToggle('heater', 'showHeater', 'Heater', 'Shows or hides heater stretches on the temperature line',
            h('span', { class: 'legend-line', style: { background: COLORS.heater } })),
        legendToggle('heatPump', 'showHeatPump', 'Heat Pump', 'Shows or hides heat-pump stretches on the temperature line',
            h('span', { class: 'legend-line', style: { background: COLORS.heatPump } })));

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
                    summaryText(data.waterResolution, data.airResolution)
                        ? h('div', { class: 'chart-summary' }, summaryText(data.waterResolution, data.airResolution))
                        : null,
                    !data.segments.length && !model.isLoading
                        ? h('div', { class: 'chart-empty' }, `No ${body.title.toLowerCase()} temperature readings yet`)
                        : null),
                legend(),
                model.errorMessage ? h('div', { class: 'warning-line' }, icon('warning'), model.errorMessage) : null,
                h('div', { class: 'help' },
                    h('span', null, 'Gaps in the line are times the pump was off, when the sensor can’t read the water.'),
                    data.waterResolution > 0 ? h('span', null, `Each step averages ${formatSpan(data.waterResolution)}; the shading behind it spans its lowest to highest reading.`) : null,
                    data.airResolution > 0 && data.airResolution !== data.waterResolution ? h('span', null, `The air line averages ${formatSpan(data.airResolution)}.`) : null,
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
        saveViewport();
        clearInterval(refreshTimer);
        clearTimeout(loadTimer);
        clearTimeout(saveTimer);
        unwatch();
        if (chart) {
            chart.destroy();
        }
    };
};
