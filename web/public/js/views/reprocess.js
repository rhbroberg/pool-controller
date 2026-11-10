// Reading stored history again with the server's current protocol code, as after a parser fix:
// pick the range and the kinds of event, preview what would change, then rewrite it.

import { h, confirmAction } from '../dom.js';
import { icon } from '../icons.js';
import { formatMonthDayYearTime } from '../format.js';
import { ReprocessForm, REPROCESS_KINDS, isActive, runStateText, runRows, runFooter } from '../reprocess.js';
import { topbar, formSection, formRow, actionRow, spinner, renderer } from '../ui.js';

export const mountReprocess = (root, app) => {
    const { store } = app;
    const form = new ReprocessForm(store, { changed: () => redraw() });

    const start = async (dryRun) => {
        if (!dryRun) {
            const [from, to] = form.range;
            const confirmed = await confirmAction({
                title: 'Reprocess history?',
                message: `Events from ${formatMonthDayYearTime(from)} to ${formatMonthDayYearTime(to)} are rewritten from their stored frames, and ones that now change nothing are removed. This can’t be undone. The history summaries are then redone from the start of the range.`,
                action: 'Reprocess',
                destructive: true
            });
            if (!confirmed) {
                return;
            }
        }
        form.start(dryRun);
    };

    const chip = (kind) => {
        const on = form.kinds.has(kind.id);
        return h('button', {
            class: 'chip',
            type: 'button',
            style: { '--tint': `var(--${kind.tint})` },
            'aria-pressed': String(on),
            onClick: () => form.toggle(kind.id)
        }, icon(on ? 'check' : kind.icon), kind.title);
    };

    const dateRow = (id, label, value, change) => formRow(
        h('label', { for: id, class: 'label' }, label),
        h('input', {
            id,
            type: 'datetime-local',
            value,
            disabled: isActive(form.run),
            onChange: (event) => {
                change(event.target.value);
                redraw();
            }
        }));

    const valueRow = (label, value) => formRow(h('span', { class: 'label' }, label), h('span', { class: 'value' }, value));

    const runSection = (run) => formSection({ header: run.dryRun ? 'Preview' : 'Last Run', footer: runFooter(run) },
        formRow(
            h('span', { class: ['label', run.state === 'failed' ? 'warning' : ''] }, runStateText(run, formatMonthDayYearTime)),
            isActive(run) ? h('span', { style: { marginLeft: 'auto' } }, spinner('small')) : null),
        valueRow('Range', `${formatMonthDayYearTime(run.from)} – ${formatMonthDayYearTime(run.to)}`),
        ...runRows(run).map(([label, count]) => valueRow(label, count.toLocaleString())));

    const render = () => {
        const disabled = !form.canStart(store.isAdmin);
        const rangeProblem = form.rangeProblem;
        return [
            topbar({ title: 'Reprocess History', back: 'maintenance', backTitle: 'Server Maintenance' }),
            h('main', { class: 'page' },
                h('div', { class: 'form' },
                    formSection({ header: 'Range', footer: rangeProblem || 'Times are in this browser’s time zone. Reprocessing stops just before the end.', footerClass: rangeProblem ? 'error' : '' },
                        dateRow('reprocess-from', 'From', form.from, (value) => { form.from = value; }),
                        dateRow('reprocess-to', 'To', form.to, (value) => { form.to = value; })),
                    formSection({ header: 'Events', footer: 'The kinds of event read again from their stored frames; the others stay as they are. Communication errors hold the frames the server couldn’t read. Readings and equipment also lose repeats of a value the server once stored again.' },
                        formRow(h('div', { class: 'chips' }, REPROCESS_KINDS.map(chip)))),
                    formSection({ footer: 'The server reads each stored frame again with its current decoding and keeps what changed, as if it had read them that way at the time. Frames that now change nothing are removed. Preview counts the changes without making them.' },
                        actionRow('Preview', () => start(true), { disabled, busy: form.starting }),
                        actionRow('Reprocess', () => start(false), { destructive: true, disabled })),
                    form.error ? formSection({}, h('div', { class: 'warning-line' }, icon('warning'), form.error)) : null,
                    form.run ? runSection(form.run) : null,
                    !store.credentials
                        ? formSection({}, h('div', { class: 'message-box secondary' }, 'Sign in as an admin to reprocess history.'))
                        : null))
        ];
    };

    const redraw = renderer(root, render);
    let wasAdmin = store.isAdmin;
    const unsubscribe = store.subscribe(() => {
        if (store.isAdmin && !wasAdmin) {
            form.load();
        }
        wasAdmin = store.isAdmin;
        redraw();
    });
    document.title = 'Reprocess History';
    redraw();
    if (store.isAdmin) {
        form.load();
    }
    return () => {
        form.stop();
        unsubscribe();
    };
};
