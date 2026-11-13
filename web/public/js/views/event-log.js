// Every recorded event, newest first, loaded a page at a time as the list scrolls.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { isAbort } from '../api.js';
import { EVENT_KINDS, DEFAULT_EVENT_KINDS, eventKindOf } from '../model.js';
import { formatMonthDay, formatTimeSeconds, formatMonthDayYearTime } from '../format.js';
import { topbar, barButton, spinner, renderer } from '../ui.js';

const PAGE_SIZE = 50;
const EVERYONE = '';
// events the controller produced on its own, with no account
const CONTROLLER = 'controller';

export const mountEventLog = (root, app) => {
    const { client } = app;
    let kinds = new Set(DEFAULT_EVENT_KINDS);
    let user = EVERYONE;
    let ascending = false;
    let events = [];
    let users = [];
    let isLoading = false;
    let errorMessage = null;
    // the server has no more events for these filters
    let reachedEnd = false;
    let cursor = null;
    // bumped on every reload, so a page that arrives after the filters change is dropped
    let generation = 0;
    let observer = null;

    const isDefaultKinds = () => kinds.size === DEFAULT_EVENT_KINDS.length && DEFAULT_EVENT_KINDS.every((kind) => kinds.has(kind));

    const loadMore = async () => {
        if (isLoading || reachedEnd) {
            return;
        }
        isLoading = true;
        const started = generation;
        redraw();
        try {
            const page = await client.fetchEvents({
                types: EVENT_KINDS.filter((kind) => kinds.has(kind.id)).flatMap((kind) => kind.serverTypes),
                user: user || undefined,
                cursor: cursor || undefined,
                ascending,
                limit: PAGE_SIZE
            });
            if (started !== generation) {
                return;
            }
            const known = new Set(events.map((event) => event.id));
            events = [...events, ...page.events.filter((event) => !known.has(event.id))];
            cursor = page.next;
            reachedEnd = !page.next;
            errorMessage = null;
        } catch (error) {
            if (!isAbort(error) && started === generation) {
                errorMessage = error.message;
            }
        } finally {
            if (started === generation) {
                isLoading = false;
                redraw();
                requestAnimationFrame(fillScreen);
            }
        }
    };

    // the end of the list coming into view only fires once, so keep loading while a page
    // doesn't fill the window
    const fillScreen = () => {
        const sentinel = observer && observer.target;
        if (!reachedEnd && !errorMessage && sentinel && sentinel.isConnected &&
            sentinel.getBoundingClientRect().top < window.innerHeight + 400) {
            loadMore();
        }
    };

    /** starts over from the first page, as after a filter or sort change */
    const reload = () => {
        generation += 1;
        events = [];
        cursor = null;
        reachedEnd = kinds.size === 0;
        errorMessage = null;
        isLoading = false;
        loadMore();
    };

    const loadUsers = async () => {
        try {
            users = await client.fetchEventUsers();
            redraw();
        } catch {
            // the filter still offers everyone and the controller
        }
    };

    const toggle = (kind) => {
        kinds = new Set(kinds);
        if (kinds.has(kind.id)) {
            kinds.delete(kind.id);
        } else {
            kinds.add(kind.id);
        }
        reload();
    };

    // MARK: pieces

    const chip = (kind) => {
        const on = kinds.has(kind.id);
        return h('button', {
            class: 'chip',
            type: 'button',
            style: { '--tint': `var(--${kind.tint})` },
            'aria-pressed': String(on),
            onClick: () => toggle(kind)
        }, icon(on ? 'check' : kind.icon), kind.title);
    };

    const menu = ({ label, iconName, value, options, active, onChange }) => h('label', { class: ['menu-select', active ? 'active' : ''] },
        icon(iconName),
        h('select', { 'aria-label': label, value, onChange: (event) => onChange(event.target.value) },
            options.map((option) => h('option', { value: option.value }, option.label))),
        icon('chevronDown', { className: 'chevron' }));

    const filterBar = () => h('div', { class: 'filter-bar' },
        h('div', { class: 'filter-bar-inner' },
            h('div', { class: 'filter-heading' },
                h('span', null, 'Show'),
                isDefaultKinds() ? null : h('button', {
                    class: 'link-button',
                    type: 'button',
                    onClick: () => {
                        kinds = new Set(DEFAULT_EVENT_KINDS);
                        reload();
                    }
                }, 'Reset')),
            h('div', { class: 'chips' }, EVENT_KINDS.map(chip)),
            h('div', { class: 'menus' },
                menu({
                    label: 'User',
                    iconName: user === EVERYONE ? 'users' : 'user',
                    value: user,
                    active: user !== EVERYONE,
                    options: [
                        { value: EVERYONE, label: 'All Users' },
                        { value: CONTROLLER, label: 'Controller' },
                        ...users.filter((name) => name !== CONTROLLER).map((name) => ({ value: name, label: name }))
                    ],
                    onChange: (value) => {
                        user = value;
                        reload();
                    }
                }),
                menu({
                    label: 'Order',
                    iconName: 'sort',
                    value: ascending ? 'asc' : 'desc',
                    options: [{ value: 'desc', label: 'Newest First' }, { value: 'asc', label: 'Oldest First' }],
                    onChange: (value) => {
                        ascending = value === 'asc';
                        reload();
                    }
                }))));

    const row = (event) => {
        const kind = eventKindOf(event.type);
        return h('li', { class: 'event-row', 'data-key': event.id },
            h('div', { class: 'event-time' },
                h('span', { class: 'date' }, formatMonthDay(event.timestamp)),
                h('span', null, formatTimeSeconds(event.timestamp))),
            h('span', { class: 'event-icon', style: { '--tint': `var(--${kind.tint})` }, title: kind.title }, icon(kind.icon)),
            h('div', null,
                h('div', { class: 'event-summary' }, event.summary),
                event.user ? h('div', { class: 'event-user' }, event.user) : null));
    };

    /** the last row: loading, or how far back the list goes once there's nothing more */
    const endRow = () => {
        if (isLoading) {
            return h('div', { class: 'event-end', 'data-key': 'end' }, spinner());
        }
        if (!events.length) {
            return null;
        }
        const times = events.map((event) => event.timestamp.getTime());
        const oldest = new Date(Math.min(...times));
        return h('div', { class: 'event-end', 'data-key': 'end' },
            h('span', null, `${events.length} events back to ${formatMonthDayYearTime(oldest)}`),
            reachedEnd ? h('span', null, 'That’s everything for these filters.') : null,
            errorMessage ? h('span', { class: 'error-text' }, errorMessage) : null);
    };

    const emptyState = () => {
        if (events.length || isLoading) {
            return null;
        }
        if (!kinds.size) {
            return h('div', { class: 'center-message' }, icon('filter'), h('h2', null, 'No Event Types Chosen'), 'Turn on at least one of the filters above.');
        }
        if (errorMessage) {
            return h('div', { class: 'center-message' }, icon('wifiOff'), h('h2', null, 'Can’t Load Events'), errorMessage);
        }
        return h('div', { class: 'center-message' }, icon('list'), h('h2', null, 'No Events'), 'Nothing matches these filters.');
    };

    // loads the next page as the end of the list scrolls into view
    const watchEnd = (sentinel) => {
        if (observer && observer.target === sentinel) {
            return;
        }
        if (observer) {
            observer.disconnect();
        }
        const io = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                loadMore();
            }
        }, { rootMargin: '400px 0px' });
        io.observe(sentinel);
        observer = { target: sentinel, disconnect: () => io.disconnect() };
    };

    const render = () => [
        topbar({
            title: 'Event Log',
            back: '',
            backTitle: app.poolName(),
            trailing: barButton({ label: 'Refresh', iconName: 'refresh', onClick: () => { reload(); loadUsers(); } })
        }),
        filterBar(),
        h('main', { class: 'page', style: { '--page-width': '880px' } },
            emptyState(),
            events.length ? h('ul', { class: 'event-list' }, events.map(row)) : null,
            endRow(),
            h('div', { ref: watchEnd, 'data-key': 'sentinel', 'aria-hidden': 'true', style: { height: '1px' } }))
    ];

    const redraw = renderer(root, render);
    document.title = 'Event Log';
    redraw();
    loadUsers();
    reload();
    return () => {
        generation += 1;
        if (observer) {
            observer.disconnect();
        }
    };
};
