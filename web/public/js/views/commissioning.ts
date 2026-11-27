import { errorMessageOf } from '../types.js';
// Shown after signing in with the default admin / admin account, which must be renamed and given a
// new password before it can change anything, and after a guest signs in with the code in its
// link, which must choose a password.

import { h, openDialog } from '../dom.js';
import { DEFAULT_ADMIN, MINIMUM_PASSWORD_LENGTH } from '../model.js';
import { formSection, formRow, sheetHeader, textInput, passwordInput, revealer, spinner } from '../ui.js';

const openCommissioning = (store: any) => {
    const guest = store.commissioning.guest ? store.commissioning.email : null;
    let name = guest || '';
    let password = '';
    let confirmation = '';
    let saving = false;
    let errorMessage: any = null;

    /** why the entries can't be saved yet, once something has been typed */
    const problem = () => {
        if (!guest && name.trim().toLowerCase() === DEFAULT_ADMIN) {
            return `Choose an account name other than ${DEFAULT_ADMIN}.`;
        }
        if (password && password.length < MINIMUM_PASSWORD_LENGTH) {
            return `Use at least ${MINIMUM_PASSWORD_LENGTH} characters for the password.`;
        }
        if (confirmation && confirmation !== password) {
            return 'The passwords don’t match.';
        }
        return null;
    };

    const canSave = () => name.trim() && password.length >= MINIMUM_PASSWORD_LENGTH && password === confirmation && !problem() && !saving;

    const save = async () => {
        if (!canSave()) {
            return;
        }
        saving = true;
        errorMessage = null;
        dialog.update();
        try {
            await store.commission(name.trim(), password);
        } catch (error) {
            errorMessage = errorMessageOf(error);
        } finally {
            saving = false;
            dialog.update();
        }
    };

    const reveal = revealer(() => dialog.update());
    const field = (label: any, value: any, set: any, type: any, autocomplete: any) => formRow((type === 'password' ? passwordInput : textInput)({
        reveal,
        label,
        type,
        value,
        autocomplete,
        onInput: (v: any) => { set(v); dialog.update(); },
        onEnter: save
    }));

    const render = () => {
        const message = errorMessage || problem();
        return [
            sheetHeader({
                title: guest ? 'Choose a Password' : 'Set Up Account',
                leading: h('button', { class: 'bar-button', type: 'button', disabled: saving, onClick: () => store.cancelCommissioning() }, 'Cancel'),
                trailing: saving ? spinner() : h('button', { class: 'bar-button strong', type: 'button', disabled: !canSave(), onClick: save }, 'Save')
            }),
            h('form', { class: 'sheet-content form', onSubmit: (event: any) => { event.preventDefault(); save(); } },
                formSection({}, h('p', { class: 'sheet-intro' }, guest
                    ? `Welcome, ${guest}. Choose a password for this account. From now on you sign in with it, and the link you used no longer does.`
                    : `This server still has its default ${DEFAULT_ADMIN} account. Choose your own account name and password. Once you save, ${DEFAULT_ADMIN} / ${DEFAULT_ADMIN} no longer signs in.`)),
                formSection({ header: 'Your Account', footer: message, footerClass: 'error' },
                    guest
                        // a hidden name field lets the browser save the password under it
                        ? formRow(h('span', { class: 'label' }, 'Account Name'), h('span', { class: 'value' }, guest),
                            h('input', { type: 'text', name: 'username', autocomplete: 'username', value: guest, hidden: true, readonly: true }))
                        : field('Account Name', name, (v: any) => { name = v; }, 'text', 'username'),
                    field('New Password', password, (v: any) => { password = v; }, 'password', 'new-password'),
                    field('Confirm Password', confirmation, (v: any) => { confirmation = v; }, 'password', 'new-password')))
        ];
    };

    const dialog = openDialog(render, { className: 'sheet', dismissable: false });
    return dialog;
};

/** opens the set-up sheet whenever the store is commissioning, wherever the page is */
export const watchCommissioning = (app: any) => {
    let dialog: any = null;
    return app.store.subscribe(() => {
        if (app.store.commissioning && !dialog) {
            dialog = openCommissioning(app.store);
            dialog.closed.then(() => { dialog = null; });
        } else if (!app.store.commissioning && dialog) {
            dialog.close();
            dialog = null;
        }
    });
};
