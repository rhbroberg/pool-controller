// Temperature, air and heating history for one body of water. Each graph resolution keeps its
// own fetched windows, so zooming in asks only for the finer readings it doesn't have yet, and
// zooming back out finds the coarser ones still there. Times are milliseconds.

import { isAbort } from './api.js';

export const AIR = 'ambient';
export const HEATER = 'heater1';
export const HEAT_PUMP = 'valve4';
const MINIMUM_GAP_MS = 1000;
// how many resolutions to keep fetched readings for
const KEPT_LEVELS = 4;

const TEMPERATURE_NAMES = { pool: 'pool temp', spa: 'spa temp' };
// the pump just upstream of each body's temperature sensor
const PUMP_NAMES = { pool: 'filter', spa: 'aux14' };

/** the server's bucket lengths, in seconds */
export const RESOLUTIONS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 1209600, 2592000];
/** the most points the server sends for one series */
export const MAX_POINTS = 5000;

/** about one point per pixel across a graph showing lengthMs */
export const levelFor = (lengthMs, pixels) => {
    const wanted = lengthMs / 1000 / Math.max(pixels, 50);
    return RESOLUTIONS.find((seconds) => seconds >= wanted) || RESOLUTIONS[RESOLUTIONS.length - 1];
};

/** the points a window spanMs long needs at level, within the server's limit */
export const pointsFor = (spanMs, level) => Math.min(MAX_POINTS, Math.max(10, Math.ceil(spanMs / 1000 / level) + 2));

/** 1 while source (heater1 or valve4) was warming water; the server works it out from the switches */
export const heatingName = (water, source) => `heating:${water}:${source}`;

