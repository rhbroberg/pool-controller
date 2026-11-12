'use strict';
// Finds the stretches of history that say how fast a body of water warms or cools.
//
// The history is a stream of stored changes: readings (water and air temperature) and switches
// (the filter, the water flow, the heater firing, the heat pump's valve), each stored only when
// it changes. This follows them in time order, cuts the time the pump ran into windows over which
// the body of water and the heat sources on stayed the same, and measures each: the slope of the
// water temperature in °F per hour, and the average water and air temperature.
//
// Not every window is fit to learn from. Each is marked suitable or says why not.

const sun = require('./sun');
const heating = require('../protocol/heating');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const DEFAULTS = {
    // the temperature sensor is in the plumbing: for this long after the pump starts, the water
    // flow changes or a heat source switches, it still shows what was before
    settleMs: 15 * MINUTE_MS,
    // a heater that flickers off and on again, or a valve that bounces, within this is one run
    flickerMs: 3 * MINUTE_MS,
    // silence from the controller this long means the server was down; what the switches did
    // meanwhile is unknown
    gapMs: 2 * HOUR_MS,
    // longer runs are cut so the air temperature doesn't swing too far within a window
    maxWindowMs: 4 * HOUR_MS,
    minHeatingMs: 45 * MINUTE_MS,
    minCoolingMs: 90 * MINUTE_MS,
    minHeatingReadings: 3,
    minCoolingReadings: 2,
    // how far the readings may stray from a straight line, in °F, before the sensor is distrusted
    maxScatterF: 1.5,
    // shorter windows aren't worth listing
    listMinMs: 30 * MINUTE_MS
};

// what each window had running: the heater, the heat pump, both, or neither (the water cooling)
const SOURCES = ['heater', 'heatpump', 'both', 'cooling'];

const SWITCHES = ['filter', 'aux14', 'spa', 'spillover', 'heater1', 'valve4'];
const SERIES = { pool: 'pool temp', spa: 'spa temp' };
const AIR = 'ambient';

