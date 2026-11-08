// Settings: the pool's name, the account signed in, and the way to history and administration.

import { h } from '../dom.js';
import { DEFAULT_POOL_NAME, roleInfo, passwordProblem, passwordAcceptable } from '../model.js';
import { RECONNECT_CHOICES, DEFAULT_RECONNECT_SECONDS } from '../store.js';
import { formatDurationSeconds } from '../format.js';
import * as prefs from '../prefs.js';
import { topbar, barButton, navigate, formSection, formRow, linkRow, actionRow, textInput, select, spinner, renderer } from '../ui.js';

export const mountSettings = (root, app) => {
    const { store } = app;
    let poolName = prefs.read('poolName', DEFAULT_POOL_NAME);
    let email = '';
    let password = '';
    let signingIn = false;
    let signInError = null;

    const setPoolName = (value) => {
        poolName = value;
        prefs.write('poolName', value.trim() || DEFAULT_POOL_NAME);
        app.settingsChanged();
    };

    const setReconnect = (value) => {
        prefs.write('reconnectSeconds', Number(value));
        // the new interval applies to the wait already under way
        store.startPolling();
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
            email = '';
        } catch (error) {
            signInError = error.message;
        } finally {
            signingIn = false;
            redraw();
        }
    };

    const poolSection = () => formSection({
        header: 'Pool',
        footer: 'This page reaches the pool server through the web service it came from. The server it talks to is set where the web service is installed.'
    },
    formRow(h('label', { for: 'pool-name' }, 'Name'),
        h('input', {
            id: 'pool-name',
            class: 'trailing',
            value: poolName,
            placeholder: DEFAULT_POOL_NAME,
            autocomplete: 'off',
            onInput: (event) => setPoolName(event.target.value),
            onBlur: () => {
                if (!poolName.trim()) {
                    poolName = DEFAULT_POOL_NAME;
                    redraw();
                }
            }
        })),
    formRow(h('span', { class: 'label' }, 'Server'), h('span', { class: 'value' }, app.apiServer || '—')),
    formRow(h('label', { class: 'label' }, 'Retry Every'),
        select({
            label: 'Retry Every',
            value: String(prefs.read('reconnectSeconds', DEFAULT_RECONNECT_SECONDS)),
            options: RECONNECT_CHOICES.map((seconds) => ({ value: String(seconds), label: formatDurationSeconds(seconds) })),
            onChange: setReconnect
        })));

    const accountSection = () => {
        const credentials = store.credentials;
        if (credentials) {
            const role = roleInfo(credentials.role);
            return formSection({ header: 'Account' },
                formRow(h('span', { class: 'label' }, 'Signed In'), h('span', { class: 'value' }, role ? `${credentials.email} · ${role.title}` : credentials.email)),
                linkRow('Change Password', '#/settings/password'),
                actionRow('Sign Out', () => store.signOut({ endSession: true }), { destructive: true }));
        }
        // a form, so the browser offers to save and fill the password
        return h('form', {
            onSubmit: (event) => {
                event.preventDefault();
                signIn();
            }
        }, formSection({
            header: 'Account',
            footer: signInError || 'Signing in lets you change equipment, water flow and the controller’s settings. Status is visible without an account.',
            footerClass: signInError ? 'error' : ''
        },
        formRow(textInput({ label: 'Account Name', name: 'username', value: email, autocomplete: 'username', onInput: (v) => { email = v; redraw(); } })),
        formRow(textInput({ label: 'Password', name: 'password', type: 'password', value: password, autocomplete: 'current-password', onInput: (v) => { password = v; redraw(); } })),
        h('button', { class: 'form-row action', type: 'submit', disabled: !email.trim() || !password || signingIn },
            h('span', null, 'Sign In'),
            signingIn ? h('span', { style: { marginLeft: 'auto' } }, spinner('small')) : null)));
    };

    const historySection = () => formSection({ header: store.isAdmin ? 'History & Administration' : 'History' },
        linkRow('Event Log', '#/events'),
        store.isAdmin ? linkRow('Accounts', '#/accounts') : null,
        store.isAdmin ? linkRow('Server Maintenance', '#/maintenance') : null);

    const render = () => [
        topbar({
            title: 'Settings',
            back: '',
            backTitle: app.poolName(),
            trailing: barButton({ label: 'Done', strong: true, onClick: () => navigate('') })
        }),
        h('main', { class: 'page' },
            h('div', { class: 'form' }, poolSection(), accountSection(), historySection()))
    ];

    const redraw = renderer(root, render);
    const unsubscribe = store.subscribe(redraw);
    const unwatch = app.onSettingsChanged(redraw);
    document.title = 'Settings';
    redraw();
    return () => {
        unsubscribe();
        unwatch();
    };
};

/** any signed-in account changing its own password */
export const mountChangePassword = (root, app) => {
    const { store } = app;
    let current = '';
    let password = '';
    let confirmation = '';
    let saving = false;
    let errorMessage = null;

    const canSave = () => current && passwordAcceptable(password, confirmation) && !saving;

    const save = async () => {
        if (!canSave()) {
            return;
        }
        saving = true;
        errorMessage = null;
        redraw();
        try {
            await store.changePassword(current, password);
            navigate('settings');
        } catch (error) {
            errorMessage = error.message;
        } finally {
            saving = false;
            redraw();
        }
    };

    const render = () => {
        const problem = errorMessage || passwordProblem(password, confirmation);
        const field = (label, value, set, autocomplete) => formRow(textInput({
            label,
            type: 'password',
            value,
            autocomplete,
            onInput: (v) => { set(v); redraw(); },
            onEnter: save
        }));
        return [
            topbar({
                title: 'Change Password',
                back: 'settings',
                backTitle: 'Settings',
                trailing: saving ? spinner() : barButton({ label: 'Save', strong: true, disabled: !canSave(), onClick: save })
            }),
            h('main', { class: 'page' },
                store.credentials
                    ? h('form', { class: 'form', onSubmit: (event) => { event.preventDefault(); save(); } },
                        h('input', { type: 'text', name: 'username', autocomplete: 'username', value: store.credentials.email, hidden: true, readonly: true }),
                        formSection({}, field('Current Password', current, (v) => { current = v; }, 'current-password')),
                        formSection({
                            footer: problem || 'Other devices signed in to this account will need to sign in again.',
                            footerClass: problem ? 'error' : ''
                        },
                        field('New Password', password, (v) => { password = v; }, 'new-password'),
                        field('Confirm Password', confirmation, (v) => { confirmation = v; }, 'new-password')))
                    : h('div', { class: 'center-message' }, 'Sign in to change your password.', h('a', { href: '#/settings' }, 'Go to Settings')))
        ];
    };

    const redraw = renderer(root, render);
    const unsubscribe = store.subscribe(redraw);
    document.title = 'Change Password';
    redraw();
    return unsubscribe;
};
