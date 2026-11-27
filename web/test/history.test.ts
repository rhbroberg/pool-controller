// The temperature history: which windows are fetched at which resolution, and how lines,
// buckets and heating bands are drawn.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TemperatureHistory, valueAt, extended, holds, levelFor, pointsFor, heatingName, MAX_POINTS, coloredWaterLines, heatingAt } from '../public/js/history.js';

const LEVEL = 300;

const series = (name: any, points: any, { before = null, resolution = 0 } = {}) => ({
    name,
    resolution,
    before,
    points: points.map(([t, v, low = null, high = null]: any[]) => ({ t, v, low, high }))
});

/** a client that answers every history request with the given series, recording each request */
const fakeClient = (seriesList: any) => {
    const requests: any[] = [];
    return {
        requests,
        fetchHistory: async (names: any, from: any, to: any, options: any) => {
            requests.push({ names, from, to, ...options });
            return { from, to, earliest: 0, series: typeof seriesList === 'function' ? seriesList({ names, from, to, ...options }) : seriesList };
        }
    };
};

describe('temperature history loading', () => {
    it('fetches only the parts of a window it has not seen at that resolution', async () => {
        const client = fakeClient([]);
        const history = new TemperatureHistory('pool', client);
        await history.ensureLoaded(1000, 5000, LEVEL);
        await history.ensureLoaded(3000, 9000, LEVEL);
        await history.ensureLoaded(2000, 4000, LEVEL);
        assert.deepEqual(client.requests.map((r) => [r.from, r.to]), [[1000, 5000], [5000, 9000]]);
        assert.equal(history.loadedThrough(LEVEL), 9000);
    });

    it('fills a hole between two fetched windows', async () => {
        const client = fakeClient([]);
        const history = new TemperatureHistory('pool', client);
        await history.ensureLoaded(0, 2000, LEVEL);
        await history.ensureLoaded(6000, 8000, LEVEL);
        await history.ensureLoaded(0, 8000, LEVEL);
        assert.deepEqual([client.requests.at(-1).from, client.requests.at(-1).to], [2000, 6000]);
    });

    it('asks for the resolution, the points it needs, the pump and the derived heating series', async () => {
        const client = fakeClient([]);
        const history = new TemperatureHistory('spa', client);
        await history.ensureLoaded(0, 6 * 3600 * 1000, LEVEL);
        const [request] = client.requests;
        assert.equal(request.resolution, LEVEL);
        assert.equal(request.maxPoints, pointsFor(6 * 3600 * 1000, LEVEL));
        assert.deepEqual([...request.names].sort(), ['ambient', 'aux14', 'heating:spa:heater1', 'heating:spa:valve4', 'spa temp']);
    });

    it('keeps each resolution apart, so another resolution fetches again', async () => {
        const client = fakeClient([]);
        const history = new TemperatureHistory('pool', client);
        await history.ensureLoaded(0, 5000, LEVEL);
        await history.ensureLoaded(0, 5000, 3600);
        assert.equal(client.requests.length, 2);
        assert.equal(history.loadedThrough(3600), 5000);
    });

    it('forgets the least recently used resolutions', async () => {
        const client = fakeClient([]);
        const history = new TemperatureHistory('pool', client);
        for (const level of [60, 300, 900, 3600, 86400]) {
            await history.ensureLoaded(0, 5000, level);
        }
        await history.ensureLoaded(0, 5000, 60);
        assert.equal(client.requests.length, 6, 'the oldest resolution was let go');
    });

    it('asks again for a closer look at a summary, and replaces it with the readings', async () => {
        const hour = 3600 * 1000;
        const client = fakeClient(({from, to}: any) => (to - from <= 30 * hour
            ? [series('pool temp', [[10 * hour, 80], [12 * hour, 82]])]
            : [series('pool temp', [[0, 70, 68, 72], [4.5 * hour, 75, 74, 76], [10 * hour, 79, 78, 80]], { resolution: 3600 })]));
        const history = new TemperatureHistory('pool', client);
        await history.ensureLoaded(0, 100 * hour, 3600);
        await history.ensureLoaded(5 * hour, 25 * hour, 3600);
        await history.ensureLoaded(5 * hour, 25 * hour, 3600);
        assert.equal(client.requests.length, 2, 'the closer window is fetched once');
        const samples = history.samples('pool temp', 3600);
        assert.equal(samples.some((sample: any) => sample.t === 4.5 * hour), false, 'the bucket that ran into the closer window is gone');
        assert.deepEqual(samples.filter((sample: any) => sample.t >= 5 * hour && sample.t < 25 * hour).map((sample: any) => [sample.t, sample.v, sample.span]), [
            [10 * hour, 80, 0],
            [12 * hour, 82, 0]
        ]);
        assert.equal(samples.some((sample: any) => sample.t === 0), true, 'a bucket outside the closer window stays for zooming back out');
    });

    it('does not ask again when a closer look is still a summary', async () => {
        const hour = 3600 * 1000;
        const client = fakeClient([series('pool temp', [[0, 70, 68, 72]], { resolution: 3600 })]);
        const history = new TemperatureHistory('pool', client);
        await history.ensureLoaded(0, 100 * hour, 3600);
        await history.ensureLoaded(5 * hour, 25 * hour, 3600);
        await history.ensureLoaded(5 * hour, 25 * hour, 3600);
        assert.equal(client.requests.length, 2);
    });

    it('draws the coarser resolution it has until the finer one covers the window', async () => {
        const client = fakeClient([]);
        const history = new TemperatureHistory('pool', client);
        await history.ensureLoaded(0, 10000, 3600);
        assert.equal(history.displayLevel(LEVEL, 1000, 9000, 20000), 3600);
        await history.ensureLoaded(0, 10000, LEVEL);
        assert.equal(history.displayLevel(LEVEL, 1000, 9000, 20000), LEVEL);
    });

    it('keeps the error and stops, so a later request can try again', async () => {
        const history = new TemperatureHistory('pool', { fetchHistory: async () => { throw new Error('The pool server isn’t answering.'); } });
        await history.ensureLoaded(0, 5000, LEVEL);
        assert.equal(history.errorMessage, 'The pool server isn’t answering.');
        assert.equal(history.loadedThrough(LEVEL), null);
        assert.equal(history.isLoading, false);
    });
});

