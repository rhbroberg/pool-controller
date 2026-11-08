// Salt level against time; salt changes slowly, so the ranges run longer than temperature's.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { isAbort } from '../api.js';
import { TimeChart } from '../chart.js';
import { extended, valueAt, MAX_POINTS } from '../history.js';
import { openHistoryCalendar } from './history-calendar.js';
import { formatMonthDayYear, formatMonthDay, formatMonthYear } from '../format.js';
import { topbar, barButton, spinner, renderer } from '../ui.js';

const DAY = 24 * 60 * 60 * 1000;
const RANGES = [
    { id: 'week', title: 'Week', length: 7 * DAY },
    { id: 'month', title: 'Month', length: 30 * DAY },
    { id: 'year', title: 'Year', length: 365 * DAY }
];
const READING = 'salt';
const COLOR = 'var(--teal)';
// a bucket's range, behind its average
const RANGE_OPACITY = 0.16;
const hourLabel = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });

export const mountSaltHistory = (root, app) => {
    // null while showing days picked in the calendar, held in custom as [from, to]
    let range = RANGES[1];
    let custom = null;
    let end = Date.now();
    let samples = [];
    let isLoading = false;
    let errorMessage = null;
    let selected = null;
    let chart = null;
    let generation = 0;

    const start = () => custom ? custom[0] : end - range.length;
    // about one point per pixel, so a long range comes back as daily buckets
    const maxPoints = () => Math.min(MAX_POINTS, Math.max(50, Math.round(chart ? chart.devicePixels : 1000)));

    const load = async () => {
        const loading = ++generation;
        end = custom ? custom[1] : Date.now();
        isLoading = true;
        redraw();
        try {
            const response = await app.client.fetchHistory([READING], start(), end, { maxPoints: maxPoints() });
            if (loading !== generation) {
                return;
            }
            const series = response.series.find((s) => s.name === READING);
            const bucketed = series && series.resolution > 0;
            const points = [...(series && series.before && !bucketed ? [series.before] : []), ...(series ? series.points : [])];
            const loaded = points.filter((p) => p.v !== null && p.v !== undefined)
                .map((p) => ({ t: Math.max(p.t, start()), v: p.v, low: p.low, high: p.high }));
            // readings are stored when they change, so the last one holds until now
            samples = extended(loaded, end);
            errorMessage = null;
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

    /** fits the readings, with room above and below */
    const yDomain = () => {
        const values = samples.flatMap((sample) => [sample.v, sample.low, sample.high]).filter((v) => v !== null && v !== undefined);
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
            from: start(),
            to: end,
            yMin,
            yMax,
            label: `Salt level from ${formatMonthDayYear(start())} to ${formatMonthDayYear(end)}`,
            ranges: [{ points: samples, color: COLOR, opacity: RANGE_OPACITY }],
            lines: [{ points: samples, color: COLOR, width: 2.5 }],
            dots,
            rule: selected
        });
    };

    const attachChart = (host) => {
        if (chart && chart.container === host) {
            return;
        }
        chart = new TimeChart(host, {
            yLabel: (v) => String(Math.round(v)),
            tickLabel: (t, step) => step < DAY ? hourLabel.format(t) : step < 30 * DAY ? formatMonthDay(t) : formatMonthYear(t)
        });
        drawChart();
    };

    const chooseDates = async () => {
        const picked = await openHistoryCalendar(app, [start(), end]);
        if (picked) {
            custom = [picked[0], Math.min(picked[1], Date.now())];
            range = null;
            selected = null;
            load();
        }
    };

    const select = (event) => {
        if (chart) {
            selected = chart.timeAt(event.clientX);
            redraw();
        }
    };

    const clearSelection = () => {
        selected = null;
        redraw();
    };

    const render = () => {
        drawChart();
        const value = selected !== null ? valueAt(samples, selected) : null;
        return [
            topbar({
                title: 'Salt Level',
                back: '',
                backTitle: app.poolName(),
                trailing: barButton({ label: 'Choose Dates', iconName: 'calendar', onClick: chooseDates })
            }),
            h('main', { class: 'page full history-page' },
                h('div', { class: 'segmented', role: 'group', 'aria-label': 'Range' },
                    RANGES.map((choice) => h('button', {
                        type: 'button',
                        'aria-pressed': String(Boolean(range) && choice.id === range.id),
                        onClick: () => {
                            range = choice;
                            custom = null;
                            selected = null;
                            load();
                        }
                    }, choice.title)),
                    custom ? h('button', { type: 'button', 'aria-pressed': 'true', disabled: true, title: 'Days picked in the calendar' }, 'Custom') : null),
                h('div', { class: 'history-readout', 'aria-live': 'polite' },
                    value !== null
                        ? [h('span', { class: 'when' }, formatMonthDayYear(selected)), h('span', { style: { color: COLOR } }, `${Math.trunc(value)} ppm`)]
                        : h('span', null, `${formatMonthDayYear(start())} – ${formatMonthDayYear(end)}`),
                    isLoading ? spinner() : null),
                h('div', { class: 'card chart-card' },
                    h('div', {
                        class: 'chart static',
                        'data-own': '',
                        ref: attachChart,
                        onPointerdown: (event) => {
                            event.currentTarget.setPointerCapture(event.pointerId);
                            select(event);
                        },
                        onPointermove: (event) => {
                            if (event.pointerType === 'mouse' || event.buttons) {
                                select(event);
                            }
                        },
                        onPointerup: (event) => {
                            if (event.pointerType !== 'mouse') {
                                clearSelection();
                            }
                        },
                        onPointerleave: clearSelection
                    }),
                    !samples.length && !isLoading && !errorMessage ? h('div', { class: 'chart-empty' }, 'No salt readings in this range') : null),
                errorMessage ? h('div', { class: 'warning-line' }, icon('warning'), errorMessage) : null,
                h('div', { class: 'help' }, 'Point at the graph, or touch and hold it, to read a level.'))
        ];
    };

    const redraw = renderer(root, render);
    const unwatch = app.onSettingsChanged(redraw);
    document.title = 'Salt Level';
    redraw();
    load();

    return () => {
        generation++;
        unwatch();
        if (chart) {
            chart.destroy();
        }
    };
};
