// Admin: every account on the server, with ways to add, change and remove them.

import { h, openDialog, confirmAction } from '../dom.js';
import { icon } from '../icons.js';
import { ROLES, roleInfo, passwordProblem, passwordAcceptable } from '../model.js';
import { topbar, barButton, formSection, formRow, textInput, select, sheetHeader, spinner, renderer, navigate } from '../ui.js';

const byName = (a, b) => a.email.localeCompare(b.email, undefined, { sensitivity: 'base' });

const notAdmin = (store) => h('div', { class: 'center-message' },
    icon('lock'),
    store.credentials ? 'Only admins can manage accounts.' : 'Sign in as an admin to manage accounts.',
    h('a', { href: '#/settings' }, 'Go to Settings'));

export const mountAccounts = (root, app) => {
    const { store, client } = app;
    let accounts = [];
    let isLoading = false;
    let errorMessage = null;

    const token = () => store.credentials ? store.credentials.token : '';

    const load = async () => {
        if (!store.isAdmin) {
            return;
        }
        isLoading = true;
        redraw();
        try {
            accounts = (await client.listAccounts(token())).sort(byName);
            errorMessage = null;
        } catch (error) {
            errorMessage = error.message;
        } finally {
            isLoading = false;
            redraw();
        }
    };

    const remove = async (account) => {
        const confirmed = await confirmAction({
            title: `Remove ${account.email}?`,
            message: 'The account is deleted and signed out everywhere.',
            action: 'Remove Account',
            destructive: true
        });
        if (!confirmed) {
            return;
        }
        try {
            await client.deleteAccount(account.email, token());
            accounts = accounts.filter((a) => a.email !== account.email);
            errorMessage = null;
        } catch (error) {
            errorMessage = error.message;
        }
        redraw();
    };

    const add = async () => {
        const created = await openNewAccount(app);
        if (created) {
            accounts = [...accounts.filter((a) => a.email !== created.email), created].sort(byName);
            redraw();
        }
    };

    const row = (account) => {
        const isYou = store.credentials && account.email === store.credentials.email;
        return formRow(h('div', { class: 'account-row', style: { flex: 1, minWidth: 0 } },
            h('a', { class: 'row-link', href: `#/accounts/${encodeURIComponent(account.email)}` },
                h('div', { class: 'row-text' },
                    h('span', null, account.email),
                    account.mustChangeCredentials ? h('small', { class: 'warning' }, 'Not set up yet') : isYou ? h('small', null, 'You') : null),
                h('span', { class: 'role' }, roleInfo(account.role) ? roleInfo(account.role).title : account.role),
                icon('chevronRight')),
            isYou ? h('span', { style: { width: '32px' } }) : h('button', {
                class: 'icon-button',
                type: 'button',
                title: `Remove ${account.email}`,
                'aria-label': `Remove ${account.email}`,
                onClick: () => remove(account)
            }, icon('trash'))));
    };

    const render = () => [
        topbar({
            title: 'Accounts',
            back: 'settings',
            backTitle: 'Settings',
            trailing: store.isAdmin ? [
                barButton({ label: 'Refresh', iconName: 'refresh', onClick: load, disabled: isLoading }),
                barButton({ label: 'Add Account', iconName: 'plus', onClick: add })
            ] : null
        }),
        h('main', { class: 'page' },
            !store.isAdmin ? notAdmin(store) : h('div', { class: 'form' },
                errorMessage ? h('div', { class: 'card error-note', role: 'alert' }, icon('warning'), errorMessage) : null,
                accounts.length
                    ? formSection({
                        footer: 'Viewers can only look; operators can also change equipment, water flow and panel settings; admins can also manage accounts and the server.'
                    }, ...accounts.map(row))
                    : isLoading ? h('div', { class: 'center-message' }, spinner('large')) : null))
    ];

    const redraw = renderer(root, render);
    const unsubscribe = store.subscribe(redraw);
    document.title = 'Accounts';
    redraw();
    load();
    return unsubscribe;
};