describe('temperature history lines', () => {
    it('breaks the water line while the pump is off, starting each run at its first reading', async () => {
        const history = new TemperatureHistory('pool', fakeClient([
            series('pool temp', [[100, 80], [200, 81], [500, 78], [600, 79]]),
            series('filter', [[150, 1], [300, 0], [550, 1]])
        ]));
        await history.ensureLoaded(0, 1000, LEVEL);
        assert.deepEqual(history.waterSegments(1000, LEVEL).map((segment) => segment.map((s: any) => [s.t, s.v])), [
            [[200, 81], [300, 81]],
            [[600, 79], [1000, 79]]
        ]);
    });

    it('draws one line when the pump history is unknown', async () => {
        const history = new TemperatureHistory('pool', fakeClient([series('pool temp', [[100, 80]])]));
        await history.ensureLoaded(0, 1000, LEVEL);
        assert.deepEqual(history.waterSegments(400, LEVEL).map((segment) => segment.map((s: any) => [s.t, s.v])), [[[100, 80], [400, 80]]]);
    });

    it('shades heating from the server’s derived series, fully for readings as recorded', async () => {
        const history = new TemperatureHistory('pool', fakeClient([series(heatingName('pool', 'heater1'), [[100, 1], [300, 0], [500, 1], [900, 0]])]));
        await history.ensureLoaded(0, 1000, LEVEL);
        assert.deepEqual(history.heatingSpans('heater1', 1000, LEVEL), [
            { start: 100, end: 300, intensity: 1 },
            { start: 500, end: 900, intensity: 1 }
        ]);
    });

    it('colors the water line by heater and heat pump stretches, preferring the heater when both are on', () => {
        const segment = [{ t: 0, v: 80 }, { t: 100, v: 81 }, { t: 200, v: 82 }, { t: 300, v: 83 }, { t: 400, v: 83 }];
        const heater = [{ start: 100, end: 200, intensity: 1 }];
        const heatPump = [{ start: 150, end: 300, intensity: 1 }];
        assert.equal(heatingAt(120, heater, heatPump), 'heater');
        assert.equal(heatingAt(250, heater, heatPump), 'heatPump');
        assert.equal(heatingAt(50, heater, heatPump), null);
        const lines = coloredWaterLines([segment], heater, heatPump);
        // vertical jumps stay with the color that was holding, so entering heat doesn't paint a drop orange
        assert.deepEqual(lines.map((line) => [line.source, line.points.map((p) => [p.t, p.v])]), [
            ['water', [[0, 80], [100, 80], [100, 81]]],
            ['heater', [[100, 81], [150, 81], [200, 81], [200, 82]]],
            ['heatPump', [[200, 82], [300, 82], [300, 83]]],
            ['water', [[300, 83], [400, 83]]]
        ]);
    });


    it('shades a bucket by how much of it the heat was on, and keeps each bucket’s range', async () => {
        const hour = 3600 * 1000;
        const history = new TemperatureHistory('pool', fakeClient([
            series('pool temp', [[0, 79, 78, 80], [hour, 81, 80, 83]], { resolution: 3600 }),
            series('filter', [[0, 1], [hour, 0.5]], { resolution: 3600 }),
            series(heatingName('pool', 'heater1'), [[0, 0.25], [hour, 0]], { resolution: 3600 })
        ]));
        await history.ensureLoaded(0, 2 * hour, 3600);
        assert.equal(history.resolution(3600), 3600);
        assert.deepEqual(history.heatingSpans('heater1', 2 * hour, 3600), [{ start: 0, end: hour, intensity: 0.25 }]);
        const [segment] = history.waterSegments(2 * hour, 3600);
        assert.equal(segment[0].low, 78);
        assert.equal(segment[0].high, 80);
        assert.equal(segment.at(-1).t, 2 * hour, 'carried to the end of the last bucket the pump ran');
    });

    it('carries the value in effect as the window opens, for readings as recorded', async () => {
        const history = new TemperatureHistory('pool', fakeClient([series('ambient', [[500, 60]], { before: { t: 10, v: 55 } as any })]));
        await history.ensureLoaded(100, 2000, LEVEL);
        assert.deepEqual(history.airLine(1000, LEVEL).map((s: any) => [s.t, s.v]), [[10, 55], [500, 60], [1000, 60]]);
    });
});

