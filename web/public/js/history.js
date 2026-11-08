// Temperature, air and heater history for one body of water, fetched a time window at a time and
// kept, so only windows that haven't been seen are requested. Times are milliseconds.

import { isAbort } from './api.js';

export const AIR = 'ambient';
export const HEATER = 'heater1';
export const HEAT_PUMP = 'valve4';
const SPA_FILTER = 'aux14';
const POOL_PUMP = 'filter';
const SPA_MODE = 'spa';
const SPILLOVER = 'spillover';
// the switches that decide where water, and so heat, goes
const CIRCULATION = [SPA_FILTER, SPA_MODE, SPILLOVER];
const MINIMUM_GAP_MS = 1000;

const TEMPERATURE_NAMES = { pool: 'pool temp', spa: 'spa temp' };

export class TemperatureHistory {
    /**
     * water is pool or spa; changed is called whenever there's something new to draw
     **/
    constructor(water, client, changed = () => {}) {
        this.water = water;
        this.client = client;
        this.changed = changed;
        this.earliest = null;
        this.isLoading = false;
        this.errorMessage = null;
        // the latest time covered by fetched data
        this.loadedThrough = null;
        this.values = new Map();
        this.sorted = new Map();
        this.loaded = [];
        this.queue = Promise.resolve();
    }

    get temperatureName() {
        return TEMPERATURE_NAMES[this.water];
    }

    get names() {
        return [this.temperatureName, AIR, HEATER, HEAT_PUMP, POOL_PUMP, ...CIRCULATION];
    }

    /** the pump just upstream of this body's temperature sensor */
    get pumpName() {
        return this.water === 'pool' ? POOL_PUMP : SPA_FILTER;
    }

    samples(name) {
        return this.sorted.get(name) || [];
    }

    // MARK: loading

    /**
     * fetches whatever part of [from, to] hasn't been fetched yet, after any fetch already under way
     **/
    ensureLoaded(from, to) {
        this.queue = this.queue.then(() => this.load(from, to));
        return this.queue;
    }

    async load(from, to) {
        const gaps = this.missing(from, to);
        if (!gaps.length) {
            return;
        }
        this.isLoading = true;
        this.changed();
        try {
            for (const [start, end] of gaps) {
                const response = await this.client.fetchHistory(this.names, start, end);
                this.merge(response);
                this.record(start, end);
                this.errorMessage = null;
            }
        } catch (error) {
            if (!isAbort(error)) {
                this.errorMessage = error.message;
            }
        } finally {
            this.isLoading = false;
            this.changed();
        }
    }

    missing(from, to) {
        const gaps = [];
        let cursor = from;
        for (const [start, end] of this.loaded) {
            if (end <= cursor || start >= to) {
                continue;
            }
            if (start > cursor) {
                gaps.push([cursor, start]);
            }
            cursor = Math.max(cursor, end);
        }
        if (cursor < to) {
            gaps.push([cursor, to]);
        }
        return gaps.filter(([start, end]) => end - start >= MINIMUM_GAP_MS);
    }

    record(from, to) {
        const merged = [];
        for (const next of [...this.loaded, [from, to]].sort((a, b) => a[0] - b[0])) {
            const last = merged[merged.length - 1];
            if (last && next[0] <= last[1]) {
                last[1] = Math.max(last[1], next[1]);
            } else {
                merged.push([...next]);
            }
        }
        this.loaded = merged;
        this.loadedThrough = merged.length ? merged[merged.length - 1][1] : null;
    }

    merge(response) {
        if (response.earliest !== null && response.earliest !== undefined) {
            this.earliest = this.earliest === null ? response.earliest : Math.min(this.earliest, response.earliest);
        }
        for (const series of response.series) {
            const known = this.values.get(series.name) || new Map();
            for (const point of [...series.points, ...(series.before ? [series.before] : [])]) {
                if (point && point.v !== null && point.v !== undefined) {
                    known.set(point.t, point.v);
                }
            }
            this.values.set(series.name, known);
            this.sorted.set(series.name, [...known].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t));
        }
    }

    // MARK: chart data

    /**
     * times source (the heater or the heat pump) was warming this body of water, ending no later
     * than end; the two are in series, so both send their heat to the same place
     **/
    heatingIntervals(source, end) {
        return this.intervals([source, ...CIRCULATION], end, (state) => state[source] === true && this.heats(state));
    }

    /**
     * The water temperature line. Readings persist until they change, so each segment is carried
     * to its end. Each sensor sits just downstream of its pump, so the line only covers times that
     * pump ran, starting at that run's first reading, since an earlier one is stale.
     **/
    waterSegments(end) {
        const readings = this.samples(this.temperatureName).filter((sample) => sample.t <= end);
        if (!readings.length) {
            return [];
        }
        if (!this.samples(this.pumpName).length) {
            return [extended(readings, end)];
        }
        return this.intervals([this.pumpName], end, (state) => state[this.pumpName] === true)
            .map(({ start, end: stop }) => {
                const inside = readings.filter((sample) => sample.t >= start && sample.t <= stop);
                return inside.length ? extended(inside, stop) : null;
            })
            .filter(Boolean);
    }

    airLine(end) {
        const readings = this.samples(AIR).filter((sample) => sample.t <= end);
        return readings.length ? extended(readings, end) : [];
    }

    /**
     * heat reaches both bodies in spillover; otherwise the spa while water flows through it (spa
     * mode or the spa filter), and the pool the rest of the time
     **/
    heats(state) {
        if (state[SPILLOVER] === true) {
            return true;
        }
        const toSpa = state[SPA_MODE] === true || state[SPA_FILTER] === true;
        return this.water === 'spa' ? toSpa : !toSpa;
    }

    /** the stretches of time condition held, replaying every change to the switches in names */
    intervals(names, end, condition) {
        const changes = names
            .flatMap((name) => this.samples(name).map((sample) => ({ t: sample.t, name, on: sample.v !== 0 })))
            .filter((change) => change.t <= end)
            .sort((a, b) => a.t - b.t);
        const state = {};
        const result = [];
        let since = null;
        for (const change of changes) {
            state[change.name] = change.on;
            const holds = condition(state);
            if (holds && since === null) {
                since = change.t;
            } else if (!holds && since !== null) {
                result.push({ start: since, end: change.t });
                since = null;
            }
        }
        if (since !== null) {
            result.push({ start: since, end });
        }
        return result;
    }
}

/** readings persist until they change, so the last one holds until end */
export const extended = (readings, end) => {
    const last = readings[readings.length - 1];
    return last && last.t < end ? [...readings, { t: end, v: last.v }] : readings;
};

/** the value in effect at t on a stepped line, or null outside it */
export const valueAt = (line, t) => {
    if (!line.length || t < line[0].t || t > line[line.length - 1].t) {
        return null;
    }
    let value = null;
    for (const sample of line) {
        if (sample.t > t) {
            break;
        }
        value = sample.v;
    }
    return value;
};