/** a point from the server as a sample: a reading holds until the next; a bucket for its span */
const sampleOf = (point, resolution) => ({ t: point.t, v: point.v, low: point.low ?? null, high: point.high ?? null, span: resolution * 1000 });

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
        this.levels = new Map();
        // orders the resolutions by when they were last asked for
        this.uses = 0;
        this.queue = Promise.resolve();
    }

    get temperatureName() {
        return TEMPERATURE_NAMES[this.water];
    }

    get pumpName() {
        return PUMP_NAMES[this.water];
    }

    get names() {
        return [this.temperatureName, AIR, this.pumpName, heatingName(this.water, HEATER), heatingName(this.water, HEAT_PUMP)];
    }

    level(level) {
        if (!this.levels.has(level)) {
            this.levels.set(level, { values: new Map(), sorted: new Map(), loaded: [], resolution: 0, used: 0 });
        }
        return this.levels.get(level);
    }

    samples(name, level) {
        const store = this.levels.get(level);
        return (store && store.sorted.get(name)) || [];
    }

    /** the latest time level has readings for */
    loadedThrough(level) {
        const store = this.levels.get(level);
        return store && store.loaded.length ? store.loaded[store.loaded.length - 1][1] : null;
    }

    // MARK: loading

    /**
     * fetches whatever part of [from, to] hasn't been fetched at level yet, after any fetch
     * already under way
     **/
    ensureLoaded(from, to, level) {
        this.queue = this.queue.then(() => this.load(from, to, level));
        return this.queue;
    }

    async load(from, to, level) {
        this.level(level).used = ++this.uses;
        const gaps = this.missing(from, to, level);
        if (!gaps.length) {
            return;
        }
        this.isLoading = true;
        this.changed();
        try {
            for (const [start, end] of gaps) {
                const response = await this.client.fetchHistory(this.names, start, end, { maxPoints: pointsFor(end - start, level), resolution: level });
                this.merge(response, level);
                this.record(start, end, level);
                this.errorMessage = null;
            }
            this.evict(level);
        } catch (error) {
            if (!isAbort(error)) {
                this.errorMessage = error.message;
            }
        } finally {
            this.isLoading = false;
            this.changed();
        }
    }

    missing(from, to, level) {
        const gaps = [];
        let cursor = from;
        for (const [start, end] of this.level(level).loaded) {
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

    record(from, to, level) {
        const store = this.level(level);
        const merged = [];
        for (const next of [...store.loaded, [from, to]].sort((a, b) => a[0] - b[0])) {
            const last = merged[merged.length - 1];
            if (last && next[0] <= last[1]) {
                last[1] = Math.max(last[1], next[1]);
            } else {
                merged.push([...next]);
            }
        }
        store.loaded = merged;
    }

    merge(response, level) {
        if (response.earliest !== null && response.earliest !== undefined) {
            this.earliest = this.earliest === null ? response.earliest : Math.min(this.earliest, response.earliest);
        }
        const store = this.level(level);
        for (const series of response.series) {
            const resolution = series.resolution || 0;
            const known = store.values.get(series.name) || new Map();
            for (const point of series.points) {
                if (point && point.v !== null && point.v !== undefined) {
                    known.set(point.t, sampleOf(point, resolution));
                }
            }
            // a bucket already counts the value carried into it
            if (resolution === 0 && series.before && series.before.v !== null && !known.has(series.before.t)) {
                known.set(series.before.t, sampleOf(series.before, 0));
            }
            store.values.set(series.name, known);
            store.sorted.set(series.name, [...known.values()].sort((a, b) => a.t - b.t));
            store.resolution = Math.max(store.resolution, resolution);
        }
    }

    evict(current) {
        [...this.levels.entries()]
            .filter(([level]) => level !== current)
            .sort((a, b) => b[1].used - a[1].used)
            .slice(KEPT_LEVELS - 1)
            .forEach(([level]) => this.levels.delete(level));
    }

    // MARK: chart data

    /**
     * the level to draw from..to from: level once it covers the window, otherwise the most
     * recently used one that does, so zooming in shows the coarser lines until finer arrive
     **/
    displayLevel(level, from, to, now = Date.now()) {
        const covers = (store) => store.loaded.some(([start, end]) => start <= from && end >= Math.min(to, now));
        const wanted = this.levels.get(level);
        if (wanted && covers(wanted)) {
            return level;
        }
        const others = [...this.levels.entries()].filter(([, store]) => covers(store)).sort((a, b) => b[1].used - a[1].used);
        return others.length ? others[0][0] : level;
    }

    /** the bucket length the lines at level are drawn from, or 0 for readings as recorded */
    resolution(level) {
        const store = this.levels.get(level);
        return store ? store.resolution : 0;
    }

    /**
     * times source (the heater or the heat pump) was warming this body of water, ending no later
     * than end; intensity is the share of each stretch it was on, 1 for exact readings
     **/
    heatingSpans(source, end, level) {
        return holds(this.samples(heatingName(this.water, source), level), end)
            .filter((stretch) => stretch.v > 0)
            .map((stretch) => ({ start: stretch.start, end: stretch.end, intensity: Math.min(stretch.v, 1) }));
    }

    /**
     * The water temperature line. Readings persist until they change, so each segment is carried
     * to its end. Each sensor sits just downstream of its pump, so the line only covers times that
     * pump ran, starting at that run's first reading, since an earlier one is stale.
     **/
    waterSegments(end, level) {
        const readings = this.samples(this.temperatureName, level).filter((sample) => sample.t <= end);
        if (!readings.length) {
            return [];
        }
        const pump = this.samples(this.pumpName, level);
        if (!pump.length) {
            return [extended(readings, end)];
        }
        return merged(holds(pump, end).filter((stretch) => stretch.v > 0))
            .map(({ start, end: stop }) => {
                const inside = readings.filter((sample) => sample.t >= start && sample.t <= stop);
                return inside.length ? extended(inside, stop) : null;
            })
            .filter(Boolean);
    }

    airLine(end, level) {
        const readings = this.samples(AIR, level).filter((sample) => sample.t <= end);
        return readings.length ? extended(readings, end) : [];
    }
}

/** how long each sample's value held: a reading until the next one, a bucket for its span */
export const holds = (samples, end) => {
    const result = [];
    samples.forEach((sample, index) => {
        if (sample.t >= end) {
            return;
        }
        let stop = index + 1 < samples.length ? samples[index + 1].t : end;
        if (sample.span > 0) {
            stop = Math.min(stop, sample.t + sample.span);
        }
        stop = Math.min(stop, end);
        if (stop > sample.t) {
            result.push({ start: sample.t, end: stop, v: sample.v });
        }
    });
    return result;
};

/** back-to-back stretches joined into one */
const merged = (stretches) => {
    const result = [];
    for (const stretch of stretches) {
        const last = result[result.length - 1];
        if (last && stretch.start <= last.end) {
            last.end = Math.max(last.end, stretch.end);
        } else {
            result.push({ start: stretch.start, end: stretch.end });
        }
    }
    return result;
};

/** readings persist until they change, so the last one holds until end */
export const extended = (readings, end) => {
    const last = readings[readings.length - 1];
    return last && last.t < end ? [...readings, { ...last, t: end }] : readings;
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
