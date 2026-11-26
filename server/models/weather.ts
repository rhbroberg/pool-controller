'use strict';
var mongoose = require('mongoose');

// One hour of weather at the pool's zip code, in °F, mph and inches. Each fetch overwrites the
// hours it covers, so an hour forecast earlier becomes the one observed once it has passed.
var WeatherHourSchema = new mongoose.Schema({
    zipCode: String,
    // the start of the hour
    time: Date,
    // whether the hour was still ahead when it was fetched
    forecast: Boolean,
    fetchedAt: Date,
    airTemp: Number,
    // percent
    humidity: Number,
    // percent of the sky
    cloudCover: Number,
    // W/m², averaged over the hour before `time`
    solarRadiation: Number,
    windSpeed: Number,
    precipitation: Number,
    // percent
    precipitationProbability: Number,
    // WMO weather interpretation code
    weatherCode: Number
}, { versionKey: false });

WeatherHourSchema.index({ zipCode: 1, time: 1 }, { name: 'zip_time', unique: true });

// one local day at the pool's zip code, in the server's time zone
var WeatherDaySchema = new mongoose.Schema({
    zipCode: String,
    // YYYY-MM-DD in the server's time zone
    date: String,
    forecast: Boolean,
    fetchedAt: Date,
    high: Number,
    low: Number,
    weatherCode: Number,
    precipitationProbability: Number,
    sunrise: Date,
    sunset: Date
}, { versionKey: false });

WeatherDaySchema.index({ zipCode: 1, date: 1 }, { name: 'zip_date', unique: true });

var WeatherHour = mongoose.model('weatherhours', WeatherHourSchema);
var WeatherDay = mongoose.model('weatherdays', WeatherDaySchema);

module.exports = { WeatherHour, WeatherDay };
