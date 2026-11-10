// The Reprocess History page: what it lets you start, what it sends, and how it follows a run.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ReprocessForm, inputValue, fromInput, isActive, transitionTitle, runStateText, runRows, runFooter, POLL_MS } from '../public/js/reprocess.js';

const NOW = new Date(2026, 10, 9, 19, 30);
const run = (changes = {}) => ({
    state: 'finished', dryRun: true, from: new Date(2020, 6, 19), to: new Date(2020, 6, 21), through: null, error: null,
    examined: 1458, updated: 7, removed: 1451, unchanged: 0,
    transitions: [{ from: 'failed', to: 'removed', count: 1451 }, { from: 'failed', to: 'info', count: 7 }],
    ...changes
});

/** a store whose runs the test hands out in turn; requests are recorded */
const fakeStore = (runs = []) => {
    const store = {
        requests: [],
        looks: 0,
        reprocessRun: async () => {
            store.looks += 1;
            return runs.length > 1 ? runs.shift() : runs[0] ?? null;
        },
        startReprocess: async (request) => {
            store.requests.push(request);
            return runs.length > 1 ? runs.shift() : runs[0];
        }
    };
    return store;
};

const newForm = (store, waits = []) => new ReprocessForm(store, { now: NOW, sleep: async (ms) => { waits.push(ms); } });

describe('reprocess form', () => {
    it('starts on the last 30 days and the frames the server couldn’t read', () => {
        const form = newForm(fakeStore());
        assert.equal(form.from, '2026-10-10T19:30');
        assert.equal(form.to, '2026-11-09T19:30');
        assert.deepEqual(form.eventTypes, ['failed', 'unrecognized']);
        assert.equal(form.canStart(true), true);
    });

    it('sends the kinds chosen as the server’s event types', () => {
        const form = newForm(fakeStore());
        form.toggle('readings');
        form.toggle('equipment');
        assert.deepEqual(form.eventTypes, ['status', 'info', 'failed', 'unrecognized']);
        form.toggle('protocolErrors');
        assert.deepEqual(form.eventTypes, ['status', 'info']);
    });

    it('says why it can’t start', () => {
        const form = newForm(fakeStore());
        assert.equal(form.canStart(false), false, 'only for admins');
        form.to = form.from;
        assert.equal(form.problem, 'The start has to be before the end.');
        form.to = '';
        assert.equal(form.problem, 'Choose when to start and stop.');
        form.to = '2026-11-09T19:30';
        form.toggle('protocolErrors');
        assert.equal(form.problem, 'Choose at least one kind of event.');
        assert.equal(form.canStart(true), false);
    });

    it('sends the range and kinds, and follows the run until it’s done', async () => {
        const store = fakeStore([run({ state: 'waiting' }), run({ state: 'running', through: new Date(2020, 6, 20) }), run()]);
        const waits = [];
        const form = newForm(store, waits);
        form.from = '2020-07-19T00:00';
        form.to = '2020-07-21T00:00';
        await form.start(true);
        assert.deepEqual(store.requests, [{ from: new Date(2020, 6, 19), to: new Date(2020, 6, 21), eventTypes: ['failed', 'unrecognized'], dryRun: true }]);
        assert.equal(form.run.state, 'finished');
        assert.equal(store.looks, 2, 'looked until it finished');
        assert.deepEqual(waits, [POLL_MS, POLL_MS]);
        assert.equal(form.canStart(true), true);
    });

    it('can’t start again while a run goes on, and stops following when the page goes away', async () => {
        const store = fakeStore([run({ state: 'running' })]);
        const form = new ReprocessForm(store, { now: NOW, sleep: async () => { form.stop(); } });
        await form.load();
        assert.equal(form.canStart(true), false);
        assert.equal(store.looks, 1, 'no more looks once stopped');
    });

    it('shows what went wrong', async () => {
        const form = newForm({ reprocessRun: async () => null, startReprocess: async () => { throw new Error('History is already being reprocessed'); } });
        await form.start(false);
        assert.equal(form.error, 'History is already being reprocessed');
        assert.equal(form.starting, false);
        await form.load();
        assert.equal(form.run, null, 'nothing has run');
        assert.equal(form.error, null);
    });
});

describe('describing a run', () => {
    const time = (date) => date.toISOString().slice(0, 10);

    it('says where it is', () => {
        assert.equal(runStateText(run({ state: 'waiting' }), time), 'Preview waits for a maintenance job to finish');
        assert.equal(runStateText(run({ state: 'running', dryRun: false }), time), 'Reprocessing has started');
        assert.equal(runStateText(run({ state: 'running', through: new Date(Date.UTC(2020, 6, 20)) }), time), 'Preview is through 2020-07-20');
        assert.equal(runStateText(run({ state: 'failed', error: 'no database' }), time), 'Preview stopped: no database');
        assert.equal(runStateText(run({ dryRun: false }), time), 'Reprocessed');
        assert.equal(isActive(run({ state: 'waiting' })), true);
        assert.equal(isActive(run()), false);
        assert.equal(isActive(null), false);
    });

    it('labels a preview’s counts as what would change', () => {
        assert.deepEqual(runRows(run()), [
            ['Events read again', 1458], ['Would be rewritten', 7], ['Would be removed', 1451], ['Unchanged', 0],
            ['Failed frames → Removed', 1451], ['Failed frames → Readings', 7]
        ]);
        assert.deepEqual(runRows(run({ dryRun: false })).slice(1, 3), [['Rewritten', 7], ['Removed', 1451]]);
        assert.equal(transitionTitle({ from: 'status', to: 'mystery' }), 'Equipment → mystery');
    });

    it('says what comes next once it’s done', () => {
        assert.equal(runFooter(run()), 'Nothing has changed yet. Reprocess makes these changes.');
        assert.match(runFooter(run({ dryRun: false })), /summaries are being redone/);
        assert.equal(runFooter(run({ dryRun: false, updated: 0, removed: 0 })), null);
        assert.equal(runFooter(run({ state: 'running' })), null);
    });

    it('reads and writes times the way the date fields show them', () => {
        assert.equal(inputValue(new Date(2020, 6, 9, 5, 7)), '2020-07-09T05:07');
        assert.equal(fromInput('2020-07-09T05:07').getTime(), new Date(2020, 6, 9, 5, 7).getTime());
        assert.equal(fromInput(''), null);
        assert.equal(fromInput('not a time'), null);
    });
});
