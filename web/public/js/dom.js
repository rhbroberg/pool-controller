// Builds elements and patches them into the page in place, so a view can redraw itself from
// its state on every change without losing focus, hover or a click under way.

const SVG_NS = 'http://www.w3.org/2000/svg';
// set as properties rather than attributes, so they reflect what the user has done
const PROPERTIES = new Set(['value', 'checked', 'indeterminate', 'selected']);

const listen = (element, type, handler) => {
    if (!element.__handlers) {
        element.__handlers = {};
    }
    if (!(type in element.__handlers)) {
        element.addEventListener(type, (event) => {
            const current = element.__handlers[type];
            if (current) {
                current.call(element, event);
            }
        });
    }
    element.__handlers[type] = handler;
};

const applyProps = (element, props) => {
    Object.entries(props || {}).forEach(([key, value]) => {
        if (PROPERTIES.has(key) && value !== undefined && value !== null) {
            element.__props = { ...(element.__props || {}), [key]: value };
            element[key] = value;
            return;
        }
        if (value === undefined || value === null || value === false) {
            if (key.startsWith('on')) {
                listen(element, key.slice(2).toLowerCase(), null);
            }
            return;
        }
        if (key.startsWith('on') && typeof value === 'function') {
            listen(element, key.slice(2).toLowerCase(), value);
        } else if (key === 'style' && typeof value === 'object') {
            element.setAttribute('style', Object.entries(value)
                .filter(([, v]) => v !== undefined && v !== null)
                .map(([k, v]) => `${k.startsWith('--') ? k : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${v}`)
                .join(';'));
        } else if (key === 'class' && Array.isArray(value)) {
            element.setAttribute('class', value.filter(Boolean).join(' '));
        } else if (key === 'ref' && typeof value === 'function') {
            element.__ref = value;
        } else {
            element.setAttribute(key, value === true ? '' : String(value));
        }
    });
};

const appendChildren = (element, children) => {
    children.flat(Infinity).forEach((child) => {
        if (child === null || child === undefined || child === false || child === true) {
            return;
        }
        element.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    });
};

/**
 * h('button', { class: 'tile', onClick }, 'Label') builds an HTML element; on* props are event
 * handlers, value and checked are properties, and false or null props are left off
 **/
export const h = (tag, props, ...children) => {
    const element = document.createElement(tag);
    applyProps(element, props);
    appendChildren(element, children);
    // a select's value only takes once its options are there
    Object.entries(element.__props || {}).forEach(([key, value]) => { element[key] = value; });
    return element;
};

/** the same as h, for SVG elements */
export const s = (tag, props, ...children) => {
    const element = document.createElementNS(SVG_NS, tag);
    applyProps(element, props);
    appendChildren(element, children);
    return element;
};

const sameKind = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName &&
    (a.nodeType !== 1 || a.getAttribute('data-key') === b.getAttribute('data-key'));

const updateElement = (have, want) => {
    for (const { name } of Array.from(have.attributes)) {
        if (!want.hasAttribute(name)) {
            have.removeAttribute(name);
        }
    }
    for (const { name, value } of Array.from(want.attributes)) {
        if (have.getAttribute(name) !== value) {
            have.setAttribute(name, value);
        }
    }
    const handlers = want.__handlers || {};
    Object.keys(have.__handlers || {}).forEach((type) => {
        if (!(type in handlers)) {
            have.__handlers[type] = null;
        }
    });
    Object.entries(handlers).forEach(([type, handler]) => listen(have, type, handler));
    have.__ref = want.__ref;
    // an element marked data-own has children something else manages, such as a chart
    if (!have.hasAttribute('data-own')) {
        patchChildren(have, Array.from(want.childNodes));
    }
    // a field being typed in keeps what's typed; the view's state catches up through its events
    const props = want.__props || {};
    Object.entries(props).forEach(([key, value]) => {
        if (key === 'value' && have === document.activeElement) {
            return;
        }
        if (have[key] !== value) {
            have[key] = value;
        }
    });
    have.__props = props;
};

const patchChildren = (parent, next) => {
    const wanted = [next].flat(Infinity).filter((node) => node !== null && node !== undefined && node !== false)
        .map((node) => node instanceof Node ? node : document.createTextNode(String(node)));
    wanted.forEach((want, index) => {
        const have = parent.childNodes[index];
        if (!have) {
            parent.appendChild(want);
        } else if (!sameKind(have, want)) {
            parent.replaceChild(want, have);
        } else if (have.nodeType === 3) {
            if (have.data !== want.data) {
                have.data = want.data;
            }
        } else if (have.nodeType === 1) {
            updateElement(have, want);
        }
    });
    while (parent.childNodes.length > wanted.length) {
        parent.lastChild.remove();
    }
};

/**
 * makes parent's children match next, reusing the elements already there where they're the same
 * kind, so the page keeps its state; then calls each element's ref with the element on the page
 **/
export const patch = (parent, next) => {
    patchChildren(parent, next);
    parent.querySelectorAll('*').forEach((element) => {
        if (element.__ref) {
            element.__ref(element);
        }
    });
};

// MARK: dialogs

/**
 * a modal dialog with content from render(close); resolves with what close is called with, or
 * undefined when it's dismissed. render is called again by the returned update().
 **/
export const openDialog = (render, { className = '', dismissable = true } = {}) => {
    const dialog = h('dialog', { class: ['dialog', className] });
    let resolved = false;
    let resolveResult;
    const result = new Promise((resolve) => { resolveResult = resolve; });
    const close = (value) => {
        if (resolved) {
            return;
        }
        resolved = true;
        dialog.close();
        dialog.remove();
        resolveResult(value);
    };
    const update = () => {
        if (!resolved) {
            patch(dialog, render(close));
        }
    };
    dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        if (dismissable) {
            close(undefined);
        }
    });
    dialog.addEventListener('click', (event) => {
        // a click on the backdrop lands on the dialog itself
        if (dismissable && event.target === dialog) {
            close(undefined);
        }
    });
    document.body.appendChild(dialog);
    update();
    dialog.showModal();
    return { result, update, close, element: dialog };
};

/**
 * asks before a change; resolves true when the action is chosen
 **/
export const confirmAction = ({ title, message, action, destructive = false }) => openDialog((close) => [
    h('div', { class: 'dialog-body' },
        h('h2', { class: 'dialog-title' }, title),
        message ? h('p', { class: 'dialog-message' }, message) : null),
    h('div', { class: 'dialog-actions' },
        h('button', { class: 'button', type: 'button', onClick: () => close(false) }, 'Cancel'),
        h('button', { class: ['button', destructive ? 'destructive' : 'prominent'], type: 'button', autofocus: true, onClick: () => close(true) }, action))
], { className: 'confirm' }).result.then(Boolean);
