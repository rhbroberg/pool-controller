// Settings: the pool's name, the account signed in, and the way to history and administration.

import { h, confirmAction } from '../dom.js';
import { icon } from '../icons.js';
import { DEFAULT_POOL_NAME, roleInfo, passwordProblem, passwordAcceptable } from '../model.js';
import { RECONNECT_CHOICES, DEFAULT_RECONNECT_SECONDS } from '../store.js';
import { formatDurationSeconds } from '../format.js';
import * as prefs from '../prefs.js';
import { topbar, barButton, navigate, formSection, formRow, linkRow, actionRow, textInput, select, spinner, renderer } from '../ui.js';

export const mountSettings = (root, app) => {
    const { store, client } = app;
    let poolName = prefs.read('poolName', DEFAULT_POOL_NAME);
    let email = '';
    let password = '';
    let signingIn = false;
    let signInError = null;
    // what the sign-in form offers: passwords and/or services; null until the server says
    let choices = null;
    let pendingRequests = 0;
    let methodsError = null;
    let linking = null;

    const token = () => store.credentials ? store.credentials.token : '';

    const loadChoices = async () => {
        try {
            choices = await client.fetchSignInChoices();
        } catch {
            choices = null;
        }
        redraw();
    };

    const loadPendingRequests = async () => {
        if (!store.isAdmin) {
            return;
        }
        try {
            const requests = await client.listRequests(token());
            pendingRequests = requests.filter((request) => request.status === 'pending').length;
            redraw();
        } catch {
            // the count is a hint; Accounts shows any error
        }
    };

    const link = async (provider) => {
        linking = provider.id;
        methodsError = null;
        redraw();
        try {
            const { url } = await client.linkIdentity(provider.id, token());
            location.assign(url);
        } catch (error) {
            methodsError = error.message;
            linking = null;
            redraw();
        }
    };

    const unlink = async (provider) => {
        const confirmed = await confirmAction({
            title: `Stop signing in with ${provider.displayName}?`,
            message: 'You can link it again later.',
            action: 'Unlink',
            destructive: true
        });
        if (!confirmed) {
            return;
        }
        try {
            await client.unlinkIdentity(provider.id, token());
            methodsError = null;
            await store.refreshAccount();
        } catch (error) {
            methodsError = error.message;
        }
        redraw();
    };

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

    const providers = () => choices ? choices.providers : [];

    const methodsSection = () => {
        const methods = (store.credentials && store.credentials.methods) || [];
        if (providers().length === 0) {
            return null;
        }
        return formSection({
            header: 'Sign-In Methods',
            footer: methodsError || 'Link a service to sign in with it instead of a password.',
            footerClass: methodsError ? 'error' : ''
        },
        ...providers().map((provider) => methods.includes(provider.id)
            ? formRow(h('span', { class: 'label' }, provider.displayName),
                h('span', { class: 'value' }, 'Linked'),
                h('button', { class: 'button small', type: 'button', onClick: () => unlink(provider) }, 'Unlink'))
            : actionRow(`Link ${provider.displayName}`, () => link(provider), { busy: linking === provider.id })));
    };

    const servicesSection = () => providers().length === 0 ? null : formSection({
        header: choices.passwordSignIn ? 'Or Sign In With' : 'Account',
        footer: choices.passwordSignIn ? null : 'Signing in lets you change equipment, water flow and the controller’s settings. Status is visible without an account.'
    },
    ...providers().map((provider) => h('a', { class: 'form-row', href: client.signInUrl(provider.id) },
        h('span', { class: 'action-text' }, `Continue with ${provider.displayName}`),
        icon('chevronRight'))));

    const accountSection = () => {
        const credentials = store.credentials;
        if (credentials) {
            const role = roleInfo(credentials.role);
            return [formSection({ header: 'Account' },
                formRow(h('span', { class: 'label' }, 'Signed In'), h('span', { class: 'value' }, role ? `${credentials.email} · ${role.title}` : credentials.email)),
                store.hasPassword ? linkRow('Change Password', '#/settings/password') : null,
                actionRow('Sign Out', () => store.signOut({ endSession: true }), { destructive: true })),
            methodsSection()];
        }
        if (choices && !choices.passwordSignIn) {
            return servicesSection();
        }
        // a form, so the browser offers to save and fill the password
        return [h('form', {
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
            signingIn ? h('span', { style: { marginLeft: 'auto' } }, spinner('small')) : null))),
        servicesSection()];
    };

    const historySection = () => formSection({ header: store.isAdmin ? 'History & Administration' : 'History' },
        linkRow('Event Log', '#/events'),
        store.isAdmin ? h('a', { class: 'form-row', href: '#/accounts' },
            h('span', null, 'Accounts'),
            pendingRequests > 0 ? h('span', { class: 'count-badge', title: `${pendingRequests} waiting for approval` }, String(pendingRequests)) : null,
            icon('chevronRight')) : null,
        store.isAdmin && choices ? linkRow('Sign-In', '#/sign-in') : null,
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
    let wasAdmin = store.isAdmin;
    const unsubscribe = store.subscribe(() => {
        if (store.isAdmin && !wasAdmin) {
            loadPendingRequests();
        }
        wasAdmin = store.isAdmin;
        redraw();
    });
    const unwatch = app.onSettingsChanged(redraw);
    document.title = 'Settings';
    redraw();
    loadChoices();
    loadPendingRequests();
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
