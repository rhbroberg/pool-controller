// Picks a range of days for a history graph, in a sheet: click the first day, then the last.
// A dot marks each day the server has pool, spa or salt readings for.

import { h, openDialog } from '../dom.js';
import { icon } from '../icons.js';
import { HistoryCalendar, shiftMonth } from '../calendar.js';
import { partsOf } from '../timezone.js';
import { sheetHeader, spinner } from '../ui.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const monthTitle = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayTitle = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

const keyAsUtcDate = (key) => {
    const { year, month, day } = partsOf(key);
    return new Date(Date.UTC(year, month - 1, day));
};

/**
 * resolves with [from, to] in milliseconds for the days picked, or undefined when cancelled;
 * initial is the window the graph shows now
 **/
export const openHistoryCalendar = (app, [initialFrom, initialTo]) => {
    let sheet;
    const calendar = new HistoryCalendar(app.client, () => sheet && sheet.update());
    let { first, last } = calendar.keysIn(initialFrom, initialTo);
    let visible = (({ year, month }) => ({ year, month }))(partsOf(last));

    const page = (offset) => {
        visible = shiftMonth(visible, offset);
        calendar.load(visible);
        sheet.update();
    };

    const pick = (key) => {
        if (!first || last) {
            first = key;
            last = null;
        } else {
            last = key;
        }
        sheet.update();
    };

    const chosen = () => {
        if (!first) {
            return null;
        }
        const [start, end] = [first, last || first].sort();
        return { start, end };
    };

    const dayButton = (day, selection) => {
        if (!day.inMonth) {
            return h('span', { class: 'calendar-day outside', 'aria-hidden': 'true' });
        }
        const inRange = selection && day.key >= selection.start && day.key <= selection.end;
        const isEnd = selection && (day.key === selection.start || day.key === selection.end);
        const readings = calendar.readingsOn(day.key);
        return h('button', {
            type: 'button',
            class: ['calendar-day', inRange ? 'in-range' : '', isEnd ? 'range-end' : '', day.key === calendar.today() ? 'today' : ''],
            disabled: !day.selectable,
            'aria-pressed': String(Boolean(inRange)),
            'aria-label': `${dayTitle.format(keyAsUtcDate(day.key))}${readings ? ', has readings' : ''}`,
            onClick: () => pick(day.key)
        }, h('span', { class: 'calendar-number' }, String(day.day)), readings ? h('span', { class: 'calendar-dot' }) : null);
    };

    const render = (close) => {
        const selection = chosen();
        const weeks = calendar.monthGrid(visible);
        const today = partsOf(calendar.today());
        const atLatest = visible.year > today.year || (visible.year === today.year && visible.month >= today.month);
        const earliest = calendar.earliest ? partsOf(calendar.earliest) : null;
        const atEarliest = earliest && (visible.year < earliest.year || (visible.year === earliest.year && visible.month <= earliest.month));
        return [
            sheetHeader({
                title: 'Choose Dates',
                leading: h('button', { class: 'bar-button', type: 'button', onClick: () => close() }, 'Cancel'),
                trailing: h('button', {
                    class: 'bar-button strong',
                    type: 'button',
                    disabled: !selection,
                    onClick: () => close(calendar.range(selection.start, selection.end))
                }, 'Show')
            }),
            h('div', { class: 'sheet-content calendar' },
                h('div', { class: 'calendar-header' },
                    h('h3', null, monthTitle.format(new Date(Date.UTC(visible.year, visible.month - 1, 1)))),
                    calendar.isLoading ? spinner('small') : null,
                    h('div', { class: 'calendar-paging' },
                        h('button', { class: 'bar-button', type: 'button', 'aria-label': 'Previous month', disabled: atEarliest, onClick: () => page(-1) }, icon('chevronLeft')),
                        h('button', { class: 'bar-button', type: 'button', 'aria-label': 'Next month', disabled: atLatest, onClick: () => page(1) }, icon('chevronRight')))),
                h('div', { class: 'calendar-grid', role: 'group', 'aria-label': 'Days' },
                    WEEKDAYS.map((name) => h('span', { class: 'calendar-weekday' }, name)),
                    weeks.flat().map((day) => dayButton(day, selection))),
                selection
                    ? h('div', { class: 'calendar-selection' },
                        selection.start === selection.end
                            ? dayTitle.format(keyAsUtcDate(selection.start))
                            : `${dayTitle.format(keyAsUtcDate(selection.start))} – ${dayTitle.format(keyAsUtcDate(selection.end))}`)
                    : null,
                h('div', { class: 'help' },
                    h('span', null,
                        h('span', { class: 'calendar-dot inline' }),
                        ' A dot marks a day with pool, spa or salt readings. Click the first day, then the last.')),
                calendar.errorMessage ? h('div', { class: 'warning-line' }, icon('warning'), calendar.errorMessage) : null)
        ];
    };

    sheet = openDialog(render, { className: 'sheet calendar-sheet' });
    calendar.load(visible);
    return sheet.result;
};