describe('resolution', () => {
    it('picks about one point per pixel', () => {
        assert.equal(levelFor(24 * 3600 * 1000, 1179), 120);
        assert.equal(levelFor(365 * 24 * 3600 * 1000, 1179), 43200);
        assert.equal(levelFor(3600 * 1000, 1179), 60);
    });

    it('asks for as many points as the server sends, so a window can come back as its readings', () => {
        assert.equal(pointsFor(24 * 3600 * 1000, 120), MAX_POINTS);
        assert.equal(pointsFor(10 * 365 * 24 * 3600 * 1000, 60), MAX_POINTS);
    });
});

describe('reading a stepped line', () => {
    const line = [{ t: 0, v: 1 }, { t: 10, v: 2 }, { t: 20, v: 2 }];

    it('holds each value until the next', () => {
        assert.equal(valueAt(line, 5), 1);
        assert.equal(valueAt(line, 10), 2);
        assert.equal(valueAt(line, 21), null);
        assert.equal(valueAt([], 5), null);
    });

    it('extends the last reading to the end', () => {
        assert.deepEqual(extended([{ t: 0, v: 1 }], 5), [{ t: 0, v: 1 }, { t: 5, v: 1 }]);
        assert.deepEqual(extended([{ t: 5, v: 1 }], 5), [{ t: 5, v: 1 }]);
    });

    it('holds a bucket for its length, and a reading until the next', () => {
        assert.deepEqual(holds([{ t: 0, v: 1, span: 10 }, { t: 30, v: 2, span: 0 }], 50), [
            { start: 0, end: 10, v: 1 },
            { start: 30, end: 50, v: 2 }
        ]);
    });
});
