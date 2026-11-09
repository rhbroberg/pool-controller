// Shown after signing in with the default admin / admin account: the account must be renamed and
// given a new password before it can change anything.

import { h, openDialog } from '../dom.js';
import { DEFAULT_ADMIN, MINIMUM_PASSWORD_LENGTH } from '../model.js';
import { formSection, formRow, sheetHeader, textInput, passwordInput, revealer, spinner } from '../ui.js';

const openCommissioning = (store) => {
    let name = '';
    let password = '';
    let confirmation = '';
    let saving = false;
    let errorMessage = null;

    /** why the entries can't be saved yet, once something has been typed */
    const problem = () => {
        if (name.trim().toLowerCase() === DEFAULT_ADMIN) {
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
            errorMessage = error.message;
        } finally {
            saving = false;
            dialog.update();
        }
    };

    const reveal = revealer(() => dialog.update());
    const field = (label, value, set, type, autocomplete) => formRow((type === 'password' ? passwordInput : textInput)({
        reveal,
        label,
        type,
        value,
        autocomplete,
        onInput: (v) => { set(v); dialog.update(); },
        onEnter: save
    }));

    const render = () => {
        const message = errorMessage || problem();
        return [
            sheetHeader({
                title: 'Set Up Account',
                leading: h('button', { class: 'bar-button', type: 'button', disabled: saving, onClick: () => store.cancelCommissioning() }, 'Cancel'),
                trailing: saving ? spinner() : h('button', { class: 'bar-button strong', type: 'button', disabled: !canSave(), onClick: save }, 'Save')
            }),
            h('form', { class: 'sheet-content form', onSubmit: (event) => { event.preventDefault(); save(); } },
                formSection({}, h('p', { class: 'sheet-intro' },
                    `This server still has its default ${DEFAULT_ADMIN} account. Choose your own account name and password. Once you save, ${DEFAULT_ADMIN} / ${DEFAULT_ADMIN} no longer signs in.`)),
                formSection({ header: 'Your Account', footer: message, footerClass: 'error' },
                    field('Account Name', name, (v) => { name = v; }, 'text', 'username'),
                    field('New Password', password, (v) => { password = v; }, 'password', 'new-password'),
                    field('Confirm Password', confirmation, (v) => { confirmation = v; }, 'password', 'new-password')))
        ];
    };

    const dialog = openDialog(render, { className: 'sheet', dismissable: false });
    return dialog;
};

/** opens the set-up sheet whenever the store is commissioning, wherever the page is */
export const watchCommissioning = (app) => {
    const { store } = app;
    let dialog = null;
    store.subscribe(() => {
        if (store.commissioning && !dialog) {
            dialog = openCommissioning(store);
        } else if (!store.commissioning && dialog) {
            dialog.close();
            dialog = null;
        }
    });
};
