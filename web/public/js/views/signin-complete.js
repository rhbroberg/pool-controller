// Where a sign-in through a service comes back to: it either signs in with the ticket it brought
// or says why it didn't, such as waiting for an admin's approval.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { signInOutcome } from '../model.js';
import { topbar, spinner, renderer } from '../ui.js';

export const mountSignInComplete = (root, app, query) => {
    const { store } = app;
    const outcome = signInOutcome(query);
    let working = Boolean(outcome.ticket);
    let failure = null;

    // the ticket is spent once used; keep it out of the history and off the screen
    history.replaceState(null, '', '#/signin/complete');

    const render = () => [
        topbar({ title: 'Sign In', back: 'settings', backTitle: 'Settings' }),
        h('main', { class: 'page' },
            working
                ? h('div', { class: 'center-message' }, spinner('large'), 'Signing in…')
                : h('div', { class: 'center-message' },
                    icon(failure || outcome.failed ? 'warning' : outcome.linked ? 'check' : 'lock'),
                    h('h2', null, failure ? 'Couldn’t Sign In' : outcome.title),
                    failure || outcome.message,
                    h('a', { href: '#/settings' }, 'Go to Settings')))
    ];

    const redraw = renderer(root, render);
    document.title = 'Sign In';
    redraw();

    if (outcome.ticket) {
        store.signInWithTicket(outcome.ticket)
            .then(() => location.replace('#/settings'))
            .catch((error) => {
                failure = error.message;
                working = false;
                redraw();
            });
    }
    if (outcome.linked) {
        store.refreshAccount();
    }
    return () => {};
};
