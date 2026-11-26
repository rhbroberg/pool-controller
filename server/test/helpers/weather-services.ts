'use strict';
// Stand-ins for Zippopotam.us and Open-Meteo, answering the way they do for the few places the
// tests use: today is sunny, 88° and 71°, and every other day rainy.
const http = require('node:http');
const tz = require('../../utils/timezone');

const PLACES = {
    32801: { 'place name': 'Orlando', 'state abbreviation': 'FL', state: 'Florida', latitude: '28.5399', longitude: '-81.3898' },
    80202: { 'place name': 'Denver', 'state abbreviation': 'CO', state: 'Colorado', latitude: '39.7491', longitude: '-104.9946' }
};
const HOUR_S = 3600;
const TODAY = { high: 88, low: 71, code: 0, rain: 10 };
const OTHER_DAY = { high: 75, low: 60, code: 61, rain: 80 };

var forecastFor = (timeZone) => {
    const now = Date.now();
    const today = tz.startOfDay(now, timeZone);
    const first = tz.addDays(today, -2, timeZone);
    const last = tz.addDays(today, 3, timeZone);
    const hourly = { time: [], temperature_2m: [], relative_humidity_2m: [], cloud_cover: [], shortwave_radiation: [], wind_speed_10m: [], precipitation: [], precipitation_probability: [], weather_code: [] };
    for (let t = first / 1000; t < last / 1000; t += HOUR_S) {
        hourly.time.push(t);
        hourly.temperature_2m.push(80);
        hourly.relative_humidity_2m.push(60);
        hourly.cloud_cover.push(20);
        hourly.shortwave_radiation.push(500);
        hourly.wind_speed_10m.push(5);
        hourly.precipitation.push(0);
        hourly.precipitation_probability.push(10);
        hourly.weather_code.push(1);
    }
    const daily = { time: [], temperature_2m_max: [], temperature_2m_min: [], weather_code: [], precipitation_probability_max: [], sunrise: [], sunset: [] };
    for (let day = first; day < last; day = tz.addDays(day, 1, timeZone)) {
        const values = day === today ? TODAY : OTHER_DAY;
        daily.time.push(day / 1000);
        daily.temperature_2m_max.push(values.high);
        daily.temperature_2m_min.push(values.low);
        daily.weather_code.push(values.code);
        daily.precipitation_probability_max.push(values.rain);
        daily.sunrise.push(day / 1000 + 7 * HOUR_S);
        daily.sunset.push(day / 1000 + 18 * HOUR_S);
    }
    return { timezone: timeZone, hourly, daily };
};

/**
 * starts both services on one port; down makes every answer a 500
 **/
var startWeatherServices = async () => {
    const services = { down: false, forecastRequests: [], geocodeRequests: [] };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const json = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        if (services.down) {
            json(500, { error: true, reason: 'down for the test' });
            return;
        }
        const zip = /^\/us\/(\d+)$/.exec(url.pathname);
        if (zip) {
            services.geocodeRequests.push(zip[1]);
            const place = PLACES[zip[1]];
            if (place) {
                json(200, { 'post code': zip[1], country: 'United States', 'country abbreviation': 'US', places: [place] });
            } else {
                json(404, {});
            }
        } else if (url.pathname === '/v1/forecast') {
            services.forecastRequests.push(Object.fromEntries(url.searchParams));
            json(200, forecastFor(url.searchParams.get('timezone')));
        } else {
            json(404, {});
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return Object.assign(services, {
        env: { GEOCODE_URL: base, FORECAST_URL: `${base}/v1/forecast` },
        stop: () => new Promise((resolve) => server.close(resolve))
    });
};

module.exports = { startWeatherServices, TODAY, OTHER_DAY };
