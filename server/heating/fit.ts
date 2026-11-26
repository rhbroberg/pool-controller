'use strict';
// Learns how one body of water warms and cools from the windows measured in history.
//
// Each window is a straight-line approximation of
//
//     dT/dt = H·heater + (a + b·(air − 60))·heatpump − k·(T − air) + S·sun        °F per hour
//
// T is the water's temperature and air the air's. H is what the heater adds: a gas heater's
// output barely depends on the weather. The heat pump's output falls as the air cools, so it is
// a straight line in the air temperature (a at 60°F, b per °F), never below nothing. k is the
// loss to the air, which grows with how much warmer the water is: the water is fighting that
// loss, so a colder day costs more. Cooling windows, with nothing heating, measure k directly.
// S is what full sun adds (0 at night): history has the time of day but not the clouds.
//
// The four numbers are fit by least squares over the windows, weighted toward long ones, and
// none may be negative: heat sources don't cool and the sun doesn't chill.

const REFERENCE_AIR_F = 60;
const NAMES = ['heater', 'pumpBase', 'pumpSlope', 'loss', 'solar'];
const COLUMNS = NAMES.length;
// the sun needs windows from different parts of the day
const MIN_SUN_SPREAD = 0.1;

// below this the windows can't tell the four apart
const MIN_WINDOWS = 5;
// the heat pump's slope with air temperature needs windows over a range of it
const MIN_PUMP_WINDOWS_FOR_SLOPE = 4;
const MIN_PUMP_AIR_RANGE_F = 8;
// the loss needs windows over a range of how far the water is above the air
const MIN_EXCESS_SPREAD_F = 1;
const OUTLIER_SCALE = 3.5;
const MIN_OUTLIER_F_PER_HOUR = 0.5;
const MAX_WEIGHT_HOURS = 4;
const MIN_SOURCE_F_PER_HOUR = 0.02;

var usesHeater = (window) => window.sources === 'heater' || window.sources === 'both';
var usesPump = (window) => window.sources === 'heatpump' || window.sources === 'both';

var row = (window) => {
    const pump = usesPump(window) ? 1 : 0;
    return [
        usesHeater(window) ? 1 : 0,
        pump,
        pump * (window.airTemperature - REFERENCE_AIR_F),
        -(window.waterTemperature - window.airTemperature),
        window.sun || 0
    ];
};

// longer windows give steadier slopes: a reading's quantization matters less over more hours
var weight = (window) => Math.pow(Math.min(window.hours, MAX_WEIGHT_HOURS), 2);

var median = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

var spread = (values) => {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.sqrt(values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length);
};

/** solves the square system in place by elimination; undefined when it's singular */
var solve = (matrix, vector) => {
    const n = vector.length;
    const a = matrix.map((line, index) => line.concat([vector[index]]));
    for (let column = 0; column < n; column++) {
        let pivot = column;
        for (let line = column + 1; line < n; line++) {
            if (Math.abs(a[line][column]) > Math.abs(a[pivot][column])) {
                pivot = line;
            }
        }
        if (Math.abs(a[pivot][column]) < 1e-9) {
            return undefined;
        }
        [a[column], a[pivot]] = [a[pivot], a[column]];
        for (let line = column + 1; line < n; line++) {
            const factor = a[line][column] / a[column][column];
            for (let k = column; k <= n; k++) {
                a[line][k] -= factor * a[column][k];
            }
        }
    }
    const x = new Array(n).fill(0);
    for (let line = n - 1; line >= 0; line--) {
        let sum = a[line][n];
        for (let k = line + 1; k < n; k++) {
            sum -= a[line][k] * x[k];
        }
        x[line] = sum / a[line][line];
    }
    return x;
};

/**
 * the best non-negative coefficients for the columns named in `allowed`, the others zero; with
 * only four to choose from, every set of columns is tried and the best that stays non-negative
 * wins
 **/
var nonNegativeFit = (rows, slopes, weights, allowed) => {
    let best = { error: Infinity, coefficients: new Array(COLUMNS).fill(0) };
    const error = (coefficients) => rows.reduce((sum, line, index) => {
        const predicted = line.reduce((total, value, column) => total + value * coefficients[column], 0);
        return sum + weights[index] * Math.pow(slopes[index] - predicted, 2);
    }, 0);
    for (let mask = 0; mask < (1 << COLUMNS); mask++) {
        const columns = NAMES.map((_, column) => column).filter((column) => mask & (1 << column));
        if (columns.some((column) => !allowed[column])) {
            continue;
        }
        let coefficients = new Array(COLUMNS).fill(0);
        if (columns.length > 0) {
            const matrix = columns.map((i) => columns.map((j) => rows.reduce((sum, line, index) => sum + weights[index] * line[i] * line[j], 0)));
            const vector = columns.map((i) => rows.reduce((sum, line, index) => sum + weights[index] * line[i] * slopes[index], 0));
            const solved = solve(matrix, vector);
            if (!solved || solved.some((value) => value < -1e-12)) {
                continue;
            }
            columns.forEach((column, index) => {
                coefficients[column] = Math.max(0, solved[index]);
            });
        }
        const e = error(coefficients);
        // fewer columns on a tie, so a source that adds nothing isn't credited
        if (e < best.error - 1e-12) {
            best = { error: e, coefficients };
        }
    }
    return best.coefficients;
};

