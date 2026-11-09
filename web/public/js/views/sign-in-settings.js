// Admin: how people sign in. Passwords on or off, whether newcomers may ask to join, and the
// OpenID Connect services (Google, Microsoft, Apple, ...) offered on the sign-in form.

import { h, openDialog, confirmAction } from '../dom.js';
import { icon } from '../icons.js';
import { SERVICE_PRESETS } from '../model.js';
import { topbar, barButton, formSection, formRow, actionRow, textInput, select, sheetHeader, spinner, renderer } from '../ui.js';

const ON_OFF = [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }];

const notAdmin = (store) => h('div', { class: 'center-message' },
    icon('lock'),
    store.credentials ? 'Only admins can change how people sign in.' : 'Sign in as an admin to change how people sign in.',
    h('a', { href: '#/settings' }, 'Go to Settings'));

export const mountSignInSettings = (root, app) => {
    const { store, client } = app;
    let settings = null;
    let isLoading = false;
    let saving = false;
    let errorMessage = null;

    const token = () => store.credentials ? store.credentials.token : '';

    const load = async () => {
        if (!store.isAdmin) {
            return;
        }
        isLoading = true;
        redraw();
        try {
            settings = await client.fetchSignInSettings(token());
            errorMessage = null;
        } catch (error) {
            errorMessage = error.status === 404
                ? 'This server doesn’t have sign-in services yet. Update it to offer Google, Microsoft or Apple sign-in.'
                : error.message;
        } finally {
            isLoading = false;
            redraw();
        }
    };

    const change = async (changes) => {
        saving = true;
        errorMessage = null;
        redraw();
        try {
            settings = await client.updateSignInSettings(changes, token());
        } catch (error) {
            errorMessage = error.message;
        } finally {
            saving = false;
            redraw();
        }
    };

    const editService = async (service) => {
        if (await openService(app, settings, service)) {
            await load();
        }
    };

    const serviceRow = (service) => h('button', { class: 'form-row', type: 'button', onClick: () => editService(service) },
        h('div', { class: 'row-text' },
            h('span', null, service.displayName),
            h('small', null, service.kind === 'apple' ? 'Sign in with Apple' : service.issuer)),
        h('span', { class: 'value' }, service.enabled ? 'On' : 'Off'),
        icon('chevronRight'));

    const details = () => h('div', { class: 'form' },
        errorMessage ? h('div', { class: 'card error-note', role: 'alert' }, icon('warning'), errorMessage) : null,
        formSection({
            header: 'Passwords',
            footer: settings.passwordSignInForced
                ? 'POOL_FORCE_PASSWORD_SIGNIN=1 is set where the server runs, so passwords work whatever this says.'
                : 'Turn passwords off once you’ve linked a service to your own account in Settings, so an admin can still sign in.'
        },
        formRow(h('span', { class: 'label' }, 'Password Sign-In'), select({
            label: 'Password Sign-In',
            value: settings.passwordSignIn ? 'on' : 'off',
            disabled: saving,
            options: ON_OFF,
            onChange: (v) => change({ passwordSignIn: v === 'on' })
        }))),
        formSection({
            header: 'Newcomers',
            footer: settings.signInRequests === 'ask'
                ? 'Someone who signs in with a service but has no account and no invitation waits in Accounts for an admin to approve them.'
                : 'Only people with an account or an invitation can sign in with a service; anyone else is turned away.'
        },
        formRow(h('span', { class: 'label' }, 'Without an Invitation'), select({
            label: 'Without an Invitation',
            value: settings.signInRequests,
            disabled: saving,
            options: [{ value: 'ask', label: 'Ask an Admin' }, { value: 'refuse', label: 'Turn Away' }],
            onChange: (v) => change({ signInRequests: v })
        }))),
        formSection({
            header: 'Services',
            footer: h('span', null,
                'Each service needs this redirect address registered with it, with the service’s id in place of {id}: ',
                h('code', { class: 'selectable' }, settings.redirectUriTemplate))
        },
        ...settings.providers.map(serviceRow),
        actionRow('Add Service', () => editService(null))));

    const render = () => [
        topbar({
            title: 'Sign-In',
            back: 'settings',
            backTitle: 'Settings',
            trailing: store.isAdmin ? (saving ? spinner() : barButton({ label: 'Refresh', iconName: 'refresh', onClick: load, disabled: isLoading })) : null
        }),
        h('main', { class: 'page' },
            !store.isAdmin ? notAdmin(store)
                : settings ? details()
                    : errorMessage ? h('div', { class: 'center-message' }, icon('warning'), errorMessage)
                        : h('div', { class: 'center-message' }, spinner('large')))
    ];

    const redraw = renderer(root, render);
    const unsubscribe = store.subscribe(redraw);
    document.title = 'Sign-In';
    redraw();
    load();
    return unsubscribe;
};

