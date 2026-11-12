// Settings: the pool's name, the account signed in, and the way to history and administration.
// Signing in is the sign-in page's; Settings shows only once someone has.

import { h, confirmAction } from '../dom.js';
import { icon } from '../icons.js';
import { DEFAULT_POOL_NAME, roleInfo, passwordProblem, passwordAcceptable, aboutLine } from '../model.js';
import { RECONNECT_CHOICES, DEFAULT_RECONNECT_SECONDS } from '../store.js';
import { formatDurationSeconds } from '../format.js';
import * as prefs from '../prefs.js';
import { topbar, barButton, navigate, formSection, formRow, linkRow, actionRow, passwordInput, revealer, select, spinner, renderer } from '../ui.js';

export const mountSettings = (root, app) => {
    const { store, client } = app;
    let poolName = prefs.read('poolName', DEFAULT_POOL_NAME);
    // the sign-in services the server offers; null until it says
    let choices = null;
    let pendingRequests = 0;
    let methodsError = null;
    let linking = null;
    // the pool server's build, for the about line; null until it answers
    let serverInfo = null;

    const token = () => store.credentials ? store.credentials.token : '';

    const loadChoices = async () => {
        try {
            choices = await client.fetchSignInChoices();
        } catch {
            choices = null;
        }
        redraw();
    };

    const loadServerInfo = async () => {
        try {
            serverInfo = await client.fetchSystemInfo();
            redraw();
        } catch {
            // the about line shows a dash for the server
        }
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

    const accountSection = () => {
        const credentials = store.credentials;
        if (!credentials) {
            return null;
        }
        const role = roleInfo(credentials.role);
        return [formSection({ header: 'Account', footer: 'You stay signed in on this browser until you sign out.' },
            formRow(h('span', { class: 'label' }, 'Signed In'), h('span', { class: 'value' }, role ? `${credentials.email} · ${role.title}` : credentials.email)),
            store.hasPassword ? linkRow('Change Password', '#/settings/password') : null,
            // the page goes back to the sign-in page
            actionRow('Sign Out', () => store.signOut({ endSession: true }), { destructive: true })),
        methodsSection()];
    };

    const historySection = () => formSection({
        header: store.isAdmin ? 'History & Administration' : 'History',
        footer: aboutLine(app.webCommit, serverInfo)
    },
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
    loadServerInfo();
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
    const reveal = revealer(() => redraw());

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
        const field = (label, value, set, autocomplete) => formRow(passwordInput({
            reveal,
            label,
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
