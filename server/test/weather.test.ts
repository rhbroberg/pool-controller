'use strict';
// Weather: the zip code setting, the job that fetches the forecast for it, and today's forecast
// on GET /weather, against stand-ins for the zip code and forecast services.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startServer, commission, account, eventually } = require('./helpers/server');
const { startWeatherServices, TODAY } = require('./helpers/weather-services');
const { condition } = require('../utils/weatherCodes');

const NEW_YORK = 'America/New_York';
const LONDON = 'Europe/London';

describe('weather conditions', () => {
    it('sorts WMO codes into the kinds the pages show', () => {
        assert.equal(condition(0), 'sunny');
        assert.equal(condition(1), 'sunny');
        assert.equal(condition(2), 'partly-cloudy');
        assert.equal(condition(3), 'cloudy');
        assert.equal(condition(45), 'fog');
        assert.equal(condition(53), 'rain');
        assert.equal(condition(66), 'rain');
        assert.equal(condition(81), 'rain');
        assert.equal(condition(73), 'snow');
        assert.equal(condition(86), 'snow');
        assert.equal(condition(95), 'storm');
        assert.equal(condition(99), 'storm');
        assert.equal(condition(null), null);
        assert.equal(condition(42), null);
    });
});

describe('weather', () => {
    let services;
    let server;
    let api;
    let admin;
    let viewer;
    let connection;

    const runJob = async () => {
        const run = await api('POST', '/system/jobs/weather/run', { token: admin });
        assert.equal(run.status, 200, run.text);
        return run.body;
    };

    before(async () => {
        services = await startWeatherServices();
        server = await startServer({
            database: 'PoolRestTest-weather',
            driver: 'none',
            args: ['--no-jobs'],
            env: { TZ: NEW_YORK, ...services.env }
        });
        api = server.api;
        admin = await commission(api);
        viewer = await account(api, admin, 'watcher', 'viewer');
        connection = await mongoose.createConnection(server.uri).asPromise();
    });

    after(async () => {
        await connection.close();
        await server.stop();
        await services.stop();
    });

    it('has no location and no weather until a zip code is set', async () => {
        const settings = await api('GET', '/system/settings', { token: admin });
        assert.equal(settings.body.location, null);
        const weather = await api('GET', '/weather');
        assert.equal(weather.status, 200);
        assert.deepEqual(weather.body, { configured: false, location: null, today: null, fetchedAt: null, stale: false });
        const run = await runJob();
        assert.equal(run.lastResult, 'ok');
        assert.match(run.lastSummary, /no zip code/);
        assert.equal(services.forecastRequests.length, 0);
    });

    it('keeps the zip code to admins', async () => {
        assert.equal((await api('PUT', '/system/settings', { token: viewer, body: { zipCode: '32801' } })).status, 403);
    });

    it('rejects zip codes that aren’t five digits or belong to no place', async () => {
        assert.equal((await api('PUT', '/system/settings', { token: admin, body: { zipCode: 'abc' } })).status, 400);
        assert.equal((await api('PUT', '/system/settings', { token: admin, body: { zipCode: '1234' } })).status, 400);
        const unknown = await api('PUT', '/system/settings', { token: admin, body: { zipCode: '00000' } });
        assert.equal(unknown.status, 400);
        assert.match(unknown.body.message, /no place/);
        assert.equal((await api('GET', '/system/settings', { token: admin })).body.location, null);
    });

    it('says when the zip code service can’t be reached', async () => {
        services.down = true;
        try {
            const response = await api('PUT', '/system/settings', { token: admin, body: { zipCode: '32801' } });
            assert.equal(response.status, 502);
            assert.match(response.body.message, /couldn’t look up/);
        } finally {
            services.down = false;
        }
    });

    it('looks up a zip code and fetches its forecast straight away', async () => {
        const changed = await api('PUT', '/system/settings', { token: admin, body: { zipCode: '32801-1234' } });
        assert.equal(changed.status, 200, changed.text);
        assert.deepEqual(changed.body.location, { zipCode: '32801', countryCode: 'US', placeName: 'Orlando, FL', latitude: 28.5399, longitude: -81.3898 });

        const weather = await eventually(async () => {
            const response = await api('GET', '/weather');
            return response.body.today ? response.body : undefined;
        }, { message: 'the first forecast' });
        assert.equal(weather.configured, true);
        assert.deepEqual(weather.location, { zipCode: '32801', placeName: 'Orlando, FL' });
        assert.equal(weather.today.high, TODAY.high);
        assert.equal(weather.today.low, TODAY.low);
        assert.equal(weather.today.condition, 'sunny');
        assert.equal(weather.today.precipitationProbability, TODAY.rain);
        assert.equal(weather.stale, false);

        const request = services.forecastRequests.at(-1);
        assert.equal(request.latitude, '28.5399');
        assert.equal(request.timezone, NEW_YORK);
        assert.equal(request.temperature_unit, 'fahrenheit');
    });

    it('keeps every hour fetched, marking those still ahead as forecasts', async () => {
        const hours = connection.db.collection('weatherhours');
        const total = await hours.countDocuments({ zipCode: '32801' });
        assert.ok(total >= 5 * 24 - 1, `${total} hours`);
        const now = new Date();
        assert.equal(await hours.countDocuments({ time: { $lte: now }, forecast: true }), 0);
        assert.ok(await hours.countDocuments({ time: { $gt: now }, forecast: true }) > 0);
        const hour = await hours.findOne({ time: { $gt: now } });
        assert.equal(hour.solarRadiation, 500);
        assert.equal(hour.cloudCover, 20);
    });

    it('overwrites the same hours on the next fetch rather than adding more', async () => {
        const hours = connection.db.collection('weatherhours');
        const before = await hours.countDocuments({});
        const run = await runJob();
        assert.equal(run.lastResult, 'ok', run.lastError);
        assert.match(run.lastSummary, /fetched \d+ hours and \d+ days of weather for 32801/);
        assert.equal(await hours.countDocuments({}), before);
    });

    it('reports a failed fetch and keeps the forecast it has', async () => {
        services.down = true;
        try {
            const run = await runJob();
            assert.equal(run.lastResult, 'failed');
            assert.match(run.lastError, /forecast service answered 500/);
        } finally {
            services.down = false;
        }
        assert.equal((await api('GET', '/weather')).body.today.high, TODAY.high);
    });

    it('fetches again in a new time zone', async () => {
        const count = services.forecastRequests.length;
        assert.equal((await api('PUT', '/system/settings', { token: admin, body: { timeZone: LONDON } })).status, 200);
        await eventually(() => services.forecastRequests.length > count, { message: 'a fetch after the time zone change' });
        assert.equal(services.forecastRequests.at(-1).timezone, LONDON);
        assert.equal((await api('PUT', '/system/settings', { token: admin, body: { timeZone: null } })).status, 200);
    });

    it('stops showing weather when the zip code is cleared', async () => {
        const cleared = await api('PUT', '/system/settings', { token: admin, body: { zipCode: null } });
        assert.equal(cleared.status, 200);
        assert.equal(cleared.body.location, null);
        assert.equal((await api('GET', '/weather')).body.configured, false);
    });
});
