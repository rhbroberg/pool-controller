// Admin: every account on the server, with ways to add, change and remove them, guests with their
// QR codes, accounts that have expired and been archived, and the people waiting to be let in
// through a sign-in service.

import { errorMessageOf } from '../types.js';
import { h, openDialog, confirmAction } from '../dom.js';
import { icon } from '../icons.js';
import { ROLES, GUEST_DAYS, roleInfo, passwordProblem, passwordAcceptable, methodNames, accountNote } from '../model.js';
import { relative, formatMonthDayYear, formatMonthDayYearTime, localInputValue } from '../format.js';
import { topbar, barButton, formSection, formRow, actionRow, textInput, passwordInput, revealer, select, sheetHeader, spinner, renderer, navigate } from '../ui.js';
import { openGuestQr, copyQr } from './guest-qr.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** a datetime-local input's value as a Date, or null when it's empty or not a time */
const inputDate = (value: string) => {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
};

/** when an account expires, as a datetime-local input; empty for never */
const expiryField = (value: string, set: (value: string) => void, { disabled = false } = {}) => formRow(
    h('label', { for: 'account-expires' }, 'Expires'),
    h('input', {
        id: 'account-expires',
        type: 'datetime-local',
        value,
        min: localInputValue(new Date()),
        disabled,
        style: { marginLeft: 'auto' },
        onInput: (event: Event) => set((event.target as HTMLInputElement).value)
    }));

const roleOptions = ROLES.map((r) => ({ value: r.id, label: r.title }));

const byName = (a: any, b: any) => a.email.localeCompare(b.email, undefined, { sensitivity: 'base' });

const notAdmin = (store: any) => h('div', { class: 'center-message' },
    icon('lock'),
    store.credentials ? 'Only admins can manage accounts.' : 'Sign in as an admin to manage accounts.',
    h('a', { href: '#/settings' }, 'Go to Settings'));

