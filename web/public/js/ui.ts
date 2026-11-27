// Pieces shared by the pages: the top bar, form sections and small controls.

import { h, patch } from './dom.js';
import { icon } from './icons.js';

export const navigate = (route: string) => {
    const hash = `#/${route}`;
    if (location.hash !== hash) {
        location.hash = hash;
    }
};

export const spinner = (size = '') => h('span', { class: ['spinner', size], role: 'progressbar', 'aria-label': 'Loading' });

/**
 * the bar across the top of a page; back is the route of the page this one came from
 **/
export const topbar = ({ title, back, backTitle = 'Back', leading, trailing }: {
    title?: any;
    back?: string;
    backTitle?: string;
    leading?: any;
    trailing?: any;
}) => h('header', { class: 'topbar' },
    h('div', { class: 'topbar-leading' },
        back !== undefined
            ? h('a', { class: 'bar-button', href: `#/${back}`, 'aria-label': backTitle }, icon('chevronLeft'), h('span', null, backTitle))
            : null,
        leading),
    h('h1', { class: 'topbar-title' }, title),
    h('div', { class: 'topbar-trailing' }, trailing));

/**
 * where a page opened from more than one place goes back to: the equipment for ?from=equipment,
 * and otherwise fallback, a topbar's { back, backTitle }
 **/
export const backTo = (query: URLSearchParams | null | undefined, fallback: { back: string; backTitle: string }) => query && query.get('from') === 'equipment'
    ? { back: 'equipment', backTitle: 'Equipment' }
    : fallback;

export const barButton = ({ label, iconName, onClick, disabled = false, strong = false, showLabel = !iconName }: {
    label?: string;
    iconName?: string;
    onClick?: (event?: any) => void;
    disabled?: boolean;
    strong?: boolean;
    showLabel?: boolean;
}) => h('button', {
    class: ['bar-button', strong ? 'strong' : ''],
    type: 'button',
    onClick,
    disabled,
    title: label,
    'aria-label': label
}, iconName ? icon(iconName) : null, showLabel ? label : null);

/** the bar across the top of a dialog sheet, with its cancel and confirm buttons */
export const sheetHeader = ({ title, leading, trailing }: { title?: any; leading?: any; trailing?: any }) => h('div', { class: 'sheet-header' },
    h('div', null, leading),
    h('h2', null, title),
    h('div', { class: 'end' }, trailing));

export const signInPrompt = (text: string, onClick: () => void) => h('button', { class: 'button sign-in-prompt', type: 'button', onClick },
    icon('lock'), text);

/**
 * a grouped list of rows, as in an iOS form, with an optional header and footer
 **/
export const formSection = ({ header, footer, footerClass = '' }: { header?: any; footer?: any; footerClass?: string } = {}, ...rows: any[]) => h('section', { class: 'form-section' },
    header ? h('h2', { class: 'form-header' }, header) : null,
    h('div', { class: 'form-group' }, ...rows),
    footer ? h('div', { class: ['form-footer', footerClass] }, footer) : null);

export const formRow = (...children: any[]) => h('div', { class: 'form-row' }, ...children);

export const linkRow = (title: string, href: string) => h('a', { class: 'form-row', href }, h('span', null, title), icon('chevronRight'));

export const actionRow = (title: string, onClick: () => void, { destructive = false, disabled = false, busy = false }: { destructive?: boolean; disabled?: boolean; busy?: boolean } = {}) => h('button', {
    class: ['form-row', destructive ? 'destructive' : 'action'],
    type: 'button',
    onClick,
    disabled: disabled || busy
}, h('span', null, title), busy ? h('span', { style: { marginLeft: 'auto' } }, spinner('small')) : null);

export const textInput = ({ label, value, onInput, type = 'text', autocomplete, placeholder, trailing = false, disabled = false, onEnter, name }: {
    label?: string;
    value?: any;
    onInput?: (v: any) => void;
    type?: string;
    autocomplete?: string;
    placeholder?: string;
    trailing?: boolean;
    disabled?: boolean;
    onEnter?: () => void;
    name?: string;
}) => h('input', {
    type,
    value,
    placeholder: placeholder ?? label,
    'aria-label': label,
    autocomplete,
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    class: trailing ? 'trailing' : '',
    disabled,
    name,
    onInput: (event: any) => onInput && onInput(event.target.value),
    onKeydown: onEnter ? (event: any) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            onEnter();
        }
    } : null
});

/**
 * which of a view's password fields show what's typed, by label; toggling one redraws
 **/
export const revealer = (redraw: () => void) => {
    const shown = new Set<string>();
    return {
        shown: (key: string) => shown.has(key),
        toggle: (key: string) => {
            if (!shown.delete(key)) {
                shown.add(key);
            }
            redraw();
        }
    };
};

/** a password field with an eye button that shows what's typed; reveal comes from revealer */
export const passwordInput = ({ reveal, ...options }: {
    reveal: { shown: (k: string) => boolean; toggle: (k: string) => void };
    label?: string;
    value?: any;
    onInput?: (v: any) => void;
    autocomplete?: string;
    placeholder?: string;
    trailing?: boolean;
    disabled?: boolean;
    onEnter?: () => void;
    name?: string;
}) => {
    const shown = reveal.shown(options.label || '');
    return h('span', { class: 'password-input' },
        textInput({ ...options, type: shown ? 'text' : 'password' }),
        h('button', {
            class: 'reveal-button',
            type: 'button',
            title: shown ? 'Hide password' : 'Show password',
            'aria-label': shown ? 'Hide password' : 'Show password',
            'aria-pressed': String(shown),
            // keeps the focus, and the caret, in the field
            onMousedown: (event: any) => event.preventDefault(),
            onClick: () => reveal.toggle(options.label || '')
        }, icon(shown ? 'eyeOff' : 'eye')));
};

export const select = ({ label, value, options, onChange, disabled = false }: {
    label?: string;
    value?: any;
    options: { value: any; label: any }[];
    onChange: (value: any) => void;
    disabled?: boolean;
}) => h('select', {
    'aria-label': label,
    value,
    disabled,
    onChange: (event: any) => onChange(event.target.value)
}, options.map((option) => h('option', { value: option.value }, option.label)));

/**
 * keeps a page drawn from its view's state: the returned redraw() patches render() into root,
 * at most once per turn of the event loop
 **/
export const renderer = (root: any, render: () => any) => {
    let queued = false;
    return () => {
        if (queued) {
            return;
        }
        queued = true;
        queueMicrotask(() => {
            queued = false;
            if (root.isConnected) {
                patch(root, render());
            }
        });
    };
};
