// Dates and durations in words, in the browser's locale.

const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const UNITS = [
    ['year', 365 * 24 * 3600],
    ['month', 30 * 24 * 3600],
    ['week', 7 * 24 * 3600],
    ['day', 24 * 3600],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1]
];

/** "5 minutes ago", "yesterday", "in 2 hours" */
export const relative = (date, now = Date.now()) => {
    const seconds = (date.getTime() - now) / 1000;
    for (const [unit, size] of UNITS) {
        if (Math.abs(seconds) >= size || unit === 'second') {
            return relativeFormat.format(Math.round(seconds / size), unit);
        }
    }
    return '';
};

const formatter = (options) => new Intl.DateTimeFormat(undefined, options);

const monthDayTime = formatter({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const monthDayYear = formatter({ month: 'short', day: 'numeric', year: 'numeric' });
const monthDayYearTime = formatter({ month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const monthDay = formatter({ month: 'short', day: 'numeric' });
const monthYear = formatter({ month: 'short', year: '2-digit' });
const hourOnly = formatter({ hour: 'numeric' });
const timeSeconds = formatter({ hour: 'numeric', minute: '2-digit', second: '2-digit' });

export const formatMonthDayTime = (date) => monthDayTime.format(date);
export const formatMonthDayYear = (date) => monthDayYear.format(date);
export const formatMonthDayYearTime = (date) => monthDayYearTime.format(date);
export const formatMonthDay = (date) => monthDay.format(date);
export const formatMonthYear = (date) => monthYear.format(date);

/** "30 minutes", "2 hours", "1 day": a bucket length in seconds */
export const formatSpan = (seconds) => {
    const [size, unit] = seconds >= 86400 ? [86400, 'day'] : seconds >= 3600 ? [3600, 'hour'] : [60, 'minute'];
    const count = Math.round(seconds / size);
    return `${count} ${unit}${count === 1 ? '' : 's'}`;
};
export const formatHour = (date) => hourOnly.format(date);
export const formatTimeSeconds = (date) => timeSeconds.format(date);

/** "30 seconds", "2 minutes" */
export const formatDurationSeconds = (seconds) => {
    if (seconds < 60) {
        return `${seconds} seconds`;
    }
    const minutes = Math.round(seconds / 60);
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
};

/** "0:27", the time left until a date */
export const countdown = (date, now = Date.now()) => {
    const left = Math.max(0, Math.ceil((date.getTime() - now) / 1000));
    return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
};