export const mountAccounts = (root: any, app: any) => {
    const { store, client } = app;
    let accounts: any[] = [];
    let requests: any[] = [];
    let invitations: any[] = [];
    let services: any[] = [];
    // the role chosen for each request before it's approved
    const approvalRoles: Record<string, string> = {};
    let isLoading = false;
    let errorMessage: string | null = null;
    // what the last action did, such as copying a QR code
    let notice: string | null = null;
    let showArchived = false;
    let deletingArchived = false;

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
            errorMessage = errorMessageOf(error) ?? null;
        } finally {
            isLoading = false;
            redraw();
        }
    };

    const act = async (work: () => Promise<void>) => {
        try {
            await work();
            errorMessage = null;
        } catch (error) {
            errorMessage = errorMessageOf(error) ?? null;
        }
        redraw();
    };

    const approve = (request: any) => act(async () => {
        const created = await client.approveRequest(request.id, approvalRoles[request.id] || 'viewer', token());
        requests = requests.filter((r) => r.id !== request.id);
        accounts = [...accounts, created].sort(byName);
    });

    const deny = async (request: any) => {
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

    const forget = (request: any) => act(async () => {
        await client.forgetRequest(request.id, token());
        requests = requests.filter((r) => r.id !== request.id);
    });

    const withdraw = (invitation: any) => act(async () => {
        await client.deleteInvitation(invitation.id, token());
        invitations = invitations.filter((i) => i.id !== invitation.id);
    });

    const remove = async (account: any) => {
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
            errorMessage = errorMessageOf(error) ?? null;
        }
        redraw();
    };

    const add = async () => {
        const created: any = await openNewAccount(app, services);
        if (created && created.invitation) {
            invitations = [...invitations, created.invitation].sort((a, b) => a.email.localeCompare(b.email));
            redraw();
        } else if (created) {
            accounts = [...accounts.filter((a) => a.email !== created.email), created].sort(byName);
            redraw();
        }
    };

    const addGuest = async () => {
        const guest: any = await openNewGuest(app);
        if (guest) {
            accounts = [...accounts, guest].sort(byName);
            notice = null;
            redraw();
            openGuestQr(guest);
        }
    };

    const copy = async (account: any) => {
        try {
            notice = (await copyQr(account)) === 'image' ? `Copied ${account.email}’s QR code.` : `Copied ${account.email}’s link.`;
            errorMessage = null;
        } catch {
            errorMessage = 'Couldn’t copy. Open the QR code and copy its link instead.';
        }
        redraw();
    };

    const deleteArchived = async () => {
        const count = archived().length;
        const confirmed = await confirmAction({
            title: `Delete ${count} archived ${count === 1 ? 'account' : 'accounts'}?`,
            message: 'They’re removed for good. Archived accounts already can’t sign in.',
            action: 'Delete',
            destructive: true
        });
        if (!confirmed) {
            return;
        }
        deletingArchived = true;
        redraw();
        await act(async () => {
            await client.deleteArchivedAccounts(token());
            accounts = accounts.filter((account) => !account.archivedAt);
        });
        deletingArchived = false;
        redraw();
    };

    const requestRow = (request: any) => formRow(h('div', { class: 'request-row' },
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

    const deniedRow = (request: any) => formRow(h('div', { class: 'request-row' },
        h('div', { class: 'row-text' },
            h('span', null, request.name || request.email || 'Someone'),
            h('small', null, [request.name && request.email ? request.email : null, request.providerName].filter(Boolean).join(' · '))),
        h('div', { class: 'request-actions' },
            h('button', { class: 'button small', type: 'button', onClick: () => forget(request) }, 'Forget'))));

    const invitationRow = (invitation: any) => formRow(h('div', { class: 'account-row', style: { flex: 1, minWidth: 0 } },
        h('div', { class: 'row-text' },
            h('span', null, invitation.email),
            h('small', null, `${invitation.providerName || 'Any trusted service'} · invited by ${invitation.createdBy}`)),
        h('span', { class: 'role' }, (roleInfo(invitation.role)?.title) || invitation.role),
        h('button', {
            class: 'icon-button',
            type: 'button',
            title: `Withdraw ${invitation.email}’s invitation`,
            'aria-label': `Withdraw ${invitation.email}’s invitation`,
            onClick: () => withdraw(invitation)
        }, icon('trash'))));

    const pending = () => requests.filter((request) => request.status === 'pending');
    const denied = () => requests.filter((request) => request.status === 'denied');
    const active = () => accounts.filter((account) => !account.archivedAt);
    const archived = () => accounts.filter((account) => account.archivedAt);

    const row = (account: any) => {
        const isYou = store.credentials && account.email === store.credentials.email;
        const status = accountNote(account, { relative, formatDate: formatMonthDayYear });
        const notes = [
            isYou ? 'You' : null,
            status && !status.warning ? status.text : null,
            services.length && !account.archivedAt ? methodNames(account.methods, services).join(', ') : null
        ].filter(Boolean).join(' · ');
        const guestActions = account.guest && !account.archivedAt
            ? [h('button', {
                class: 'link-button qr-link-button',
                type: 'button',
                title: `Show ${account.email}’s QR code`,
                onClick: () => openGuestQr(account)
            }, icon('qr'), 'QR Code'),
            h('button', {
                class: ['icon-button', 'accent'],
                type: 'button',
                title: `Copy ${account.email}’s QR code`,
                'aria-label': `Copy ${account.email}’s QR code`,
                onClick: () => copy(account)
            }, icon('copy'))]
            : [];
        return formRow(h('div', { class: ['account-row', account.archivedAt ? 'archived' : ''], style: { flex: 1, minWidth: 0 } },
            h('a', { class: 'row-link', href: `#/accounts/${encodeURIComponent(account.email)}` },
                h('div', { class: 'row-text' },
                    h('span', null, account.email),
                    status && status.warning ? h('small', { class: 'warning' }, status.text) : notes ? h('small', null, notes) : null),
                h('span', { class: 'role' }, (roleInfo(account.role)?.title) || account.role),
                icon('chevronRight')),
            ...guestActions,
            isYou ? h('span', { style: { width: '32px' } }) : h('button', {
                class: 'icon-button',
                type: 'button',
                title: `Remove ${account.email}`,
                'aria-label': `Remove ${account.email}`,
                onClick: () => remove(account)
            }, icon('trash'))));
    };

    const archivedSwitch = () => formRow(
        h('label', { for: 'show-archived' }, `Show Archived${archived().length ? ` (${archived().length})` : ''}`),
        h('button', {
            id: 'show-archived',
            class: ['switch', showArchived ? 'on' : ''],
            type: 'button',
            role: 'switch',
            'aria-checked': String(showArchived),
            style: { marginLeft: 'auto' },
            onClick: () => { showArchived = !showArchived; redraw(); }
        }, h('span', { class: 'knob' })));

    const render = () => [
        topbar({
            title: 'Accounts',
            back: 'maintenance',
            backTitle: 'Server Maintenance',
            trailing: store.isAdmin ? [
                barButton({ label: 'Refresh', iconName: 'refresh', onClick: load, disabled: isLoading }),
                barButton({ label: 'Add Guest', iconName: 'userPlus', onClick: addGuest }),
                barButton({ label: 'Add Account', iconName: 'plus', onClick: add })
            ] : null
        }),
        h('main', { class: 'page' },
            !store.isAdmin ? notAdmin(store) : h('div', { class: 'form' },
                errorMessage ? h('div', { class: 'card error-note', role: 'alert' }, icon('warning'), errorMessage) : null,
                notice && !errorMessage ? h('div', { class: 'card notice', role: 'status' }, icon('check'), notice) : null,
                pending().length ? formSection({
                    header: `Waiting for Approval (${pending().length})`,
                    footer: 'These people signed in with a service but have no account. Approving one creates their account with the role chosen; they’re signed in the next time they sign in.'
                }, ...pending().map(requestRow)) : null,
                accounts.length
                    ? formSection({
                        header: pending().length || invitations.length ? 'Accounts' : null,
                        footer: 'Viewers can only look; operators can also change equipment, water flow and panel settings; admins can also manage accounts and the server. Add Guest makes an operator for a week, with a QR code that lets them in to choose a password.'
                    }, ...active().map(row))
                    : isLoading ? h('div', { class: 'center-message' }, spinner('large')) : null,
                accounts.length ? formSection({
                    footer: 'Accounts are archived once they expire, and can’t sign in after that.'
                }, archivedSwitch()) : null,
                showArchived && archived().length ? formSection({ header: 'Archived' },
                    ...archived().map(row),
                    actionRow('Delete Archived Accounts', deleteArchived, { destructive: true, busy: deletingArchived })) : null,
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
const openNewAccount = (app: any, services: any) => {
    const { store, client } = app;
    const trusted = services.filter((service: any) => service.trustEmail);
    let method = 'password';
    let name = '';
    let password = '';
    let confirmation = '';
    let email = '';
    let service = '';
    let role = 'user';
    // empty for an account that doesn't expire
    let expires = '';
    let saving = false;
    let errorMessage: any = null;
    const reveal = revealer(() => dialog.update());

    const inviting = () => method === 'invitation';
    const expiresAt = () => role === 'admin' ? null : inputDate(expires);
    const canAdd = () => !saving && (inviting()
        ? /^[^@\s]+@[^@\s]+$/.test(email.trim())
        : name.trim() && passwordAcceptable(password, confirmation));

    const add = async (close: any) => {
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
                : await client.createAccount(name.trim(), password, role, token, expiresAt()));
        } catch (error) {
            errorMessage = errorMessageOf(error) ?? null;
        } finally {
            saving = false;
            dialog.update();
        }
    };

    const render = (close: any) => {
        const message = errorMessage || (inviting() ? null : passwordProblem(password, confirmation));
        const field = (label: any, value: any, set: any, type: any, autocomplete: any) => formRow((type === 'password' ? passwordInput : textInput)({
            reveal,
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
                        field('Email Address', email, (v: any) => { email = v; }, 'text', 'email'),
                        formRow(h('span', { class: 'label' }, 'Service'), select({
                            label: 'Service',
                            value: service,
                            options: [{ value: '', label: 'Any of Them' }, ...trusted.map((s: any) => ({ value: s.id, label: s.displayName }))],
                            onChange: (v: any) => { service = v; dialog.update(); }
                        })))
                    : formSection({ footer: message, footerClass: 'error' },
                        field('Account Name', name, (v: any) => { name = v; }, 'text', 'off'),
                        field('Password', password, (v: any) => { password = v; }, 'password', 'new-password'),
                        field('Confirm Password', confirmation, (v: any) => { confirmation = v; }, 'password', 'new-password')),
                formSection({ footer: roleInfo(role)!.summary },
                    formRow(h('span', { class: 'label' }, 'Role'), select({
                        label: 'Role',
                        value: role,
                        options: ROLES.map((r) => ({ value: r.id, label: r.title })),
                        onChange: (v: any) => { role = v; dialog.update(); }
                    }))),
                inviting() ? null : formSection({
                    footer: role === 'admin'
                        ? 'Admins don’t expire.'
                        : 'Optional. Once it passes, the account is archived and can’t sign in. Leave it empty for an account that lasts.'
                }, expiryField(role === 'admin' ? '' : expires, (v) => { expires = v; dialog.update(); }, { disabled: role === 'admin' })))
        ];
    };

    const dialog = openDialog(render, { className: 'sheet' });
    return dialog.result;
};

/**
 * admin: add a guest, an operator with a generated name and a QR code that lets them in once to
 * choose a password; resolves with the new guest, or nothing if cancelled
 **/
const openNewGuest = (app: any) => {
    const { store, client } = app;
    let expires = localInputValue(new Date(Date.now() + GUEST_DAYS * DAY_MS));
    let saving = false;
    let errorMessage: string | null = null;

    const add = async (close: (value?: unknown) => void) => {
        saving = true;
        errorMessage = null;
        dialog.update();
        try {
            close(await client.createGuest(inputDate(expires), store.credentials ? store.credentials.token : ''));
        } catch (error) {
            errorMessage = errorMessageOf(error) ?? null;
        } finally {
            saving = false;
            dialog.update();
        }
    };

    const render = (close: (value?: unknown) => void) => {
        const expiry = inputDate(expires);
        return [
            sheetHeader({
                title: 'Add Guest',
                leading: h('button', { class: 'bar-button', type: 'button', onClick: () => close() }, 'Cancel'),
                trailing: saving ? spinner() : h('button', { class: 'bar-button strong', type: 'button', onClick: () => add(close) }, 'Add')
            }),
            h('div', { class: 'sheet-content form' },
                formSection({}, h('p', { class: 'sheet-intro' },
                    'A guest is an operator with a made-up name, such as sunny-otter, and no password. Its QR code lets them in once, from a phone’s camera or the Pool Status app, to choose one.')),
                formSection({
                    footer: errorMessage || (expiry
                        ? `Archived ${relative(expiry)}, ${formatMonthDayYearTime(expiry)}.`
                        : 'Leave it empty for a guest that lasts.'),
                    footerClass: errorMessage ? 'error' : ''
                }, expiryField(expires, (v: string) => { expires = v; dialog.update(); })))
        ];
    };

    const dialog = openDialog(render, { className: 'sheet' });
    return dialog.result;
};

/** admin: one account's dates, and changing its role, expiry or password */
export const mountAccountDetail = (root: any, app: any, name: string) => {
    const { store, client } = app;
    let account: any = null;
    let role: string | null = null;
    // the expiry being edited, as a datetime-local value; empty for never
    let expires = '';
    let password = '';
    let confirmation = '';
    let saving = false;
    let loading = true;
    let message: any = null;
    let failed = false;
    let services: any[] = [];

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
            account = list.find((a: any) => a.email === name) || null;
            role = account ? account.role : null;
            expires = account && account.expiresAt ? localInputValue(new Date(account.expiresAt)) : '';
            if (!account) {
                failed = true;
                message = `There’s no account named ${name}.`;
            }
        } catch (error) {
            failed = true;
            message = errorMessageOf(error) ?? null;
        } finally {
            loading = false;
            redraw();
        }
    };

    const save = async (changes: any) => {
        saving = true;
        message = null;
        redraw();
        try {
            const result = await client.updateAccount(account.email, changes, token());
            account = result;
            role = result.role;
            expires = result.expiresAt ? localInputValue(new Date(result.expiresAt)) : '';
            failed = false;
            if (changes.password) {
                message = 'Password reset.';
            } else if (changes.expiresAt !== undefined) {
                message = result.expiresAt ? `${account.email} expires ${formatMonthDayYearTime(new Date(result.expiresAt))}.` : `${account.email} no longer expires.`;
            } else {
                message = `${account.email} is now ${roleInfo(result.role)!.withArticle}.`;
            }
            password = '';
            confirmation = '';
            if (store.credentials && account.email === store.credentials.email) {
                await store.refreshAccount();
            }
        } catch (error) {
            failed = true;
            message = errorMessageOf(error) ?? null;
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

    const reveal = revealer(() => redraw());
    const field = (label: any, value: any, set: any) => formRow(passwordInput({
        reveal,
        label,
        value,
        autocomplete: 'new-password',
        onInput: (v) => { set(v); redraw(); }
    }));

    const dateRow = (label: string, value: any, never = 'Never') => formRow(h('span', { class: 'label' }, label),
        h('span', { class: 'value' }, value ? formatMonthDayYearTime(new Date(value)) : never));

    const datesSection = () => formSection({ header: 'History' },
        dateRow('Created', account.createdAt, '—'),
        dateRow('First Signed In', account.firstSignInAt),
        dateRow('Last Signed In', account.lastSignInAt),
        account.archivedAt ? dateRow('Archived', account.archivedAt) : null);

    const expirySection = () => {
        if (account.role === 'admin') {
            return formSection({ header: 'Expires', footer: 'Admins don’t expire.' },
                formRow(h('span', { class: 'label' }, 'Expires'), h('span', { class: 'value' }, 'Never')));
        }
        const chosen = inputDate(expires);
        const current = account.expiresAt ? new Date(account.expiresAt).getTime() : null;
        const unchanged = chosen ? chosen.getTime() === current : current === null;
        return formSection({
            header: 'Expires',
            footer: 'Once it passes, the account is archived and can’t sign in. Leave it empty for an account that lasts.'
        },
        expiryField(expires, (v: string) => { expires = v; redraw(); }, { disabled: saving }),
        h('button', { class: 'form-row action', type: 'button', disabled: unchanged || saving, onClick: () => save({ expiresAt: chosen }) },
            chosen || !current ? 'Save Expiry' : 'Never Expire'));
    };

    const guestSection = () => account.guest && !account.archivedAt ? formSection({
        footer: account.setupCode
            ? `${account.email} hasn’t used its link yet. The QR code lets them in once to choose a password.`
            : `${account.email} has chosen a password. The QR code now opens the sign-in with the name filled in.`
    }, h('button', { class: 'form-row action', type: 'button', onClick: () => openGuestQr(account) }, 'Show QR Code')) : null;

    const details = () => {
        const problem = passwordProblem(password, confirmation);
        const hasPassword = !account.methods || account.methods.includes('password');
        if (account.archivedAt) {
            return h('div', { class: 'form' },
                datesSection(),
                formSection({}, h('div', { class: 'message-box secondary' },
                    `${account.email} expired and was archived, so it can’t sign in or be changed. Remove it from Accounts once it’s no longer needed.`)));
        }
        return h('div', { class: 'form' },
            guestSection(),
            datesSection(),
            account.methods && services.length ? formSection({},
                formRow(h('span', { class: 'label' }, 'Signs In With'), h('span', { class: 'value' }, methodNames(account.methods, services).join(', ') || 'Nothing yet'))) : null,
            formSection({ footer: roleInfo(role || 'viewer')!.summary },
                formRow(h('span', { class: 'label' }, 'Role'), select({
                    label: 'Role',
                    value: role,
                    disabled: saving,
                    options: ROLES.map((r) => ({ value: r.id, label: r.title })),
                    onChange: (v: any) => { role = v; redraw(); }
                })),
                h('button', { class: 'form-row action', type: 'button', disabled: role === account.role || saving, onClick: () => save({ role }) }, 'Save Role')),
            expirySection(),
            formSection({
                header: hasPassword ? 'Reset Password' : 'Set a Password',
                footer: problem || (hasPassword
                    ? `${account.email} is signed out everywhere and must sign in with the new password.`
                    : account.guest
                        ? `${account.email} hasn’t chosen a password yet. Setting one here lets them sign in with it as well as the link.`
                        : `${account.email} signs in with a service. A password lets them sign in without it too.`),
                footerClass: problem ? 'error' : ''
            },
            field('New Password', password, (v: any) => { password = v; }),
            field('Confirm Password', confirmation, (v: any) => { confirmation = v; }),
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
