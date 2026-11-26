'use strict';
// WMO weather interpretation codes, as Open-Meteo reports them, in the few kinds the pages show.

/**
 * code as one of sunny, partly-cloudy, cloudy, fog, rain, snow or storm; null when unknown
 **/
var condition = (code) => {
    if (typeof code !== 'number') {
        return null;
    }
    if (code <= 1) {
        return 'sunny';
    }
    if (code === 2) {
        return 'partly-cloudy';
    }
    if (code === 3) {
        return 'cloudy';
    }
    if (code === 45 || code === 48) {
        return 'fog';
    }
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) {
        return 'snow';
    }
    if (code >= 95) {
        return 'storm';
    }
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) {
        return 'rain';
    }
    return null;
};

module.exports = { condition };