/** admin: add an account; resolves with the new account, or nothing if cancelled */
const openNewAccount = (app) => {
    const { store, client } = app;
    let name = '';
    let password = '';
    let confirmation = '';
    let role = 'user';
    let saving = false;
    let errorMessage = null;

    const canAdd = () => name.trim() && passwordAcceptable(password, confirmation) && !saving;

    const add = async (close) => {
        if (!canAdd()) {
            return;
        }
        saving = true;
        errorMessage = null;
        dialog.update();
        try {
            close(await client.createAccount(name.trim(), password, role, store.credentials ? store.credentials.token : ''));
        } catch (error) {
            errorMessage = error.message;
        } finally {
            saving = false;
            dialog.update();
        }
    };

    const render = (close) => {
        const message = errorMessage || passwordProblem(password, confirmation);
        const field = (label, value, set, type, autocomplete) => formRow(textInput({
            label,
            type,
            value,
            autocomplete,
            onInput: (v) => { set(v); dialog.update(); },
            onEnter: () => add(close)
        }));
        return [
            sheetHeader({
                title: 'Add Account',
                leading: h('button', { class: 'bar-button', type: 'button', onClick: () => close() }, 'Cancel'),
                trailing: saving ? spinner() : h('button', { class: 'bar-button strong', type: 'button', disabled: !canAdd(), onClick: () => add(close) }, 'Add')
            }),
            h('div', { class: 'sheet-content form' },
                formSection({ footer: message, footerClass: 'error' },
                    field('Account Name', name, (v) => { name = v; }, 'text', 'off'),
                    field('Password', password, (v) => { password = v; }, 'password', 'new-password'),
                    field('Confirm Password', confirmation, (v) => { confirmation = v; }, 'password', 'new-password')),
                formSection({ footer: roleInfo(role).summary },
                    formRow(h('span', { class: 'label' }, 'Role'), select({
                        label: 'Role',
                        value: role,
                        options: ROLES.map((r) => ({ value: r.id, label: r.title })),
                        onChange: (v) => { role = v; dialog.update(); }
                    }))))
        ];
    };

    const dialog = openDialog(render, { className: 'sheet' });
    return dialog.result;
};

/** admin: change one account's role or reset its password */
export const mountAccountDetail = (root, app, name) => {
    const { store, client } = app;
    let account = null;
    let role = null;
    let password = '';
    let confirmation = '';
    let saving = false;
    let loading = true;
    let message = null;
    let failed = false;

    const token = () => store.credentials ? store.credentials.token : '';

    const load = async () => {
        if (!store.isAdmin) {
            loading = false;
            redraw();
            return;
        }
        try {
            account = (await client.listAccounts(token())).find((a) => a.email === name) || null;
            role = account ? account.role : null;
            if (!account) {
                failed = true;
                message = `There’s no account named ${name}.`;
            }
        } catch (error) {
            failed = true;
            message = error.message;
        } finally {
            loading = false;
            redraw();
        }
    };

    const save = async (changes) => {
        saving = true;
        message = null;
        redraw();
        try {
            const result = await client.updateAccount(account.email, changes, token());
            account = result;
            role = result.role;
            failed = false;
            message = changes.password ? 'Password reset.' : `${account.email} is now ${roleInfo(result.role).withArticle}.`;
            password = '';
            confirmation = '';
            if (store.credentials && account.email === store.credentials.email) {
                await store.refreshAccount();
            }
        } catch (error) {
            failed = true;
            message = error.message;
        } finally {
            saving = false;
            redraw();
        }
    };

    const resetPassword = async () => {
        const confirmed = await confirmAction({
            title: `Reset ${account.email}’s password?`,
            message: `${account.email} is signed out on every device and must sign in with the new password.`,
            action: 'Reset Password',
            destructive: true
        });
        if (confirmed) {
            save({ password });
        }
    };

    const field = (label, value, set) => formRow(textInput({
        label,
        type: 'password',
        value,
        autocomplete: 'new-password',
        onInput: (v) => { set(v); redraw(); }
    }));

    const details = () => {
        const problem = passwordProblem(password, confirmation);
        return h('div', { class: 'form' },
            formSection({ footer: roleInfo(role).summary },
                formRow(h('span', { class: 'label' }, 'Role'), select({
                    label: 'Role',
                    value: role,
                    disabled: saving,
                    options: ROLES.map((r) => ({ value: r.id, label: r.title })),
                    onChange: (v) => { role = v; redraw(); }
                })),
                h('button', { class: 'form-row action', type: 'button', disabled: role === account.role || saving, onClick: () => save({ role }) }, 'Save Role')),
            formSection({
                header: 'Reset Password',
                footer: problem || `${account.email} is signed out everywhere and must sign in with the new password.`,
                footerClass: problem ? 'error' : ''
            },
            field('New Password', password, (v) => { password = v; }),
            field('Confirm Password', confirmation, (v) => { confirmation = v; }),
            h('button', { class: 'form-row action', type: 'button', disabled: !passwordAcceptable(password, confirmation) || saving, onClick: resetPassword }, 'Reset Password')),
            message ? formSection({}, h('div', { class: ['message-box', failed ? 'error-text' : 'secondary'] }, message)) : null);
    };

    const render = () => [
        topbar({ title: name, back: 'accounts', backTitle: 'Accounts', trailing: saving ? spinner() : null }),
        h('main', { class: 'page' },
            !store.isAdmin && !loading ? notAdmin(store)
                : loading ? h('div', { class: 'center-message' }, spinner('large'))
                    : account ? details()
                        : h('div', { class: 'center-message' }, message, h('a', { href: '#/accounts', onClick: () => navigate('accounts') }, 'Back to Accounts')))
    ];

    const redraw = renderer(root, render);
    const unsubscribe = store.subscribe(redraw);
    document.title = name;
    redraw();
    load();
    return unsubscribe;
};
