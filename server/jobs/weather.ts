'use strict';
// Fetches the forecast for the pool's zip code; with no zip code set there's nothing to do.

const weather = require('../service/WeatherService');

var run = async () => {
    const fetched = await weather.refresh();
    if (!fetched) {
        return { summary: 'no zip code set, so no weather to fetch' };
    }
    return { summary: `fetched ${fetched.hours} hours and ${fetched.days} days of weather for ${fetched.zipCode}` };
};

module.exports = {
    name: 'weather',
    description: 'fetches the forecast for the pool’s zip code',
    everyMs: Number(process.env.WEATHER_EVERY_MS) || 30 * 60 * 1000,
    firstDelayMs: Number(process.env.WEATHER_FIRST_DELAY_MS) || 15 * 1000,
    run
};