/** the newest value at or before t, or undefined */
var valueAt = (series, t) => {
    let low = 0;
    let high = series.length - 1;
    let found;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (series[middle].t <= t) {
            found = series[middle].v;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return found;
};

/** the index of the first point after t */
var firstAfter = (series, t) => {
    let low = 0;
    let high = series.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (series[middle].t <= t) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
};

var pointsIn = (series, start, end) => {
    const points = [];
    for (let i = firstAfter(series, start); i < series.length && series[i].t <= end; i++) {
        points.push(series[i]);
    }
    return points;
};

/**
 * the average of a reading held between changes over start to end, or undefined when it wasn't
 * known for most of that
 **/
var meanOver = (series, start, end) => {
    let value = valueAt(series, start);
    let at = start;
    let known = 0;
    let total = 0;
    const move = (to) => {
        if (typeof value === 'number') {
            total += value * (to - at);
            known += to - at;
        }
        at = to;
    };
    pointsIn(series, start, end).forEach((point) => {
        move(point.t);
        value = point.v;
    });
    move(end);
    return known >= 0.8 * (end - start) ? total / known : undefined;
};

/**
 * the straight line, by least squares, through the points, as its slope in °F per hour and how
 * far the points stray from it; the readings are whole degrees that change in steps, which a
 * median of slopes would call flat but a line through them follows
 **/
var lineFit = (points, origin) => {
    let used = points;
    if (used.length > 400) {
        const step = Math.ceil(used.length / 400);
        used = used.filter((_, index) => index % step === 0 || index === used.length - 1);
    }
    const xs = used.map((point) => (point.t - origin) / HOUR_MS);
    const n = used.length;
    const meanX = xs.reduce((sum, x) => sum + x, 0) / n;
    const meanY = used.reduce((sum, point) => sum + point.v, 0) / n;
    const sxx = xs.reduce((sum, x) => sum + Math.pow(x - meanX, 2), 0);
    if (n < 2 || sxx < 1e-9) {
        return undefined;
    }
    const sxy = used.reduce((sum, point, index) => sum + (xs[index] - meanX) * (point.v - meanY), 0);
    const slope = sxy / sxx;
    const intercept = meanY - slope * meanX;
    const scatter = Math.sqrt(used.reduce((sum, point, index) => sum + Math.pow(point.v - (intercept + slope * xs[index]), 2), 0) / n);
    return { slope, scatter };
};

var sourcesOf = (heater, pump) => {
    if (heater && pump) {
        return 'both';
    }
    return heater ? 'heater' : pump ? 'heatpump' : 'cooling';
};

class WindowExtractor {
    /**
     * initial  { t, switches: { name: 0|1 }, readings: { 'pool temp': °F, ... } } as the range opens
     **/
    constructor(initial = {}, options = {}) {
        this.options = Object.assign({}, DEFAULTS, options);
        this.switches = {};
        SWITCHES.forEach((name) => {
            this.switches[name] = initial.switches && initial.switches[name] ? 1 : 0;
        });
        this.series = { 'pool temp': [], 'spa temp': [], [AIR]: [] };
        Object.keys(this.series).forEach((name) => {
            const value = initial.readings && initial.readings[name];
            if (typeof value === 'number' && value > 0 && typeof initial.t === 'number') {
                this.series[name].push({ t: initial.t, v: value });
            }
        });
        this.segments = [];
        this.open = null;
        this.last = undefined;
        this.gaps = [];
        this.events = 0;
    }

    /**
     * one stored event, in time order: { t, type: 'info' | 'status', status: [{ name, value }] }
     **/
    push({ t, type, status }) {
        if (typeof this.last === 'number' && t - this.last > this.options.gapMs) {
            this.gap(this.last, t);
        }
        this.last = t;
        this.events++;
        (status || []).forEach(({ name, value }) => {
            if (type === 'info' && this.series[name]) {
                // the controller shows nothing for a sensor it can't read; that is stored as unknown
                if (value > 0) {
                    this.series[name].push({ t, v: value });
                }
            } else if (type === 'status' && name in this.switches) {
                this.switches[name] = value ? 1 : 0;
            }
        });
        this.classify(t);
    }

    // after the server was down, it reports the switches that are on as new again; any it doesn't
    // mention are off
    gap(from, to) {
        this.gaps.push({ from, to });
        this.close(from);
        SWITCHES.forEach((name) => {
            this.switches[name] = 0;
        });
    }

    current() {
        const sw = this.switches;
        const body = heating.targetBody({
            filter: sw.filter === 1,
            spaFilter: sw.aux14 === 1,
            waterMode: sw.spillover === 1 ? 'spillover' : sw.spa === 1 ? 'spa' : 'pool'
        });
        return body ? { body, heater: sw.heater1 === 1, pump: sw.valve4 === 1 } : null;
    }

    classify(t) {
        const now = this.current();
        const open = this.open;
        const same = open && now && open.body === now.body && open.heater === now.heater && open.pump === now.pump;
        if (same || (!open && !now)) {
            return;
        }
        this.close(t);
        if (now) {
            this.open = Object.assign({ start: t }, now);
        }
    }

    close(t) {
        if (this.open) {
            this.open.end = t;
            this.segments.push(this.open);
            this.open = null;
        }
    }

    /** the windows, once every event has been pushed; `end` closes a run still going */
    finish(end) {
        this.close(typeof end === 'number' ? Math.min(end, this.last) : this.last);
        const windows = [];
        this.joinFlickers().forEach((segment) => {
            this.windowsOf(segment).forEach((window) => windows.push(window));
        });
        return windows
            .filter((window) => window.end - window.start >= this.options.listMinMs)
            .sort((a, b) => a.start - b.start)
            .map((window) => this.measure(window));
    }

    // a run too short to mean anything between two of the same joins them
    joinFlickers() {
        const { flickerMs } = this.options;
        let segments = this.segments.slice();
        let joined = true;
        while (joined) {
            joined = false;
            for (let i = 1; i < segments.length - 1; i++) {
                const [before, flicker, after] = [segments[i - 1], segments[i], segments[i + 1]];
                const same = before.body === after.body && flicker.body === before.body &&
                    before.heater === after.heater && before.pump === after.pump;
                if (same && flicker.end - flicker.start < flickerMs && before.end === flicker.start && flicker.end === after.start) {
                    segments = segments.slice(0, i - 1)
                        .concat([{ body: before.body, heater: before.heater, pump: before.pump, start: before.start, end: after.end }])
                        .concat(segments.slice(i + 2));
                    joined = true;
                    break;
                }
            }
        }
        return segments;
    }

    // a run's unsettled start is left out, as is the end of a heat pump's: with no signal of its
    // own, it is on while the water is already at its setpoint; then the temperature stops rising
    windowsOf(segment) {
        const { settleMs, maxWindowMs } = this.options;
        const start = segment.start + settleMs;
        let end = segment.end;
        const base = { body: segment.body, heater: segment.heater, pump: segment.pump };
        if (segment.pump && !segment.heater) {
            const points = pointsIn(this.series[SERIES[segment.body]], start, end);
            if (points.length > 0) {
                const top = Math.max(...points.map((point) => point.v));
                end = points.find((point) => point.v === top).t;
            }
        }
        if (end <= start) {
            return [Object.assign({ start: segment.start, end: segment.end, settling: true }, base)];
        }
        const pieces = Math.ceil((end - start) / maxWindowMs);
        const length = (end - start) / pieces;
        const windows = [];
        for (let piece = 0; piece < pieces; piece++) {
            windows.push(Object.assign({ start: Math.round(start + piece * length), end: Math.round(start + (piece + 1) * length) }, base));
        }
        return windows;
    }

    measure(window) {
        const { minHeatingMs, minCoolingMs, minHeatingReadings, minCoolingReadings, maxScatterF } = this.options;
        const sources = sourcesOf(window.heater, window.pump);
        const cooling = sources === 'cooling';
        const water = this.series[SERIES[window.body]];
        const points = pointsIn(water, window.start, window.end);
        const result = {
            id: `${window.body}:${window.start}`,
            body: window.body,
            sources,
            start: new Date(window.start),
            end: new Date(window.end),
            hours: (window.end - window.start) / HOUR_MS,
            readings: points.length,
            startTemperature: points.length ? points[0].v : null,
            endTemperature: points.length ? points[points.length - 1].v : null,
            waterTemperature: null,
            airTemperature: null,
            sun: null,
            slope: null,
            scatter: null,
            suitable: false,
            reason: null
        };
        const reject = (reason) => Object.assign(result, { reason });

        if (window.settling) {
            return reject('settling');
        }
        if (window.end - window.start < (cooling ? minCoolingMs : minHeatingMs)) {
            return reject(window.pump && !window.heater ? 'reached its setpoint or too short' : 'too short');
        }
        const waterMean = meanOver(water, window.start, window.end);
        const air = meanOver(this.series[AIR], window.start, window.end);
        if (typeof waterMean !== 'number') {
            return reject('no water temperature');
        }
        if (typeof air !== 'number') {
            return reject('no air temperature');
        }
        result.waterTemperature = waterMean;
        result.airTemperature = air;
        result.sun = sun.averageOver(this.options.sun || (() => 0), window.start, window.end);
        if (points.length < (cooling ? minCoolingReadings : minHeatingReadings)) {
            return reject('too few readings');
        }
        // the reading carried in from before and out to the end, so a flat stretch counts as flat
        const atStart = valueAt(water, window.start);
        const atEnd = valueAt(water, window.end);
        const line = lineFit([].concat(
            typeof atStart === 'number' ? [{ t: window.start, v: atStart }] : [],
            points,
            typeof atEnd === 'number' ? [{ t: window.end, v: atEnd }] : []
        ), window.start);
        if (!line) {
            return reject('too few readings');
        }
        result.slope = line.slope;
        result.scatter = line.scatter;
        if (line.scatter > maxScatterF) {
            return reject('readings jump around');
        }
        result.suitable = true;
        return result;
    }
}

module.exports = { WindowExtractor, SOURCES, DEFAULTS, valueAt, meanOver, lineFit, SWITCHES, SERIES, AIR };
