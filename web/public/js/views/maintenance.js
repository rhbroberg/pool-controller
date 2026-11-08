// Restart and factory reset, kept off the main Settings page because they affect the server
// rather than this page.

import { h, confirmAction } from '../dom.js';
import { DEFAULT_ADMIN } from '../model.js';
import { topbar, formSection, actionRow, renderer } from '../ui.js';

export const mountMaintenance = (root, app) => {
    const { store } = app;
    let working = false;
    let message = null;

    const run = async (action, done) => {
        working = true;
        message = null;
        redraw();
        try {
            await action();
            message = done;
        } catch (error) {
            message = error.message;
        } finally {
            working = false;
            redraw();
        }
    };

    const restart = async () => {
        const confirmed = await confirmAction({
            title: 'Restart the server?',
            message: 'Status, equipment changes and panel keys stop for everyone until it’s back, usually within a minute.',
            action: 'Restart Server'
        });
        if (confirmed) {
            run(() => store.restartServer(), 'The server is restarting. This page reconnects when it’s back.');
        }
    };

    const factoryReset = async () => {
        const confirmed = await confirmAction({
            title: 'Are you sure?',
            message: `This erases all history and accounts on the server and recreates the ${DEFAULT_ADMIN} / ${DEFAULT_ADMIN} account. It can’t be undone.`,
            action: 'Factory Reset',
            destructive: true
        });
        if (confirmed) {
            run(() => store.factoryReset(), `Factory reset complete. Sign in as ${DEFAULT_ADMIN} / ${DEFAULT_ADMIN} to set up the server.`);
        }
    };

    const render = () => {
        const disabled = !store.isAdmin || working;
        return [
            topbar({ title: 'Server Maintenance', back: 'settings', backTitle: 'Settings' }),
            h('main', { class: 'page' },
                h('div', { class: 'form' },
                    formSection({ footer: 'The server stops and its container starts it again. This page reconnects when it’s back.' },
                        actionRow('Restart Server', restart, { disabled, busy: working })),
                    formSection({ footer: `Erases all history and accounts on the server and recreates the ${DEFAULT_ADMIN} / ${DEFAULT_ADMIN} account.` },
                        actionRow('Factory Reset', factoryReset, { destructive: true, disabled })),
                    message
                        ? formSection({}, h('div', { class: 'message-box' }, message))
                        : !store.credentials
                            ? formSection({}, h('div', { class: 'message-box secondary' }, 'Sign in to restart or reset the server.'))
                            : null))
        ];
    };

    const redraw = renderer(root, render);
    const unsubscribe = store.subscribe(redraw);
    document.title = 'Server Maintenance';
    redraw();
    return unsubscribe;
};
