'use strict';
// Whether it's dark at the pool, for turning the lights on with a spa party. With the pool's
// latitude and longitude (from the zip code an admin gave) this is the sun's real position;
// without them it falls back to the same fixed day the heating model uses.

const sun = require('../heating/sun');

const RAD = Math.PI / 180;
const DAY_MS = 86400 * 1000;
// 2000-01-01T12:00Z, the J2000 epoch the formulas below count days from
const J2000_MS = Date.UTC(2000, 0, 1, 12);
// the sun's upper edge at the horizon, with refraction: sunset
const SUNSET_ELEVATION = -0.833;

/**
 * the sun's elevation in degrees at `ms` seen from latitude and longitude in degrees, from the
 * low-precision formulas of the Astronomical Almanac; good to a fraction of a degree
 **/
var elevation = (ms, latitude, longitude) => {
    const days = (ms - J2000_MS) / DAY_MS;
    const meanAnomaly = (357.529 + 0.98560028 * days) * RAD;
    const meanLongitude = 280.459 + 0.98564736 * days;
    const eclipticLongitude = (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.020 * Math.sin(2 * meanAnomaly)) * RAD;
    const obliquity = (23.439 - 0.00000036 * days) * RAD;
    const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude));
    const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
    const siderealHours = 18.697374558 + 24.06570982441908 * days;
    const hourAngle = ((siderealHours * 15 + longitude) * RAD) - rightAscension;
    const lat = latitude * RAD;
    return Math.asin(Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle)) / RAD;
};

/**
 * true between sunset and sunrise at `location` ({ latitude, longitude }), or, without one, at
 * night on the fixed day for `timeZone`
 **/
var isDark = (ms, location, timeZone) => {
    if (location && typeof location.latitude === 'number' && typeof location.longitude === 'number') {
        return elevation(ms, location.latitude, location.longitude) < SUNSET_ELEVATION;
    }
    return sun.forTimeZone(timeZone)(ms) === 0;
};

module.exports = { elevation, isDark };
