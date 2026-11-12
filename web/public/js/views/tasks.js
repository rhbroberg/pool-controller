// Pool, Spa Preheat and Spa Party on the main page, each a switch; a preheat can instead be
// scheduled to be ready by a time, which shows plainly as scheduled until it starts.

import { h, openDialog } from '../dom.js';
import { icon } from '../icons.js';
import { TASKS, taskOn, scheduledPreheat, scheduleText } from '../model.js';
import { formSection, formRow, sheetHeader, spinner } from '../ui.js';

/** "2026-11-12T19:30" in local time, as a datetime-local input takes it */
const localInputValue = (date) => {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
};

/** asks when the spa should be ready, starting from `current` or now */
const openPreheatSchedule = (app, current) => {
    const { store } = app;
    let value = localInputValue(current || new Date());

    const render = (close) => [
        sheetHeader({
            title: 'Spa Preheat',
            leading: h('button', { class: 'bar-button', type: 'button', onClick: () => close() }, 'Cancel'),
            trailing: h('button', {
                class: 'bar-button strong',
                type: 'button',
                disabled: !value,
                onClick: () => close(new Date(value))
            }, 'Schedule')
        }),
        h('div', { class: 'sheet-content form' },
            formSection({ footer: 'The spa starts heating only as early as it needs to, to be at its setpoint by then. A time too soon to make starts it now.' },
                formRow(
                    h('label', { for: 'preheat-ready-at' }, 'Ready At'),
                    h('input', {
                        id: 'preheat-ready-at',
                        type: 'datetime-local',
                        value,
                        min: localInputValue(new Date()),
                        style: { marginLeft: 'auto' },
                        onInput: (event) => { value = event.target.value; }
                    }))))
    ];

    openDialog(render, { className: 'sheet' }).result.then((readyAt) => {
        if (readyAt instanceof Date && !Number.isNaN(readyAt.getTime())) {
            store.setTask('spaPreheat', true, readyAt);
        }
    });
};

/** what the line under a task says, and how it's coloured */
const status = (task, tasks, pending) => {
    if (pending !== undefined) {
        return { text: pending ? 'Turning on…' : 'Turning off…', kind: 'pending' };
    }
    const scheduled = task.id === 'spaPreheat' ? scheduledPreheat(tasks) : null;
    if (scheduled) {
        const { ready } = scheduleText(scheduled);
        return { text: `Scheduled · ${ready}`, kind: 'scheduled' };
    }
    if (taskOn(tasks, task.id)) {
        return { text: 'On', kind: 'on' };
    }
    return { text: task.summary, kind: 'off' };
};

export const taskSection = (app) => {
    const { store } = app;
    const tasks = store.tasks;
    if (!tasks) {
        return h('div', { class: 'card task-note' }, 'This server doesn’t offer tasks yet. Use Equipment below.');
    }
    const locked = !store.canControl || !store.isConnected;
    const row = (task) => {
        const on = taskOn(tasks, task.id);
        const pending = store.pendingTasks[task.id];
        const scheduled = task.id === 'spaPreheat' && !on ? scheduledPreheat(tasks) : null;
        const shownOn = pending !== undefined ? pending : on || Boolean(scheduled);
        const line = status(task, tasks, pending);
        return h('div', {
            class: ['card', 'task-row', on ? 'on' : '', scheduled ? 'scheduled' : ''],
            style: { '--tint': `var(--${scheduled ? 'blue' : task.tint})` },
            'data-task': task.id
        },
        h('span', { class: 'task-icon' }, icon(scheduled ? 'clock' : task.icon)),
        h('span', { class: 'task-text' },
            h('strong', null, task.title),
            h('span', { class: ['task-status', line.kind] }, line.text),
            scheduled && pending === undefined ? h('span', { class: 'task-status' }, scheduleText(scheduled).start) : null,
            task.id === 'spaPreheat' && !on
                ? h('button', {
                    class: 'link-button',
                    type: 'button',
                    disabled: locked || pending !== undefined,
                    onClick: () => openPreheatSchedule(app, scheduled ? new Date(scheduled.readyAt) : null)
                }, icon('clock'), scheduled ? 'Change Time…' : 'Ready At…')
                : null),
        pending !== undefined
            ? spinner('small')
            : h('button', {
                class: ['switch', shownOn ? 'on' : ''],
                type: 'button',
                role: 'switch',
                'aria-checked': String(shownOn),
                'aria-label': task.title,
                disabled: locked,
                onClick: () => store.setTask(task.id, !shownOn)
            }, h('span', { class: 'knob' })));
    };
    return h('section', { class: 'control-section task-section' },
        h('h2', { class: 'section-title' }, 'Tasks'),
        h('div', { class: 'section-body' }, ...TASKS.map(row)));
};
