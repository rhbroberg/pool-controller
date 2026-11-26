'use strict';
// The free services weather comes from: Zippopotam.us turns a US zip code into a place, and
// Open-Meteo forecasts for it. Neither needs a key. GEOCODE_URL and FORECAST_URL point them
// elsewhere, as the tests do.

const tz = require('../utils/timezone');

const GEOCODE_URL = process.env.GEOCODE_URL || 'https://api.zippopotam.us';
const FORECAST_URL = process.env.FORECAST_URL || 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = Number(process.env.WEATHER_TIMEOUT_MS) || 10000;
// hours already past come back too, so the history of conditions has no gaps between fetches
const PAST_DAYS = 2;
const FORECAST_DAYS = 3;

const HOURLY = {
    airTemp: 'temperature_2m',
    humidity: 'relative_humidity_2m',
    cloudCover: 'cloud_cover',
    solarRadiation: 'shortwave_radiation',
    windSpeed: 'wind_speed_10m',
    precipitation: 'precipitation',
    precipitationProbability: 'precipitation_probability',
    weatherCode: 'weather_code'
};
const DAILY = {
    high: 'temperature_2m_max',
    low: 'temperature_2m_min',
    weatherCode: 'weather_code',
    precipitationProbability: 'precipitation_probability_max',
    sunrise: 'sunrise',
    sunset: 'sunset'
};

var getJson = async (url, service) => {
    let response;
    try {
        response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
        throw new Error(`${service} can’t be reached (${e.cause && e.cause.code ? e.cause.code : e.message})`);
    }
    const body = await response.json().catch(() => undefined);
    return { status: response.status, body };
};

var numberOrNull = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * the place a five-digit US zip code belongs to, or undefined when there's none
 **/
exports.geocode = async function(zipCode) {
    const { status, body } = await getJson(`${GEOCODE_URL}/us/${encodeURIComponent(zipCode)}`, 'the zip code service');
    if (status === 404) {
        return undefined;
    }
    const place = status === 200 && body && Array.isArray(body.places) ? body.places[0] : undefined;
    if (!place) {
        throw new Error(`the zip code service answered ${status}`);
    }
    const latitude = Number(place.latitude);
    const longitude = Number(place.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new Error('the zip code service gave no coordinates');
    }
    return {
        zipCode,
        countryCode: body['country abbreviation'] || 'US',
        latitude,
        longitude,
        placeName: [place['place name'], place['state abbreviation']].filter(Boolean).join(', ')
    };
};

/**
 * hourly conditions and daily summaries around now for a place, with days in timeZone
 *
 * returns { hours: [{ time, airTemp, … }], days: [{ date, high, low, … }] }
 **/
exports.forecast = async function({ latitude, longitude }, timeZone) {
    const query = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        timezone: timeZone,
        temperature_unit: 'fahrenheit',
        wind_speed_unit: 'mph',
        precipitation_unit: 'inch',
        timeformat: 'unixtime',
        past_days: String(PAST_DAYS),
        forecast_days: String(FORECAST_DAYS),
        hourly: Object.values(HOURLY).join(','),
        daily: Object.values(DAILY).join(',')
    });
    const { status, body } = await getJson(`${FORECAST_URL}?${query}`, 'the forecast service');
    if (status !== 200 || !body || !body.hourly || !body.daily) {
        throw new Error(`the forecast service answered ${status}${body && body.reason ? `: ${body.reason}` : ''}`);
    }

    const hours = (body.hourly.time || []).map((seconds, i) => {
        const hour = { time: new Date(seconds * 1000) };
        for (const [field, name] of Object.entries(HOURLY)) {
            hour[field] = numberOrNull((body.hourly[name] || [])[i]);
        }
        return hour;
    });
    const days = (body.daily.time || []).map((seconds, i) => {
        const value = (name) => numberOrNull((body.daily[name] || [])[i]);
        const instant = (name) => value(name) === null ? null : new Date(value(name) * 1000);
        return {
            // the time is the local midnight starting the day; noon is safely inside it
            date: tz.dayKey(seconds * 1000 + tz.DAY_MS / 2, timeZone),
            high: value(DAILY.high),
            low: value(DAILY.low),
            weatherCode: value(DAILY.weatherCode),
            precipitationProbability: value(DAILY.precipitationProbability),
            sunrise: instant(DAILY.sunrise),
            sunset: instant(DAILY.sunset)
        };
    });
    return { hours, days };
};
