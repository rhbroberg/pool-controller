// What a guest's link and QR code open: /join?name=…&code=… (and the hash form). The code signs
// the guest in once to choose a password; once it has one, or without a code, the link opens
// the sign-in with the guest's name filled in. On an iPhone with Pool Status installed, the
// page hands the same name and code to the app so it adds the site and signs in there too.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { ApiError } from '../api.js';
import { errorMessageOf } from '../types.js';
import { topbar, renderer } from '../ui.js';
import { mountSignIn } from './sign-in.js';

type JoinState = 'trying' | 'choosing' | 'used' | 'failed';

/** the custom URL the Pool Status app registers for a guest's link */
export const appJoinURL = (origin: string, name: string, code: string) => {
    const params = new URLSearchParams({ server: origin, name });
    if (code) {
        params.set('code', code);
    }
    return `poolstatus://join?${params}`;
};

const isApplePhone = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);

/**
 * asks Pool Status to take over when it's installed. Universal Links do this without Safari
 * when the site’s apple-app-site-association is in place; this custom URL covers installs that
 * only have the app scheme. The web sign-in below still runs if the app doesn’t open.
 **/
const openInApp = (name: string, code: string) => {
    if (!isApplePhone() || !name) {
        return;
    }
    const url = appJoinURL(location.origin, name, code);
    const link = document.createElement('a');
    link.href = url;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
};

export const mountJoin = (root: any, app: any, query: URLSearchParams) => {
    const { store } = app;
    const name = (query.get('name') || '').trim();
    const code = query.get('code') || '';

    openInApp(name, code);

    if (store.credentials) {
        if (store.credentials.email === name || !name) {
            location.replace('#/');
            return null;
        }
        return askToSwitch(root, app, name);
    }

    // trying, choosing (the set-password sheet is open), used, or an error's message
    let state: JoinState = code ? 'trying' : 'used';
    let failure: string | null = null;

    const notice = () => {
        if (!name) {
            return 'This link doesn’t name an account. Sign in, or ask for a new link.';
        }
        switch (state) {
        case 'trying': return `Signing in as ${name}…`;
        case 'choosing': return store.commissioning
            ? `Choose a password for ${name} to finish.`
            : `Open the link again to choose a password for ${name}.`;
        case 'used': return code
            ? `${name} has already chosen a password. Sign in with it.`
            : `Sign in as ${name} with the password you chose.`;
        default: return failure;
        }
    };

    const unmount = mountSignIn(root, app, { name, notice });
    if (name && code) {
        store.signInAsGuest(name, code)
            .then(() => { state = 'choosing'; })
            .catch((error: unknown) => {
                state = error instanceof ApiError && error.status === 409 ? 'used' : 'failed';
                failure = errorMessageOf(error) ?? null;
            })
            .finally(() => store.changed());
    }
    return unmount;
};

/** someone else is signed in on this browser: sign out and carry on with the link, or stay */
const askToSwitch = (root: any, app: any, name: string) => {
    const { store } = app;
    const render = () => [
        topbar({ title: app.poolName() }),
        h('main', { class: 'page' },
            h('div', { class: 'form' },
                h('div', { class: 'card notice', role: 'status' }, icon('qr'),
                    `This link is for ${name}, but ${store.credentials ? store.credentials.email : 'someone else'} is signed in on this browser.`),
                h('div', { class: 'form-group' },
                    // signing out shows this page again, signed out, which carries on with the link
                    h('button', { class: 'form-row action', type: 'button', onClick: () => store.signOut({ endSession: true }) }, `Sign Out and Continue as ${name}`),
                    h('a', { class: 'form-row', href: '#/' }, h('span', null, `Stay Signed In as ${store.credentials ? store.credentials.email : ''}`), icon('chevronRight')))))
    ];
    const redraw = renderer(root, render);
    const unsubscribe = store.subscribe(redraw);
    document.title = app.poolName();
    redraw();
    return unsubscribe;
};
