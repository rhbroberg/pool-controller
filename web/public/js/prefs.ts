// Settings and the sign-in kept in this browser, the page's equivalent of the app's
// AppStorage and keychain.

const PREFIX = 'pool.';

const memory = new Map();
const backing = () => {
    try {
        return globalThis.localStorage || null;
    } catch {
        return null;
    }
};

export const read = (key, fallback) => {
    const storage = backing();
    const text = storage ? storage.getItem(PREFIX + key) : memory.get(key);
    if (text === null || text === undefined) {
        return fallback;
    }
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
};

export const write = (key, value) => {
    const storage = backing();
    const text = JSON.stringify(value);
    if (storage) {
        try {
            storage.setItem(PREFIX + key, text);
        } catch {
            // private browsing can refuse storage; the value lasts for this page instead
            memory.set(key, text);
        }
    } else {
        memory.set(key, text);
    }
};

export const remove = (key) => {
    const storage = backing();
    if (storage) {
        storage.removeItem(PREFIX + key);
    }
    memory.delete(key);
};

/**
 * calls changed(key) when another tab changes one of these settings
 **/
export const watch = (changed) => {
    if (typeof window === 'undefined') {
        return () => {};
    }
    const listener = (event) => {
        if (event.key && event.key.startsWith(PREFIX)) {
            changed(event.key.slice(PREFIX.length));
        }
    };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
};
