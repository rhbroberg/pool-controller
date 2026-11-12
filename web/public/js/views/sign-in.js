// What the page shows while signed out: only the pool's sign-in, with nothing from the pool
// until it succeeds.

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { topbar, formSection, formRow, textInput, passwordInput, revealer, spinner, renderer } from '../ui.js';

export const mountSignIn = (root, app) => {
    const { store, client } = app;
    let email = store.lastAccountName || '';
    let password = '';
    let signingIn = false;
    let signInError = null;
    // what the server offers: passwords and/or services; null until it says, or if it can't
    let choices = null;
    const reveal = revealer(() => redraw());

    const loadChoices = async () => {
        try {
            choices = await client.fetchSignInChoices();
        } catch {
            choices = null;
        }
        redraw();
    };

    const signIn = async () => {
        if (!email.trim() || !password || signingIn) {
            return;
        }
        signingIn = true;
        signInError = null;
        redraw();
        try {
            await store.signIn(email.trim(), password);
            password = '';
        } catch (error) {
            signInError = error.message;
        } finally {
            signingIn = false;
            redraw();
        }
    };

    const passwordSignIn = () => !choices || choices.passwordSignIn;
    const providers = () => choices ? choices.providers : [];

    const intro = () => h('div', { class: 'card site-intro' },
        icon('waves', { className: 'site-icon' }),
        h('h2', null, app.poolName()),
        app.apiServer ? h('div', { class: 'detail' }, app.apiServer) : null);

    const expiredNotice = () => store.signInExpired
        ? h('div', { class: 'card notice expired-notice', role: 'status' }, icon('warning'), 'Your sign-in is no longer valid. Sign in again.')
        : null;

    // a form, so the browser offers to save and fill the password
    const form = () => h('form', {
        onSubmit: (event) => {
            event.preventDefault();
            signIn();
        }
    }, formSection({
        header: 'Sign In',
        footer: signInError || 'Sign in to see and control this pool. You stay signed in on this browser until you sign out.',
        footerClass: signInError ? 'error' : ''
    },
    passwordSignIn() ? formRow(textInput({ label: 'Account Name', name: 'username', value: email, autocomplete: 'username', onInput: (v) => { email = v; redraw(); } })) : null,
    passwordSignIn() ? formRow(passwordInput({ reveal, label: 'Password', name: 'password', value: password, autocomplete: 'current-password', onInput: (v) => { password = v; redraw(); }, onEnter: signIn })) : null,
    passwordSignIn() ? h('button', { class: 'form-row action', type: 'submit', disabled: !email.trim() || !password || signingIn },
        h('span', null, 'Sign In'),
        signingIn ? h('span', { style: { marginLeft: 'auto' } }, spinner('small')) : null) : null,
    ...providers().map((provider) => h('a', { class: 'form-row', href: client.signInUrl(provider.id) },
        h('span', { class: 'action-text' }, `Continue with ${provider.displayName}`),
        icon('chevronRight')))));

    const render = () => [
        topbar({ title: app.poolName() }),
        h('main', { class: 'page' },
            h('div', { class: 'form' }, intro(), expiredNotice(), form()))
    ];

    const redraw = renderer(root, render);
    const unsubscribe = store.subscribe(redraw);
    const unwatch = app.onSettingsChanged(redraw);
    document.title = `Sign In · ${app.poolName()}`;
    redraw();
    loadChoices();
    return () => {
        unsubscribe();
        unwatch();
    };
};
