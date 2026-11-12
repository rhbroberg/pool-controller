'use strict';
// The tasks the apps offer in place of single switches: pool, spa preheat (now or ready by a
// time) and spa party, against the simulated controller.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, commission, account, reading, eventually } = require('./helpers/server');

const SLOW = { timeoutMs: 60000, intervalMs: 250 };

describe('tasks', () => {
    let server;
    let api;
    let admin;
    let viewer;

    const tasks = async () => (await api('GET', '/tasks')).body;
    const put = (task, body, token = admin) => api('PUT', `/tasks/${task}`, { token, body });
    const switchOn = async (name) => (await reading(api, name)) === true;
    // GET /status reads stored history, which can be a moment behind the tasks
    const expectSwitch = (name, on, why) => eventually(async () => (await switchOn(name)) === on,
        Object.assign({ message: why || `${name} ${on ? 'on' : 'off'}` }, SLOW));
    const settle = (check, message) => eventually(check, Object.assign({ message }, SLOW));

    before(async () => {
        server = await startServer({
            database: 'PoolRestTest-tasks',
            args: ['--no-jobs'],
            env: { POOL_TASK_TICK_MS: '500' }
        });
        api = server.api;
        admin = await commission(api);
        viewer = await account(api, admin, 'onlooker', 'viewer');
        // the heater key only works once the panel has shown the heater's mode
        await settle(async () => typeof (await reading(api, 'heater1 mode')) === 'number', 'the heater mode to show');
    });

    after(async () => {
        await server.stop();
    });

    it('says what each task is doing to anyone, and lets only those who may control change one', async () => {
        const body = await tasks();
        assert.equal(typeof body.pool.on, 'boolean');
        assert.equal(typeof body.spaPreheat.on, 'boolean');
        assert.equal(body.spaPreheat.scheduled, null);
        assert.equal(typeof body.spaParty.on, 'boolean');
        assert.equal(typeof body.dark, 'boolean');

        assert.equal((await put('pool', { on: true }, null)).status, 401);
        assert.equal((await put('pool', { on: true }, viewer)).status, 403);
        assert.equal((await put('spaPreheat', { on: true, readyAt: 'soon' })).status, 400);
    });

    it('runs the pool in spillover with the filter, and stops only the filter', async () => {
        const on = await put('pool', { on: true });
        assert.equal(on.status, 200, on.text);
        await settle(async () => (await tasks()).pool.on, 'the pool task to be on');
        await expectSwitch('filter', true);
        await expectSwitch('spillover', true);

        assert.equal((await put('pool', { on: false })).status, 200);
        await settle(async () => !(await tasks()).pool.on, 'the pool task to be off');
        await expectSwitch('filter', false);
        await expectSwitch('spillover', true, 'the water flow stays as it was');
    });

    it('preheats the spa with both heat sources, and stops only the spa filter', async () => {
        assert.equal((await put('spaPreheat', { on: true })).status, 200);
        await settle(async () => (await tasks()).spaPreheat.on, 'the spa preheat to be on');
        await expectSwitch('aux14', true);
        await expectSwitch('valve4', true);
        await eventually(async () => (await reading(api, 'heater1 mode')) === 1, Object.assign({ message: 'the heater in Auto' }, SLOW));

        assert.equal((await put('spaPreheat', { on: false })).status, 200);
        await settle(async () => !(await tasks()).spaPreheat.on, 'the spa preheat to be off');
        await expectSwitch('aux14', false);
        await expectSwitch('valve4', true, 'the heat pump stays enabled');
        await eventually(async () => (await reading(api, 'heater1 mode')) === 1, Object.assign({ message: 'the heater stays in Auto' }, SLOW));
    });

    it('throws a spa party with the blower, and the lights only after dark', async () => {
        const { dark } = await tasks();
        assert.equal((await put('spaParty', { on: true })).status, 200);
        await settle(async () => (await tasks()).spaParty.on, 'the spa party to be on');
        await expectSwitch('aux5', true);
        assert.equal((await tasks()).spaPreheat.on, true, 'a party is a preheat too');
        if (dark) {
            await settle(async () => switchOn('lights'), 'the lights to come on after dark');
        }

        assert.equal((await put('spaParty', { on: false })).status, 200);
        await settle(async () => !(await switchOn('aux14')) && !(await switchOn('aux5')) && !(await switchOn('lights')),
            'the spa filter, blower and lights to go off');
        assert.equal((await tasks()).spaParty.on, false);
    });

    it('schedules a preheat to be ready by a time, starting only as early as it must', async () => {
        assert.equal((await api('PUT', '/system/settings', { token: admin, body: { spaHeatingRate: 120, preheatMarginMinutes: 0 } })).status, 200);
        const far = new Date(Date.now() + 10 * 3600 * 1000);
        const scheduledFar = await put('spaPreheat', { on: true, readyAt: far.toISOString() });
        assert.equal(scheduledFar.status, 200, scheduledFar.text);
        const waiting = scheduledFar.body.spaPreheat;
        assert.equal(waiting.on, false, 'nothing starts yet');
        assert.equal(Date.parse(waiting.scheduled.readyAt), far.getTime());
        assert.equal(waiting.scheduled.leadFrom, 'rate', 'no spa model, so the heating rate times it');
        assert.equal(Date.parse(waiting.scheduled.startAt), far.getTime() - waiting.scheduled.leadMinutes * 60000);
        await expectSwitch('aux14', false);

        // off drops the schedule
        assert.equal((await put('spaPreheat', { on: false })).status, 200);
        assert.equal((await tasks()).spaPreheat.scheduled, null);

        // ready just after the lead time from now: it starts a moment later on its own
        const lead = waiting.scheduled.leadMinutes;
        const soon = new Date(Date.now() + lead * 60000 + 2000);
        const scheduledSoon = await put('spaPreheat', { on: true, readyAt: soon.toISOString() });
        assert.ok(scheduledSoon.body.spaPreheat.scheduled, JSON.stringify(scheduledSoon.body));
        await settle(async () => {
            const now = await tasks();
            return now.spaPreheat.scheduled === null && now.spaPreheat.on;
        }, 'the scheduled preheat to start');
        const log = await api('GET', '/events?types=action&limit=40', { token: admin });
        assert.ok(log.body.events.some((event) => /Started the spa preheat scheduled/.test(event.summary)), 'the start is in the event log');

        await put('spaPreheat', { on: false });
    });

    it('starts a preheat at once when the time asked for is too soon to make', async () => {
        const tooSoon = new Date(Date.now() + 1000);
        const body = (await put('spaPreheat', { on: true, readyAt: tooSoon.toISOString() })).body;
        assert.equal(body.spaPreheat.scheduled, null);
        await settle(async () => (await tasks()).spaPreheat.on, 'the preheat to start now');
        await put('spaPreheat', { on: false });
    });

    it('keeps the admin settings that time a preheat, within limits', async () => {
        const settings = (await api('GET', '/system/settings', { token: admin })).body;
        assert.equal(settings.spaHeatingRate, 120);
        assert.equal(settings.preheatMarginMinutes, 0);
        assert.equal((await api('PUT', '/system/settings', { token: admin, body: { spaHeatingRate: 0 } })).status, 400);
        assert.equal((await api('PUT', '/system/settings', { token: admin, body: { preheatMarginMinutes: 1.5 } })).status, 400);
    });
});
