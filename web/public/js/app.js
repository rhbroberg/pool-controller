// Starts the page: one status store for every page, and a page for each #/route.

import { Client } from './api.js';
import { StatusStore } from './store.js';
import { DEFAULT_POOL_NAME } from './model.js';
import * as prefs from './prefs.js';
import { mountDashboard } from './views/dashboard.js';
import { mountPanel } from './views/panel.js';
import { mountTemperatureHistory } from './views/temperature-history.js';
import { mountSaltHistory } from './views/salt-history.js';
import { mountSettings, mountChangePassword } from './views/settings.js';
import { mountEventLog } from './views/event-log.js';
import { mountAccounts, mountAccountDetail } from './views/accounts.js';
import { mountMaintenance } from './views/maintenance.js';
import { mountReprocess } from './views/reprocess.js';
import { watchCommissioning } from './views/commissioning.js';
import { mountSignInComplete } from './views/signin-complete.js';
import { mountSignInSettings } from './views/sign-in-settings.js';

const ROUTES = [
    [/^$/, (root, app) => mountDashboard(root, app)],
    [/^panel$/, (root, app) => mountPanel(root, app)],
    [/^history\/(pool|spa)$/, (root, app, [water]) => mountTemperatureHistory(root, app, water)],
    [/^history\/salt$/, (root, app) => mountSaltHistory(root, app)],
    [/^settings$/, (root, app) => mountSettings(root, app)],
    [/^settings\/password$/, (root, app) => mountChangePassword(root, app)],
    [/^events$/, (root, app) => mountEventLog(root, app)],
    [/^accounts$/, (root, app) => mountAccounts(root, app)],
    [/^accounts\/(.+)$/, (root, app, [name]) => mountAccountDetail(root, app, decodeURIComponent(name))],
    [/^maintenance$/, (root, app) => mountMaintenance(root, app)],
    [/^maintenance\/reprocess$/, (root, app) => mountReprocess(root, app)],
    [/^sign-in$/, (root, app) => mountSignInSettings(root, app)],
    [/^signin\/complete$/, (root, app, _, query) => mountSignInComplete(root, app, query)]
];

const client = new Client();
const store = new StatusStore(client);
const app = {
    client,
    store,
    // which pool server the web service forwards to, for showing in Settings and when it's down
    apiServer: null,
    // the commit the web service was built from, for the about line in Settings
    webCommit: null,
    poolName: () => prefs.read('poolName', DEFAULT_POOL_NAME) || DEFAULT_POOL_NAME,
    listeners: new Set(),
    /** tells every page a setting kept by the page itself, such as the pool name, changed */
    settingsChanged() {
        this.listeners.forEach((listener) => listener());
    },
    onSettingsChanged(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
};

const root = document.getElementById('app');
let unmount = null;

const route = () => {
    const [hashPath, hashQuery = ''] = location.hash.replace(/^#\/?/, '').split('?');
    const path = decodeURI(hashPath).replace(/\/$/, '');
    let match = null;
    const found = ROUTES.find(([pattern]) => {
        match = pattern.exec(path);
        return match;
    });
    if (unmount) {
        unmount();
        unmount = null;
    }
    root.replaceChildren();
    window.scrollTo(0, 0);
    if (!found) {
        location.replace('#/');
        return;
    }
    unmount = found[1](root, app, match.slice(1), new URLSearchParams(hashQuery)) || null;
};

window.addEventListener('hashchange', route);

// polling stops while the page is hidden and starts over, with a fresh reading, when it's back
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        store.startPolling();
    } else {
        store.stopPolling();
    }
});

prefs.watch((key) => {
    if (key !== 'credentials') {
        app.settingsChanged();
    }
});

fetch('/config.json', { cache: 'no-store' })
    .then((response) => response.ok ? response.json() : null)
    .then((config) => {
        app.apiServer = config && config.apiServer ? config.apiServer : null;
        app.webCommit = config && config.webCommit ? config.webCommit : null;
        app.settingsChanged();
    })
    .catch(() => {});

watchCommissioning(app);
store.startPolling();
route();