var identifiable = (windows) => {
    const withPump = windows.filter(usesPump);
    const airs = withPump.map((window) => window.airTemperature);
    const excess = windows.map((window) => window.waterTemperature - window.airTemperature);
    return [
        windows.filter(usesHeater).length >= 2,
        withPump.length >= 2,
        withPump.length >= MIN_PUMP_WINDOWS_FOR_SLOPE && Math.max(...airs) - Math.min(...airs) >= MIN_PUMP_AIR_RANGE_F,
        windows.length >= MIN_WINDOWS && spread(excess) >= MIN_EXCESS_SPREAD_F,
        windows.length >= MIN_WINDOWS && spread(windows.map((window) => window.sun || 0)) >= MIN_SUN_SPREAD
    ];
};

var fitOnce = (windows) => {
    const rows = windows.map(row);
    const slopes = windows.map((window) => window.slope);
    const weights = windows.map(weight);
    const allowed = identifiable(windows);
    const coefficients = nonNegativeFit(rows, slopes, weights, allowed);
    const residuals = rows.map((line, index) => slopes[index] - line.reduce((total, value, column) => total + value * coefficients[column], 0));
    return { coefficients, allowed, residuals, weights, slopes };
};

var range = (values) => values.length ? [Math.min(...values), Math.max(...values)] : null;

var count = (windows, sources) => windows.filter((window) => window.sources === sources).length;

/**
 * the model for one body from its windows (suitable ones, as measured by the extractor):
 * { available: false, reason } when they can't tell, otherwise
 *
 *   heater      °F per hour the heater adds, or null with no heater windows
 *   heatPump    { base, slope, referenceAirTemperature, minimumAirTemperature } or null
 *   loss        per hour, the share of the water's excess over the air lost
 *   windows, outliers, rSquared, rmse (°F per hour), airRange, waterRange, notes
 **/
var fitBody = (windows) => {
    if (windows.length < MIN_WINDOWS) {
        return { available: false, reason: `needs at least ${MIN_WINDOWS} windows; has ${windows.length}`, windows: counts(windows) };
    }
    if (!windows.some((window) => window.sources !== 'cooling')) {
        return { available: false, reason: 'has no windows with the heater or heat pump on', windows: counts(windows) };
    }
    let used = windows;
    let fit = fitOnce(used);
    // a window that stands far apart from the rest, such as a switch the history never recorded
    // turning off, would drag every number; drop those once and fit again
    const scale = Math.max(1.4826 * median(fit.residuals.map(Math.abs)), 0.15);
    const limit = Math.max(OUTLIER_SCALE * scale, MIN_OUTLIER_F_PER_HOUR);
    const kept = used.filter((_, index) => Math.abs(fit.residuals[index]) <= limit);
    const outliers = used.length - kept.length;
    if (outliers > 0 && kept.length >= MIN_WINDOWS) {
        used = kept;
        fit = fitOnce(used);
    }

    const [heater, base, slope, loss, solar] = fit.coefficients;
    const notes = [];
    if (!fit.allowed[2] && used.some(usesPump)) {
        notes.push('the heat pump windows cover too little range of air temperature to tell how it falls with cold; its output is taken as constant');
    }
    if (!fit.allowed[3]) {
        notes.push('the windows can’t tell how fast heat is lost; none is assumed');
    }
    if (!fit.allowed[4]) {
        notes.push('the windows are all from similar times of day; no warming from the sun is assumed');
    }
    if (!used.some(usesHeater)) {
        notes.push('no heater windows');
    }

    // a source the windows show adding nothing is one they can't tell about, not one that doesn't work
    const heaterKnown = used.some(usesHeater) && fit.allowed[0] && heater > MIN_SOURCE_F_PER_HOUR;
    const pumpKnown = used.some(usesPump) && fit.allowed[1] && base > MIN_SOURCE_F_PER_HOUR;
    if (used.some(usesHeater) && !heaterKnown) {
        notes.push('the windows with the heater on show no warming from it, so how fast it heats is not known');
    }
    if (used.some(usesPump) && !pumpKnown) {
        notes.push('the windows with the heat pump on show no warming from it, so how fast it heats is not known');
    }

    const totalWeight = fit.weights.reduce((sum, value) => sum + value, 0);
    const mean = fit.slopes.reduce((sum, value, index) => sum + value * fit.weights[index], 0) / totalWeight;
    const sumSquares = fit.residuals.reduce((sum, value, index) => sum + fit.weights[index] * value * value, 0);
    const total = fit.slopes.reduce((sum, value, index) => sum + fit.weights[index] * Math.pow(value - mean, 2), 0);
    const pumpAir = used.filter(usesPump).map((window) => window.airTemperature);
    return {
        available: true,
        heater: heaterKnown ? heater : null,
        heatPump: pumpKnown ? {
            base,
            slope,
            referenceAirTemperature: REFERENCE_AIR_F,
            // the air below which it adds nothing
            minimumAirTemperature: slope > 0 ? REFERENCE_AIR_F - base / slope : null
        } : null,
        loss: fit.allowed[3] ? loss : 0,
        solar: fit.allowed[4] ? solar : 0,
        windows: counts(used),
        outliers,
        rSquared: total > 1e-9 ? Math.max(0, 1 - sumSquares / total) : null,
        rmse: Math.sqrt(sumSquares / totalWeight),
        airRange: range(used.map((window) => window.airTemperature)),
        waterRange: range(used.map((window) => window.waterTemperature)),
        heatPumpAirRange: range(pumpAir),
        notes
    };
};

var counts = (windows) => ({
    heater: count(windows, 'heater'),
    heatpump: count(windows, 'heatpump'),
    both: count(windows, 'both'),
    cooling: count(windows, 'cooling'),
    total: windows.length
});

module.exports = { fitBody, REFERENCE_AIR_F, MIN_WINDOWS, NAMES };
