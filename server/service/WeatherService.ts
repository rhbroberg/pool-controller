'use strict';
// Weather at the pool's zip code: fetched by the weather job and kept by the hour and the day,
// so the main page shows today's forecast without waiting on another service, and the
// server has the conditions behind every stretch of water temperature history.

var { WeatherHour, WeatherDay } = require('../models/weather');
const settings = require('./SettingsService');
const providers = require('./WeatherProviders');
const tz = require('../utils/timezone');
const { condition } = require('../utils/weatherCodes');

const HOUR_MS = 60 * 60 * 1000;
// older than this, the forecast is shown as out of date
const STALE_MS = 3 * HOUR_MS;

/**
 * fetches the forecast for the zip code and keeps every hour and day it covers
 *
 * returns { zipCode, hours, days }, or undefined when no zip code is set
 **/
exports.refresh = async function() {
    const location = settings.location();
    if (!location) {
        return undefined;
    }
    const { hours, days } = await providers.forecast(location, settings.timeZone());
    const fetchedAt = new Date();
    const zipCode = location.zipCode;
    if (hours.length > 0) {
        await WeatherHour.bulkWrite(hours.map((hour) => ({
            updateOne: {
                filter: { zipCode, time: hour.time },
                update: { $set: Object.assign({}, hour, { zipCode, fetchedAt, forecast: hour.time > fetchedAt }) },
                upsert: true
            }
        })), { ordered: false });
    }
    if (days.length > 0) {
        const today = tz.dayKey(fetchedAt.getTime(), settings.timeZone());
        await WeatherDay.bulkWrite(days.map((day) => ({
            updateOne: {
                filter: { zipCode, date: day.date },
                update: { $set: Object.assign({}, day, { zipCode, fetchedAt, forecast: day.date >= today }) },
                upsert: true
            }
        })), { ordered: false });
    }
    return { zipCode, hours: hours.length, days: days.length };
};

var describeDay = (day) => day ? {
    date: day.date,
    high: day.high,
    low: day.low,
    condition: condition(day.weatherCode),
    weatherCode: day.weatherCode,
    precipitationProbability: day.precipitationProbability,
    sunrise: day.sunrise,
    sunset: day.sunset
} : null;

/**
 * today's forecast at the zip code
 *
 * returns Weather
 **/
exports.getWeather = async function() {
    const location = settings.location();
    if (!location) {
        return { configured: false, location: null, today: null, fetchedAt: null, stale: false };
    }
    const date = tz.dayKey(Date.now(), settings.timeZone());
    const day = await WeatherDay.findOne({ zipCode: location.zipCode, date }).lean();
    const fetchedAt = day ? day.fetchedAt : null;
    return {
        configured: true,
        location: { zipCode: location.zipCode, placeName: location.placeName },
        today: describeDay(day),
        fetchedAt,
        stale: !fetchedAt || Date.now() - new Date(fetchedAt).getTime() > STALE_MS
    };
};

/**
 * the conditions in the hour containing `time` at the zip code, or undefined if none were kept
 **/
exports.conditionsAt = async function(time) {
    const location = settings.location();
    if (!location) {
        return undefined;
    }
    const start = new Date(Math.floor(new Date(time).getTime() / HOUR_MS) * HOUR_MS);
    return (await WeatherHour.findOne({ zipCode: location.zipCode, time: start }).lean()) || undefined;
};

/**
 * the hours kept from now through `hours` ahead, oldest first
 **/
exports.forecast = async function(hours) {
    const location = settings.location();
    if (!location) {
        return [];
    }
    const from = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
    const to = new Date(from.getTime() + hours * HOUR_MS);
    return WeatherHour.find({ zipCode: location.zipCode, time: { $gte: from, $lt: to } }).sort({ time: 1 }).lean();
};

/**
 * removes weather older than `cutoff`, as raw history is
 *
 * returns how many hours and days were removed
 **/
exports.removeBefore = async function(cutoff, timeZone) {
    const [hours, days] = await Promise.all([
        WeatherHour.deleteMany({ time: { $lt: cutoff } }),
        WeatherDay.deleteMany({ date: { $lt: tz.dayKey(cutoff.getTime(), timeZone) } })
    ]);
    return hours.deletedCount + days.deletedCount;
};
