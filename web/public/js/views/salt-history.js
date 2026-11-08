// Salt level against time; salt changes slowly, so the ranges run longer than temperature's.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { isAbort } from '../api.js';
import { TimeChart } from '../chart.js';
import { extended, valueAt } from '../history.js';
import { formatMonthDayYear, formatMonthDay } from '../format.js';
import { topbar, spinner, renderer } from '../ui.js';

const DAY = 24 * 60 * 60 * 1000;
const RANGES = [
    { id: 'week', title: 'Week', length: 7 * DAY },
    { id: 'month', title: 'Month', length: 30 * DAY },
    { id: 'year', title: 'Year', length: 365 * DAY }
];
const READING = 'salt';
const COLOR = 'var(--teal)';
const hourLabel = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });

export const mountSaltHistory = (root, app) => {
    let range = RANGES[1];
    let end = Date.now();
    let samples = [];
    let isLoading = false;
    let errorMessage = null;
    let selected = null;
    let chart = null;
    let generation = 0;

    const start = () => end - range.length;

    const load = async () => {
        const loading = ++generation;
        end = Date.now();
        isLoading = true;
        redraw();
        try {
            const response = await app.client.fetchHistory([READING], start(), end);
            if (loading !== generation) {
                return;
            }
            const series = response.series.find((s) => s.name === READING);
            const points = [...(series && series.before ? [series.before] : []), ...(series ? series.points : [])];
            const loaded = points.filter((p) => p.v !== null && p.v !== undefined).map((p) => ({ t: Math.max(p.t, start()), v: p.v }));
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
        const values = samples.map((sample) => sample.v);
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
            tickLabel: (t, step) => step < DAY ? hourLabel.format(t) : formatMonthDay(t)
        });
        drawChart();
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
            topbar({ title: 'Salt Level', back: '', backTitle: app.poolName() }),
            h('main', { class: 'page full history-page' },
                h('div', { class: 'segmented', role: 'group', 'aria-label': 'Range' },
                    RANGES.map((choice) => h('button', {
                        type: 'button',
                        'aria-pressed': String(choice.id === range.id),
                        onClick: () => {
                            range = choice;
                            selected = null;
                            load();
                        }
                    }, choice.title))),
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
