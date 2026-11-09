// Admin: every account on the server, with ways to add, change and remove them, and the people
// waiting to be let in through a sign-in service.

import { h, openDialog, confirmAction } from '../dom.js';
import { icon } from '../icons.js';
import { ROLES, roleInfo, passwordProblem, passwordAcceptable, methodNames } from '../model.js';
import { relative } from '../format.js';
import { topbar, barButton, formSection, formRow, textInput, select, sheetHeader, spinner, renderer, navigate } from '../ui.js';

const roleOptions = ROLES.map((r) => ({ value: r.id, label: r.title }));

const byName = (a, b) => a.email.localeCompare(b.email, undefined, { sensitivity: 'base' });

const notAdmin = (store) => h('div', { class: 'center-message' },
    icon('lock'),
    store.credentials ? 'Only admins can manage accounts.' : 'Sign in as an admin to manage accounts.',
    h('a', { href: '#/settings' }, 'Go to Settings'));

export const mountAccounts = (root, app) => {
    const { store, client } = app;
    let accounts = [];
    let requests = [];
    let invitations = [];
    let services = [];
    // the role chosen for each request before it's approved
    const approvalRoles = {};
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
            // requests, invitations and services are extras an older server doesn't have
            const [list, waiting, invited, signIn] = await Promise.all([
                client.listAccounts(token()),
                client.listRequests(token()).catch(() => []),
                client.listInvitations(token()).catch(() => []),
                client.fetchSignInSettings(token()).catch(() => null)
            ]);
            accounts = list.sort(byName);
            requests = waiting;
            invitations = invited;
            services = signIn ? signIn.providers : [];
            errorMessage = null;
        } catch (error) {
            errorMessage = error.message;
        } finally {
            isLoading = false;
            redraw();
        }
    };

    const act = async (work) => {
        try {
            await work();
            errorMessage = null;
        } catch (error) {
            errorMessage = error.message;
        }
        redraw();
    };

    const approve = (request) => act(async () => {
        const created = await client.approveRequest(request.id, approvalRoles[request.id] || 'viewer', token());
        requests = requests.filter((r) => r.id !== request.id);
        accounts = [...accounts, created].sort(byName);
    });

    const deny = async (request) => {
        const confirmed = await confirmAction({
            title: `Deny ${request.name || request.email || 'this request'}?`,
            message: `They won’t be able to sign in with ${request.providerName}, and won’t be asked about again unless you forget the request.`,
            action: 'Deny',
            destructive: true
        });
        if (confirmed) {
            await act(async () => {
                const denied = await client.denyRequest(request.id, token());
                requests = requests.map((r) => r.id === request.id ? { ...denied, lastSeen: r.lastSeen, firstSeen: r.firstSeen } : r);
            });
        }
    };

    const forget = (request) => act(async () => {
        await client.forgetRequest(request.id, token());
        requests = requests.filter((r) => r.id !== request.id);
    });

    const withdraw = (invitation) => act(async () => {
        await client.deleteInvitation(invitation.id, token());
        invitations = invitations.filter((i) => i.id !== invitation.id);
    });

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
        const created = await openNewAccount(app, services);
        if (created && created.invitation) {
            invitations = [...invitations, created.invitation].sort((a, b) => a.email.localeCompare(b.email));
            redraw();
        } else if (created) {
            accounts = [...accounts.filter((a) => a.email !== created.email), created].sort(byName);
            redraw();
        }
    };

    const requestRow = (request) => formRow(h('div', { class: 'request-row' },
        h('div', { class: 'row-text' },
            h('span', null, request.name || request.email || 'Someone'),
            h('small', null, [
                request.name && request.email ? request.email : null,
                request.providerName,
                `asked ${relative(request.lastSeen)}`,
                request.attempts > 1 ? `${request.attempts} times` : null
            ].filter(Boolean).join(' · '))),
        h('div', { class: 'request-actions' },
            select({
                label: `Role for ${request.name || request.email}`,
                value: approvalRoles[request.id] || 'viewer',
                options: roleOptions,
                onChange: (v) => { approvalRoles[request.id] = v; redraw(); }
            }),
            h('button', { class: 'button small prominent', type: 'button', onClick: () => approve(request) }, 'Approve'),
            h('button', { class: 'button small', type: 'button', onClick: () => deny(request) }, 'Deny'))));

    const deniedRow = (request) => formRow(h('div', { class: 'request-row' },
        h('div', { class: 'row-text' },
            h('span', null, request.name || request.email || 'Someone'),
            h('small', null, [request.name && request.email ? request.email : null, request.providerName].filter(Boolean).join(' · '))),
        h('div', { class: 'request-actions' },
            h('button', { class: 'button small', type: 'button', onClick: () => forget(request) }, 'Forget'))));

    const invitationRow = (invitation) => formRow(h('div', { class: 'account-row', style: { flex: 1, minWidth: 0 } },
        h('div', { class: 'row-text' },
            h('span', null, invitation.email),
            h('small', null, `${invitation.providerName || 'Any trusted service'} · invited by ${invitation.createdBy}`)),
        h('span', { class: 'role' }, roleInfo(invitation.role) ? roleInfo(invitation.role).title : invitation.role),
        h('button', {
            class: 'icon-button',
            type: 'button',
            title: `Withdraw ${invitation.email}’s invitation`,
            'aria-label': `Withdraw ${invitation.email}’s invitation`,
            onClick: () => withdraw(invitation)
        }, icon('trash'))));

    const pending = () => requests.filter((request) => request.status === 'pending');
    const denied = () => requests.filter((request) => request.status === 'denied');

    const row = (account) => {
        const isYou = store.credentials && account.email === store.credentials.email;
        const notes = [isYou ? 'You' : null, services.length ? methodNames(account.methods, services).join(', ') : null].filter(Boolean).join(' · ');
        return formRow(h('div', { class: 'account-row', style: { flex: 1, minWidth: 0 } },
            h('a', { class: 'row-link', href: `#/accounts/${encodeURIComponent(account.email)}` },
                h('div', { class: 'row-text' },
                    h('span', null, account.email),
                    account.mustChangeCredentials ? h('small', { class: 'warning' }, 'Not set up yet') : notes ? h('small', null, notes) : null),
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
                pending().length ? formSection({
                    header: `Waiting for Approval (${pending().length})`,
                    footer: 'These people signed in with a service but have no account. Approving one creates their account with the role chosen; they’re signed in the next time they sign in.'
                }, ...pending().map(requestRow)) : null,
                accounts.length
                    ? formSection({
                        header: pending().length || invitations.length ? 'Accounts' : null,
                        footer: 'Viewers can only look; operators can also change equipment, water flow and panel settings; admins can also manage accounts and the server.'
                    }, ...accounts.map(row))
                    : isLoading ? h('div', { class: 'center-message' }, spinner('large')) : null,
                invitations.length ? formSection({
                    header: 'Invitations',
                    footer: 'The first sign-in with one of these verified email addresses creates the account with the role shown.'
                }, ...invitations.map(invitationRow)) : null,
                denied().length ? formSection({
                    header: 'Denied',
                    footer: 'Turned away without asking again. Forget a request to let the person ask again.'
                }, ...denied().map(deniedRow)) : null))
    ];

    const redraw = renderer(root, render);
    const unsubscribe = store.subscribe(redraw);
    document.title = 'Accounts';
    redraw();
    load();
    return unsubscribe;
};

