// The temperature history: which windows are fetched, and how lines and heating bands are drawn.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TemperatureHistory, valueAt, extended } from '../public/js/history.js';

const series = (name, points, before = null) => ({ name, before, points: points.map(([t, v]) => ({ t, v })) });

/** a client that answers every history request with the given series, recording each window */
const fakeClient = (seriesList) => {
    const requests = [];
    return {
        requests,
        fetchHistory: async (names, from, to) => {
            requests.push([from, to]);
            return { from, to, earliest: 0, series: seriesList };
        }
    };
};

describe('temperature history loading', () => {
    it('fetches only the parts of a window it has not seen', async () => {
        const client = fakeClient([]);
        const history = new TemperatureHistory('pool', client);
        await history.ensureLoaded(1000, 5000);
        await history.ensureLoaded(3000, 9000);
        await history.ensureLoaded(2000, 4000);
        assert.deepEqual(client.requests, [[1000, 5000], [5000, 9000]]);
        assert.equal(history.loadedThrough, 9000);
    });

    it('fills a hole between two fetched windows', async () => {
        const client = fakeClient([]);
        const history = new TemperatureHistory('pool', client);
        await history.ensureLoaded(0, 2000);
        await history.ensureLoaded(6000, 8000);
        await history.ensureLoaded(0, 8000);
        assert.deepEqual(client.requests.at(-1), [2000, 6000]);
    });

    it('asks for the water, air, heaters and every switch that decides where heat goes', async () => {
        const names = [];
        const history = new TemperatureHistory('spa', { fetchHistory: async (n) => { names.push(...n); return { earliest: null, series: [] }; } });
        await history.ensureLoaded(0, 5000);
        assert.deepEqual(names.sort(), ['ambient', 'aux14', 'filter', 'heater1', 'spa', 'spa temp', 'spillover', 'valve4']);
    });

    it('keeps the error and stops, so a later request can try again', async () => {
        const history = new TemperatureHistory('pool', { fetchHistory: async () => { throw new Error('The pool server isn’t answering.'); } });
        await history.ensureLoaded(0, 5000);
        assert.equal(history.errorMessage, 'The pool server isn’t answering.');
        assert.equal(history.loadedThrough, null);
        assert.equal(history.isLoading, false);
    });
});

describe('temperature history lines', () => {
    it('breaks the water line while the pump is off, starting each run at its first reading', async () => {
        const history = new TemperatureHistory('pool', fakeClient([
            series('pool temp', [[100, 80], [200, 81], [500, 78], [600, 79]]),
            series('filter', [[150, 1], [300, 0], [550, 1]])
        ]));
        await history.ensureLoaded(0, 1000);
        assert.deepEqual(history.waterSegments(1000), [
            [{ t: 200, v: 81 }, { t: 300, v: 81 }],
            [{ t: 600, v: 79 }, { t: 1000, v: 79 }]
        ]);
    });

    it('draws one line when the pump history is unknown', async () => {
        const history = new TemperatureHistory('pool', fakeClient([series('pool temp', [[100, 80]])]));
        await history.ensureLoaded(0, 1000);
        assert.deepEqual(history.waterSegments(400), [[{ t: 100, v: 80 }, { t: 400, v: 80 }]]);
    });

    it('shades heating only while the heat goes to this body of water', async () => {
        const client = fakeClient([
            series('heater1', [[100, 1], [900, 0]]),
            series('aux14', [[300, 1], [500, 0]])
        ]);
        const pool = new TemperatureHistory('pool', client);
        await pool.ensureLoaded(0, 1000);
        assert.deepEqual(pool.heatingIntervals('heater1', 1000), [{ start: 100, end: 300 }, { start: 500, end: 900 }]);

        const spa = new TemperatureHistory('spa', client);
        await spa.ensureLoaded(0, 1000);
        assert.deepEqual(spa.heatingIntervals('heater1', 1000), [{ start: 300, end: 500 }]);
    });

    it('heats both bodies in spillover', async () => {
        const client = fakeClient([series('valve4', [[0, 1]]), series('spillover', [[100, 1], [200, 0]]), series('spa', [[100, 1], [200, 0]])]);
        const spa = new TemperatureHistory('spa', client);
        await spa.ensureLoaded(0, 1000);
        assert.deepEqual(spa.heatingIntervals('valve4', 1000), [{ start: 100, end: 200 }]);
    });

    it('carries the value in effect as the window opens', async () => {
        const history = new TemperatureHistory('pool', fakeClient([series('ambient', [[500, 60]], { t: 10, v: 55 })]));
        await history.ensureLoaded(100, 2000);
        assert.deepEqual(history.airLine(1000), [{ t: 10, v: 55 }, { t: 500, v: 60 }, { t: 1000, v: 60 }]);
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
});
