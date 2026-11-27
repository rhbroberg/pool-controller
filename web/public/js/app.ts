// Starts the page: one status store for every page, and a page for each #/route.

import { Client } from './api.js';
import { StatusStore } from './store.js';
import { LiveConnection, liveUrl } from './live.js';
import { DEFAULT_POOL_NAME } from './model.js';
import * as prefs from './prefs.js';
import { mountDashboard } from './views/dashboard.js';
import { mountPanel } from './views/panel.js';
import { mountEquipment } from './views/equipment.js';
import { mountTemperatureHistory } from './views/temperature-history.js';
import { mountThermostat } from './views/thermostat.js';
import { mountSaltHistory } from './views/salt-history.js';
import { mountSettings, mountChangePassword } from './views/settings.js';
import { mountEventLog } from './views/event-log.js';
import { mountAccounts, mountAccountDetail } from './views/accounts.js';
import { mountMaintenance } from './views/maintenance.js';
import { mountReprocess } from './views/reprocess.js';
import { watchCommissioning } from './views/commissioning.js';
import { mountSignIn } from './views/sign-in.js';
import { mountSignInComplete } from './views/signin-complete.js';
import { mountSignInSettings } from './views/sign-in-settings.js';
import { mountJoin } from './views/join.js';

// a sign-in through a service comes back here, and a guest's link opens join, so they show
// whether or not anyone is signed in
const SIGNED_OUT_ROUTE = /^(signin\/complete|join)$/;
// signing out from a guest's link carries on with it, signed out
const JOIN_ROUTE = /^join$/;

type RouteHandler = (root: HTMLElement, app: any, match: string[], query: URLSearchParams) => any;
const ROUTES: [RegExp, RouteHandler][] = [
    [/^$/, (root, app) => mountDashboard(root, app)],
    [/^equipment$/, (root, app) => mountEquipment(root, app)],
    [/^panel$/, (root, app) => mountPanel(root, app)],
    [/^thermostat\/(pool|spa)$/, (root, app, [water]) => mountThermostat(root, app, water)],
    [/^history\/(pool|spa)$/, (root, app, [water]) => mountTemperatureHistory(root, app, water)],
    [/^history\/salt$/, (root, app, _, query) => mountSaltHistory(root, app, query)],
    [/^settings$/, (root, app) => mountSettings(root, app)],
    [/^settings\/password$/, (root, app) => mountChangePassword(root, app)],
    [/^events$/, (root, app) => mountEventLog(root, app)],
    [/^accounts$/, (root, app) => mountAccounts(root, app)],
    [/^accounts\/(.+)$/, (root, app, [name]) => mountAccountDetail(root, app, decodeURIComponent(name))],
    [/^maintenance$/, (root, app) => mountMaintenance(root, app)],
    [/^maintenance\/reprocess$/, (root, app) => mountReprocess(root, app)],
    [/^sign-in$/, (root, app) => mountSignInSettings(root, app)],
    [/^signin\/complete$/, (root, app, _, query) => mountSignInComplete(root, app, query)],
    [/^join$/, (root, app, _, query) => mountJoin(root, app, query)]
];

const client = new Client();
const store = new StatusStore(client, { live: new LiveConnection(liveUrl(location)) });
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
        this.listeners.forEach((listener: any) => listener());
    },
    onSettingsChanged(listener: any) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
};

const root = document.getElementById('app')!;
let unmount: (() => void) | null = null;
// whether the page on screen was drawn for someone signed in
let shownSignedIn: boolean | null = null;

const route = () => {
    const [hashPath, hashQuery = ''] = location.hash.replace(/^#\/?/, '').split('?');
    const path = decodeURI(hashPath).replace(/\/$/, '');
    let match: RegExpExecArray | null = null;
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
    shownSignedIn = Boolean(store.credentials);
    // nothing from the pool shows until someone signs in
    if (!store.credentials && !SIGNED_OUT_ROUTE.test(path)) {
        unmount = mountSignIn(root, app) || null;
        return;
    }
    if (!found) {
        location.replace('#/');
        return;
    }
    unmount = found[1](root, app, match!.slice(1), new URLSearchParams(hashQuery)) || null;
};

window.addEventListener('hashchange', route);

// signing in shows the page asked for; signing out, or a sign-in the server stops accepting,
// starts over at the sign-in page, except on a guest's link, and a service's sign-in or a
// guest's new password, once finished, opens the dashboard
store.subscribe(() => {
    const signedIn = Boolean(store.credentials);
    if (signedIn === shownSignedIn) {
        return;
    }
    const path = location.hash.replace(/^#\/?/, '').split('?')[0];
    if (!signedIn && JOIN_ROUTE.test(path)) {
        route();
        return;
    }
    if ((!signedIn || SIGNED_OUT_ROUTE.test(path)) && path !== '') {
        // the hash change routes
        location.replace('#/');
        return;
    }
    route();
});

// polling stops while the page is hidden and starts over, with a fresh reading, when it's back
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        store.startPolling();
    } else {
        store.stopPolling();
    }
});

prefs.watch((key: any) => {
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

// guest QR codes use /join?… so a phone’s camera opens this page (and can hand off to the app);
// the router still lives on the hash
if (location.pathname === '/join' || location.pathname.endsWith('/join')) {
    location.replace(`${location.origin}/#/join${location.search}`);
} else {
    route();
}