/**
 * admin: add an account with a password, or invite an email address to sign in with a service;
 * resolves with the new account, { invitation }, or nothing if cancelled
 **/
const openNewAccount = (app, services) => {
    const { store, client } = app;
    const trusted = services.filter((service) => service.trustEmail);
    let method = 'password';
    let name = '';
    let password = '';
    let confirmation = '';
    let email = '';
    let service = '';
    let role = 'user';
    let saving = false;
    let errorMessage = null;

    const inviting = () => method === 'invitation';
    const canAdd = () => !saving && (inviting()
        ? /^[^@\s]+@[^@\s]+$/.test(email.trim())
        : name.trim() && passwordAcceptable(password, confirmation));

    const add = async (close) => {
        if (!canAdd()) {
            return;
        }
        saving = true;
        errorMessage = null;
        dialog.update();
        const token = store.credentials ? store.credentials.token : '';
        try {
            close(inviting()
                ? { invitation: await client.createInvitation({ email: email.trim(), role, provider: service || null }, token) }
                : await client.createAccount(name.trim(), password, role, token));
        } catch (error) {
            errorMessage = error.message;
        } finally {
            saving = false;
            dialog.update();
        }
    };

    const render = (close) => {
        const message = errorMessage || (inviting() ? null : passwordProblem(password, confirmation));
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
                title: inviting() ? 'Invite' : 'Add Account',
                leading: h('button', { class: 'bar-button', type: 'button', onClick: () => close() }, 'Cancel'),
                trailing: saving ? spinner() : h('button', { class: 'bar-button strong', type: 'button', disabled: !canAdd(), onClick: () => add(close) }, inviting() ? 'Invite' : 'Add')
            }),
            h('div', { class: 'sheet-content form' },
                trusted.length ? formSection({
                    footer: inviting()
                        ? 'No password to share: the first sign-in with this verified email address creates the account.'
                        : null
                },
                formRow(h('span', { class: 'label' }, 'Signs In With'), select({
                    label: 'Signs In With',
                    value: method,
                    options: [{ value: 'password', label: 'Password' }, { value: 'invitation', label: 'A Service (Invitation)' }],
                    onChange: (v) => { method = v; errorMessage = null; dialog.update(); }
                }))) : null,
                inviting()
                    ? formSection({ footer: message, footerClass: 'error' },
                        field('Email Address', email, (v) => { email = v; }, 'text', 'email'),
                        formRow(h('span', { class: 'label' }, 'Service'), select({
                            label: 'Service',
                            value: service,
                            options: [{ value: '', label: 'Any of Them' }, ...trusted.map((s) => ({ value: s.id, label: s.displayName }))],
                            onChange: (v) => { service = v; dialog.update(); }
                        })))
                    : formSection({ footer: message, footerClass: 'error' },
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
    let services = [];

    const token = () => store.credentials ? store.credentials.token : '';

    const load = async () => {
        if (!store.isAdmin) {
            loading = false;
            redraw();
            return;
        }
        try {
            const [list, signIn] = await Promise.all([client.listAccounts(token()), client.fetchSignInSettings(token()).catch(() => null)]);
            services = signIn ? signIn.providers : [];
            account = list.find((a) => a.email === name) || null;
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
        const hasPassword = !account.methods || account.methods.includes('password');
        return h('div', { class: 'form' },
            account.methods && services.length ? formSection({},
                formRow(h('span', { class: 'label' }, 'Signs In With'), h('span', { class: 'value' }, methodNames(account.methods, services).join(', ') || 'Nothing yet'))) : null,
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
                header: hasPassword ? 'Reset Password' : 'Set a Password',
                footer: problem || (hasPassword
                    ? `${account.email} is signed out everywhere and must sign in with the new password.`
                    : `${account.email} signs in with a service. A password lets them sign in without it too.`),
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
