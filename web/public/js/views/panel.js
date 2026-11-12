// Mirrors the controller's display and sends its menu and arrow keys: the way to every setting
// on the controller, not only the ones the page shows itself.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { ApiError, isAbort } from '../api.js';
import { PANEL_KEYS } from '../model.js';
import { formatTimeSeconds } from '../format.js';
import { topbar, signInPrompt, navigate, renderer } from '../ui.js';

const REFRESH_MS = 1000;
// time for the controller to act on a key before the display is read again
const KEY_RESPONSE_DELAY_MS = 300;
const RECENT_PRESS_LIMIT = 8;
const REPEAT_DELAY_MS = 500;
const REPEAT_INTERVAL_MS = 300;

const KEYBOARD = {
    ArrowUp: 'plus', '+': 'plus', '=': 'plus',
    ArrowDown: 'minus', '-': 'minus', _: 'minus',
    ArrowLeft: 'left', '<': 'left', ',': 'left',
    ArrowRight: 'right', '>': 'right', '.': 'right',
    Enter: 'menu', m: 'menu', M: 'menu'
};

export const mountPanel = (root, app) => {
    const { store, client } = app;
    let display = null;
    let errorMessage = null;
    // false once the server can't be reached; true while it answers, even with an error
    let reachable = true;
    // the last few presses, oldest first, so a display that lags behind isn't mistaken for a
    // press that didn't take
    let presses = [];
    let nextPressId = 0;
    let disposed = false;
    let pollTimer = null;
    let repeat = null;
    let wakeLock = null;

    const handle = (error) => {
        if (isAbort(error)) {
            return;
        }
        if (error instanceof ApiError && error.kind === 'unreachable') {
            reachable = false;
        }
        errorMessage = error.message;
    };

    const refresh = async () => {
        try {
            display = await client.fetchPanelDisplay();
            errorMessage = null;
            reachable = true;
        } catch (error) {
            if (error instanceof ApiError && error.status === 404) {
                display = null;
                errorMessage = 'The panel hasn’t sent any display text yet.';
                reachable = true;
            } else {
                handle(error);
            }
        }
        redraw();
    };

    const poll = async () => {
        if (disposed) {
            return;
        }
        if (document.visibilityState === 'visible') {
            await refresh();
        }
        if (!disposed) {
            pollTimer = setTimeout(poll, REFRESH_MS);
        }
    };

    const mark = (id, delivery) => {
        presses = presses.map((press) => press.id === id && press.delivery === 'sending' ? { ...press, delivery } : press);
    };

    const press = async (key) => {
        const credentials = store.credentials;
        if (!credentials || !store.canControl) {
            return;
        }
        const id = nextPressId++;
        presses = [...presses, { id, key, delivery: 'sending' }].slice(-RECENT_PRESS_LIMIT);
        redraw();
        try {
            await client.pressPanelKey(key, credentials.token);
            mark(id, 'queued');
            redraw();
            await new Promise((resolve) => setTimeout(resolve, KEY_RESPONSE_DELAY_MS));
            await refresh();
        } catch (error) {
            mark(id, 'failed');
            if (error instanceof ApiError && error.kind === 'unauthorized') {
                errorMessage = 'Your sign-in is no longer valid. Sign in again to use the panel keys.';
                store.expire();
            } else if (error instanceof ApiError && error.status === 403) {
                store.refreshAccount();
                errorMessage = 'Your account can’t press the panel keys.';
            } else {
                handle(error);
            }
            redraw();
        }
    };

    // + and − press once on touch, then repeat while held, as when stepping a value
    const startRepeat = (key) => {
        stopRepeat();
        press(key);
        const timer = setTimeout(function again() {
            press(key);
            repeat.timer = setTimeout(again, REPEAT_INTERVAL_MS);
        }, REPEAT_DELAY_MS);
        repeat = { timer, key };
        redraw();
    };

    const stopRepeat = () => {
        if (repeat) {
            clearTimeout(repeat.timer);
            repeat = null;
            redraw();
        }
    };

    const access = () => {
        if (!store.credentials) {
            return 'signedOut';
        }
        if (!store.canControl) {
            return 'viewOnly';
        }
        return reachable ? 'ready' : 'unreachable';
    };

    const onKeydown = (event) => {
        if (event.metaKey || event.ctrlKey || event.altKey || access() !== 'ready') {
            return;
        }
        if (event.target instanceof HTMLElement && event.target.closest('input, select, textarea, dialog')) {
            return;
        }
        const key = KEYBOARD[event.key];
        if (!key) {
            return;
        }
        // Enter on a focused pad key already clicks it
        if (event.key === 'Enter' && event.target instanceof HTMLElement && event.target.closest('button, a')) {
            return;
        }
        event.preventDefault();
        if (!event.repeat || key === 'plus' || key === 'minus') {
            press(key);
        }
    };

    // MARK: pieces

    const lcd = () => {
        if (!display) {
            return h('div', { class: 'lcd', role: 'status', 'aria-label': errorMessage || 'Waiting for the panel' },
                h('div', { class: 'lcd-message' }, errorMessage || 'Waiting for the panel…'));
        }
        const lines = display.lines.map((line, index) => {
            const blinking = new Set(display.blinking[index] || []);
            const characters = [...line].map((character, position) => blinking.has(position)
                ? h('span', { class: 'blink' }, character)
                : character);
            return h('div', { class: 'lcd-line' }, characters);
        });
        return h('div', {
            class: 'lcd',
            role: 'status',
            'aria-label': display.lines.map((line) => line.trim()).join(', ')
        }, lines);
    };

    const keyTrail = () => {
        if (!presses.length) {
            return h('div', { class: 'key-trail' });
        }
        const chip = (p) => h('span', { class: ['key-chip', p.delivery], 'data-key': String(p.id) },
            PANEL_KEYS[p.key].label,
            p.delivery === 'sending' ? icon('clock') : p.delivery === 'failed' ? icon('x') : null);
        const spoken = presses.map((p) => `${PANEL_KEYS[p.key].title}${p.delivery === 'queued' ? '' : `, ${p.delivery}`}`).join(', ');
        return h('div', { class: 'key-trail', 'aria-label': `Recent keys: ${spoken}` },
            h('span', { class: 'secondary' }, 'Keys'),
            h('div', { class: 'chips' }, presses.map(chip)));
    };

    const padKey = (key, className, content, repeating) => h('button', {
        class: ['dpad-key', className, repeat && repeat.key === key ? 'pressed' : ''],
        type: 'button',
        'aria-label': PANEL_KEYS[key].title,
        title: repeating ? `${PANEL_KEYS[key].title} (hold to repeat)` : PANEL_KEYS[key].title,
        onClick: repeating ? (event) => {
            // a pointer press already sent it; this is the keyboard's Enter or Space
            if (event.detail === 0) {
                press(key);
            }
        } : () => press(key),
        onPointerdown: repeating ? (event) => {
            if (event.button !== 0) {
                return;
            }
            event.preventDefault();
            try {
                event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
                // a pointer that's already gone can't be captured; the press still counts
            }
            startRepeat(key);
        } : null,
        onPointerup: repeating ? stopRepeat : null,
        onPointercancel: repeating ? stopRepeat : null,
        onLostpointercapture: repeating ? stopRepeat : null,
        onContextmenu: repeating ? (event) => event.preventDefault() : null
    }, content);

    const controls = () => {
        switch (access()) {
        case 'ready':
            return h('div', { class: 'panel-controls' },
                h('div', { class: 'dpad', role: 'group', 'aria-label': 'Panel keys' },
                    padKey('plus', 'plus', icon('plus'), true),
                    padKey('minus', 'minus', icon('minus'), true),
                    padKey('left', 'left', icon('lessThan')),
                    padKey('right', 'right', icon('greaterThan')),
                    padKey('menu', 'menu', 'MENU')),
                h('div', { class: 'panel-hint' }, 'Hold + or − to repeat.'),
                h('div', { class: 'panel-hint' },
                    'Keyboard: ', h('kbd', null, '←'), ' ', h('kbd', null, '→'), ' to move, ',
                    h('kbd', null, '↑'), ' ', h('kbd', null, '↓'), ' for + and −, ',
                    h('kbd', null, 'Enter'), ' for Menu.'));
        case 'signedOut':
            return h('div', { class: 'panel-controls' },
                h('p', { class: 'secondary', style: { margin: 0 } }, 'Sign in to press the panel keys and change the controller’s settings.'),
                signInPrompt('Sign In', () => navigate('settings')));
        case 'viewOnly':
            return h('div', { class: 'panel-controls' },
                h('div', { class: 'notice' }, icon('eye'), 'View only. Your account can watch the panel but not press its keys.'));
        default:
            return h('div', { class: 'panel-controls' },
                h('div', { class: 'notice' }, icon('wifiOff'), 'Can’t reach the server. The keys come back when it answers.'));
        }
    };

    const render = () => [
        topbar({ title: 'Panel Control', back: '', backTitle: app.poolName() }),
        h('main', { class: 'page full' },
            h('div', { class: 'panel-page' },
                h('div', { class: 'panel-display-column' },
                    lcd(),
                    display ? h('div', { class: 'secondary', style: { fontSize: '13px' } }, `Updated ${formatTimeSeconds(display.timestamp)}`) : null,
                    display && errorMessage ? h('div', { class: 'warning-line' }, icon('warning'), errorMessage) : null,
                    keyTrail()),
                controls()))
    ];

    // a session in the controller's menus shouldn't end because the screen dimmed
    const holdWakeLock = async () => {
        if (disposed || document.visibilityState !== 'visible' || !navigator.wakeLock || wakeLock) {
            return;
        }
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        } catch {
            wakeLock = null;
        }
    };

    const onVisibility = () => {
        if (document.visibilityState === 'visible') {
            holdWakeLock();
        }
    };

    const redraw = renderer(root, render);
    const unsubscribe = store.subscribe(redraw);
    const unwatch = app.onSettingsChanged(redraw);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', stopRepeat);
    document.title = 'Panel Control';
    redraw();
    poll();
    holdWakeLock();

    return () => {
        disposed = true;
        clearTimeout(pollTimer);
        stopRepeat();
        unsubscribe();
        unwatch();
        document.removeEventListener('keydown', onKeydown);
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('blur', stopRepeat);
        if (wakeLock) {
            wakeLock.release().catch(() => {});
        }
    };
};