/**
 * adds a service (service null) or changes one; resolves true once something was saved
 **/
const openService = (app, settings, service) => {
    const { store, client } = app;
    const adding = !service;
    let preset = SERVICE_PRESETS[0];
    const draft = adding
        ? { id: preset.id, displayName: preset.displayName, kind: preset.kind, issuer: preset.issuer, trustEmail: preset.trustEmail, enabled: true, clientId: '', clientSecret: '', apple: { teamId: '', keyId: '', privateKey: '' } }
        : { ...service, clientSecret: '', apple: { teamId: '', keyId: '', privateKey: '', ...(service.apple || {}) } };
    let saving = false;
    let errorMessage = null;
    const token = () => store.credentials ? store.credentials.token : '';

    const choosePreset = (index) => {
        preset = SERVICE_PRESETS[Number(index)];
        Object.assign(draft, { id: preset.id, displayName: preset.displayName, kind: preset.kind, issuer: preset.issuer, trustEmail: preset.trustEmail });
        dialog.update();
    };

    const isApple = () => draft.kind === 'apple';
    const canSave = () => !saving && draft.id && draft.displayName.trim() && draft.clientId.trim() && (isApple() || draft.issuer.trim()) &&
        (!adding || !isApple() || (draft.apple.teamId && draft.apple.keyId && draft.apple.privateKey));

    const body = () => {
        const changes = {
            displayName: draft.displayName.trim(),
            clientId: draft.clientId.trim(),
            enabled: draft.enabled,
            trustEmail: draft.trustEmail
        };
        if (!isApple()) {
            changes.issuer = draft.issuer.trim();
        }
        if (draft.clientSecret) {
            changes.clientSecret = draft.clientSecret;
        }
        if (isApple()) {
            changes.apple = { teamId: draft.apple.teamId.trim(), keyId: draft.apple.keyId.trim() };
            if (draft.apple.privateKey.trim()) {
                changes.apple.privateKey = draft.apple.privateKey.trim();
            }
        }
        return adding ? { id: draft.id.trim().toLowerCase(), kind: draft.kind, ...changes } : changes;
    };

    const save = async (close) => {
        if (!canSave()) {
            return;
        }
        saving = true;
        errorMessage = null;
        dialog.update();
        try {
            if (adding) {
                await client.createSignInService(body(), token());
            } else {
                await client.updateSignInService(service.id, body(), token());
            }
            close(true);
        } catch (error) {
            errorMessage = error.message;
        } finally {
            saving = false;
            dialog.update();
        }
    };

    const remove = async (close) => {
        const confirmed = await confirmAction({
            title: `Remove ${service.displayName}?`,
            message: 'Its button leaves the sign-in form. Accounts that only sign in with it can’t sign in until it’s added back with the same id.',
            action: 'Remove Service',
            destructive: true
        });
        if (!confirmed) {
            return;
        }
        try {
            await client.deleteSignInService(service.id, token());
            close(true);
        } catch (error) {
            errorMessage = error.message;
            dialog.update();
        }
    };

    const field = (label, key, { type = 'text', placeholder, target = draft } = {}) => formRow(
        h('span', { class: 'label' }, label),
        textInput({ label, value: target[key], type, placeholder, trailing: true, autocomplete: 'off', onInput: (v) => { target[key] = v; dialog.update(); } }));

    const render = (close) => {
        const redirect = draft.id ? settings.redirectUriTemplate.replace('{id}', draft.id.trim().toLowerCase()) : null;
        return [
            sheetHeader({
                title: adding ? 'Add Service' : service.displayName,
                leading: h('button', { class: 'bar-button', type: 'button', onClick: () => close(false) }, 'Cancel'),
                trailing: saving ? spinner() : h('button', { class: 'bar-button strong', type: 'button', disabled: !canSave(), onClick: () => save(close) }, 'Save')
            }),
            h('div', { class: 'sheet-content form' },
                errorMessage ? h('div', { class: 'card error-note', role: 'alert' }, icon('warning'), errorMessage) : null,
                adding ? formSection({ footer: preset.other ? 'Any service that supports OpenID Connect discovery, such as Auth0, Okta, Keycloak or Authentik.' : null },
                    formRow(h('span', { class: 'label' }, 'Service'), select({
                        label: 'Service',
                        value: String(SERVICE_PRESETS.indexOf(preset)),
                        options: SERVICE_PRESETS.map((p, index) => ({ value: String(index), label: p.other ? 'Other OpenID Connect' : p.displayName })),
                        onChange: choosePreset
                    }))) : null,
                formSection({
                    footer: redirect ? h('span', null, 'Register this redirect address with the service: ', h('code', { class: 'selectable' }, redirect)) : null
                },
                adding ? field('ID', 'id', { placeholder: 'such as auth0' }) : null,
                field('Name', 'displayName', { placeholder: 'shown on the button' }),
                isApple() ? null : field('Issuer', 'issuer', { placeholder: 'https://…' })),
                formSection({
                    header: isApple() ? 'Apple Developer' : 'Client',
                    footer: isApple()
                        ? 'The Services ID, your team ID, and a Sign in with Apple key: its key ID and the contents of its .p8 file.'
                        : (service && service.hasClientSecret ? 'Leave the secret empty to keep the one saved.' : 'From the app or client registered with the service.')
                },
                field(isApple() ? 'Services ID' : 'Client ID', 'clientId'),
                isApple() ? null : field('Client Secret', 'clientSecret', { type: 'password', placeholder: service && service.hasClientSecret ? 'Saved' : 'Client Secret' }),
                isApple() ? field('Team ID', 'teamId', { target: draft.apple }) : null,
                isApple() ? field('Key ID', 'keyId', { target: draft.apple }) : null,
                isApple() ? formRow(h('textarea', {
                    class: 'key-input',
                    rows: 4,
                    value: draft.apple.privateKey,
                    placeholder: service && service.apple && service.apple.hasPrivateKey ? 'Saved; paste a new key to replace it' : '-----BEGIN PRIVATE KEY-----',
                    'aria-label': 'Private Key',
                    spellcheck: 'false',
                    onInput: (event) => { draft.apple.privateKey = event.target.value; dialog.update(); }
                })) : null),
                formSection({
                    footer: draft.trustEmail
                        ? 'An invitation is redeemed by the first sign-in with its email address, if the service says the address is verified.'
                        : 'Invitations don’t work with this service; newcomers wait for approval. Turn this on only for services that verify email addresses.'
                },
                formRow(h('span', { class: 'label' }, 'Trust Email Addresses'), select({
                    label: 'Trust Email Addresses',
                    value: draft.trustEmail ? 'on' : 'off',
                    options: ON_OFF,
                    onChange: (v) => { draft.trustEmail = v === 'on'; dialog.update(); }
                })),
                formRow(h('span', { class: 'label' }, 'Offer on the Sign-In Form'), select({
                    label: 'Offer on the Sign-In Form',
                    value: draft.enabled ? 'on' : 'off',
                    options: ON_OFF,
                    onChange: (v) => { draft.enabled = v === 'on'; dialog.update(); }
                }))),
                adding ? null : formSection({}, actionRow('Remove Service', () => remove(close), { destructive: true })))
        ];
    };

    const dialog = openDialog(render, { className: 'sheet' });
    return dialog.result.then(Boolean);
};
