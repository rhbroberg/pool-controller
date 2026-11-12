// What the page knows about this pool: names, equipment, roles and the rules for showing them.

export const DEFAULT_POOL_NAME = 'Pool';

const DISPLAY_NAMES = {
    'pool temp': 'Pool',
    'spa temp': 'Spa',
    ambient: 'Air',
    heater1: 'Heater',
    superchlorinate: 'Super Chlorinate',
    aux14: 'Spa Filter',
    aux3: 'Yard Lights',
    aux5: 'Blower',
    valve4: 'Heat Pump',
    spillover: 'Spillover'
};

export const displayName = (name) => DISPLAY_NAMES[name] || name.replace(/\b\w/g, (letter) => letter.toUpperCase());

export const isOn = (reading) => Boolean(reading) && Number(reading.value) !== 0;

export const formattedValue = (reading) => {
    switch (reading.name) {
    case 'pool temp':
    case 'spa temp':
    case 'ambient':
        return `${Math.trunc(reading.value)}°F`;
    case 'salt':
        return `${Math.trunc(reading.value)} ppm`;
    default:
        return String(reading.value);
    }
};

// MARK: equipment

export const GROUPS = [
    { id: 'heating', title: 'Heating' },
    { id: 'circulation', title: 'Circulation' },
    { id: 'features', title: 'Lights & Features' }
];

/**
 * Equipment the page can switch. Only buttons whose control bits are confirmed by captured
 * presses belong here. name is the button sent to PUT /devices/{name}/{state}; stateReading is
 * the reading that reports its state when that isn't the status bit of the same name.
 **/
export const EQUIPMENT = [
    // valve4 runs the heat pump at this installation
    { name: 'valve4', icon: 'heatWaves', tint: 'pink', group: 'heating' },
    // the heater key switches between Manual Off and Auto Control on the panel display
    { name: 'heater1', icon: 'flame', tint: 'orange', group: 'heating', stateReading: 'heater1 mode', onText: 'Auto', offText: 'Manual Off' },
    { name: 'filter', icon: 'fan', tint: 'blue', group: 'circulation' },
    // aux14 is labelled Spa Filter on this panel; it brings valve3 and aux1 with it
    { name: 'aux14', icon: 'bath', tint: 'cyan', group: 'circulation' },
    { name: 'lights', icon: 'lightbulb', tint: 'yellow', group: 'features' },
    // aux3 and aux5 are labelled Yard Lights and Blower on this panel
    { name: 'aux3', icon: 'lamp', tint: 'green', group: 'features' },
    { name: 'aux5', icon: 'wind', tint: 'mint', group: 'features' },
    {
        name: 'superchlorinate', icon: 'bubbles', tint: 'teal', group: 'features',
        confirmOn: {
            title: 'Start super chlorinating?',
            message: 'The chlorinator runs at full output until the controller ends the cycle or you turn it off.',
            action: 'Super Chlorinate'
        }
    }
].map((control) => ({ onText: 'On', offText: 'Off', ...control, title: displayName(control.name), stateName: control.stateReading || control.name }));

export const controlsIn = (group) => EQUIPMENT.filter((control) => control.group === group);

export const stateText = (control, on) => on ? control.onText : control.offText;

/**
 * shown while the controller hasn't yet reported the requested state; short enough for a
 * half-width tile
 **/
export const pendingText = (control, on) => control.onText === 'On' ? `Turning ${stateText(control, on)}…` : `To ${stateText(control, on)}…`;

// MARK: heating

/**
 * The heater and heat pump. They're in series, so both heat whichever body the water flows to,
 * each toward its own setpoint for that body.
 **/
export const HEATING_DEVICES = [
    { id: 'heater1', title: 'Heater', controlName: 'heater1' },
    { id: 'heatpump', title: 'Heat Pump', controlName: 'valve4' }
];

export const heatingDeviceFor = (controlName) => HEATING_DEVICES.find((device) => device.controlName === controlName) || null;

export const WATER_BODIES = [
    { id: 'pool', title: 'Pool', temperatureName: 'pool temp' },
    { id: 'spa', title: 'Spa', temperatureName: 'spa temp' }
];

export const waterBody = (id) => WATER_BODIES.find((body) => body.id === id) || null;

export const setpointOf = (heating, deviceId, bodyId) => heating && heating.setpoints && heating.setpoints[bodyId] ? heating.setpoints[bodyId][deviceId] : undefined;

/**
 * What an equipment tile says. For the heater and heat pump, on is enabled and running is
 * producing heat; for everything else they're the same. heating is that device's entry from
 * GET /heating, or null.
 **/
export const tileState = (control, on, pending, heating) => {
    const running = heating ? on && heating.heating === true : on;
    const target = on && pending === undefined && heating ? heating.setpoint ?? null : null;
    let text;
    if (pending !== undefined) {
        text = pendingText(control, pending);
    } else if (!on || !heating) {
        text = stateText(control, on);
    } else if (!heating.body) {
        // with no pump running, no water reaches the heaters
        text = `${stateText(control, true)} · pump off`;
    } else {
        const body = waterBody(heating.body);
        const water = body.title.toLowerCase();
        if (heating.heating) {
            text = `Heating ${water}`;
        } else if (heating.callingForHeat) {
            text = `Waiting · ${water}`;
        } else if (heating.temperature === null || heating.temperature === undefined) {
            text = `${stateText(control, true)} · ${water}`;
        } else {
            text = `${body.title} at setpoint`;
        }
    }
    return { running, text, targetSetpoint: target };
};

// MARK: water flow

/**
 * where the water flows; the controller's spillover key steps through these in order
 **/
export const WATER_MODES = [
    { id: 'pool', title: 'Pool', summary: 'Water flows through the pool only.' },
    { id: 'spa', title: 'Spa', summary: 'Water flows through the spa only.' },
    { id: 'spillover', title: 'Spillover', summary: 'Pool water is pumped through the spa and spills back over into the pool.' }
];

export const waterModeInfo = (id) => WATER_MODES.find((mode) => mode.id === id) || null;

/**
 * the everyday jobs offered in place of single switches, each on while the switches behind it
 * are, as the server reads them
 **/
export const TASKS = [
    { id: 'pool', title: 'Pool', summary: 'Filter running, water in spillover', icon: 'waves', tint: 'blue' },
    { id: 'spaPreheat', title: 'Spa Preheat', summary: 'Spa filter, heater and heat pump', icon: 'thermometer', tint: 'orange' },
    { id: 'spaParty', title: 'Spa Party', summary: 'Spa preheat with the blower, and lights after dark', icon: 'bubbles', tint: 'pink' }
];

export const taskInfo = (id) => TASKS.find((task) => task.id === id) || null;

/** whether `id` is on in GET /tasks's answer */
export const taskOn = (tasks, id) => Boolean(tasks && tasks[id] && tasks[id].on);

/** a spa preheat waiting for its time, or null; not once it has started */
export const scheduledPreheat = (tasks) => tasks && tasks.spaPreheat && !tasks.spaPreheat.on && tasks.spaPreheat.scheduled
    ? tasks.spaPreheat.scheduled
    : null;

/** "7:30 PM", or "Sat 7:30 AM" when it isn't the same day as now */
export const taskTime = (date, now = new Date()) => {
    const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return date.toDateString() === now.toDateString()
        ? time
        : `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
};

/** { ready: "Ready by 7:30 PM", start: "Starts about 6:00 PM" } for a scheduled preheat */
export const scheduleText = (scheduled, now = new Date()) => {
    const readyAt = new Date(scheduled.readyAt);
    const startAt = new Date(scheduled.startAt);
    return {
        ready: `Ready by ${taskTime(readyAt, now)}`,
        start: startAt <= now ? 'Starting now' : `Starts about ${taskTime(startAt, now)}`
    };
};

/**
 * spillover if that switch is on, otherwise spa if it is, otherwise pool; unknown until the
 * server has reported the pool switch
 **/
export const waterModeOf = (readings) => {
    const reading = (name) => readings.find((r) => r.name === name);
    if (isOn(reading('spillover'))) {
        return 'spillover';
    }
    if (isOn(reading('spa'))) {
        return 'spa';
    }
    return reading('pool') ? 'pool' : null;
};

// MARK: measurements

const MEASUREMENT_ORDER = ['pool temp', 'spa temp', 'ambient', 'salt'];

/**
 * Each sensor sits just downstream of its pump, so its reading is current only while that runs:
 * the pool's is the filter pump; the spa's is the spa filter (aux14 here), whatever the flow.
 **/
export const PUMP_FOR_TEMPERATURE = { 'pool temp': 'filter', 'spa temp': 'aux14' };

/**
 * every measurement always has a slot, so the card keeps its shape while readings arrive; pool
 * and spa are dimmed, as stale readings, while their pumps are off
 **/
export const measurement = (readings, name) => {
    const find = (n) => readings.find((r) => r.name === n);
    const reading = find(name);
    const pump = PUMP_FOR_TEMPERATURE[name];
    return {
        name,
        title: displayName(name),
        value: reading ? formattedValue(reading) : (name === 'salt' ? '-- ppm' : '--°F'),
        isDimmed: Boolean(pump) && !isOn(find(pump))
    };
};

export const measurements = (readings) => MEASUREMENT_ORDER.map((name) => measurement(readings, name));

// MARK: weather

export const WEATHER_CONDITIONS = {
    sunny: { title: 'Sunny', icon: 'sun' },
    'partly-cloudy': { title: 'Partly Cloudy', icon: 'cloudSun' },
    cloudy: { title: 'Cloudy', icon: 'cloud' },
    fog: { title: 'Fog', icon: 'cloudFog' },
    rain: { title: 'Rain', icon: 'cloudRain' },
    snow: { title: 'Snow', icon: 'snowflake' },
    storm: { title: 'Storms', icon: 'cloudLightning' }
};

const degrees = (value) => typeof value === 'number' ? `${Math.round(value)}°` : '--°';

/**
 * what the main page shows of today's forecast; null while there's nothing to show, as before
 * an admin sets a zip code
 **/
export const weatherSummary = (weather) => {
    if (!weather || !weather.configured || !weather.today) {
        return null;
    }
    const { today } = weather;
    const condition = WEATHER_CONDITIONS[today.condition] || { title: 'Today', icon: 'cloud' };
    const rain = typeof today.precipitationProbability === 'number' && today.precipitationProbability >= 30
        ? `${Math.round(today.precipitationProbability)}% chance of rain`
        : null;
    return {
        title: condition.title,
        icon: condition.icon,
        highLow: `${degrees(today.high)} / ${degrees(today.low)}`,
        place: weather.location ? weather.location.placeName : null,
        rain,
        isStale: Boolean(weather.stale)
    };
};

// MARK: accounts

/**
 * What an account may do. Each role can do everything the one before it can. The server's user
 * role is shown as Operator, so the word doesn't also mean "an account".
 **/
export const ROLES = [
    { id: 'viewer', title: 'Viewer', withArticle: 'a viewer', summary: 'Viewers can see everything and change their own password.' },
    { id: 'user', title: 'Operator', withArticle: 'an operator', summary: 'Operators can also change equipment, water flow and panel settings.' },
    { id: 'admin', title: 'Admin', withArticle: 'an admin', summary: 'Admins can also manage accounts, restart the server and factory reset.' }
];

export const roleInfo = (id) => ROLES.find((role) => role.id === id) || null;
export const canControl = (role) => role === 'user' || role === 'admin';
export const isAdmin = (role) => role === 'admin';

export const DEFAULT_ADMIN = 'admin';
export const MINIMUM_PASSWORD_LENGTH = 6;

/**
 * the builds in use: this page's web service, the pool server, and the API version it serves;
 * a dash for any not known, as from a server that is down or too old to say
 **/
export const aboutLine = (webCommit, serverInfo) => {
    const known = (value) => value || '—';
    return `Web ${known(webCommit)} · Server ${known(serverInfo && serverInfo.commit)} · API ${known(serverInfo && serverInfo.apiVersion)}`;
};

/**
 * why a new password and its confirmation can't be used yet, once something has been typed
 **/
export const passwordProblem = (password, confirmation) => {
    if (password && password.length < MINIMUM_PASSWORD_LENGTH) {
        return `Use at least ${MINIMUM_PASSWORD_LENGTH} characters.`;
    }
    if (confirmation && confirmation !== password) {
        return 'The passwords don’t match.';
    }
    return null;
};

export const passwordAcceptable = (password, confirmation) => password.length >= MINIMUM_PASSWORD_LENGTH && password === confirmation;

// MARK: sign-in services

/**
 * what the server's answer at #/signin/complete means: a ticket to trade for a token, or a title
 * and message to show
 **/
export const signInOutcome = (params) => {
    const provider = params.get('provider') || 'the service';
    if (params.get('ticket')) {
        return { ticket: params.get('ticket') };
    }
    switch (params.get('status')) {
    case 'pending':
        return { title: 'Waiting for Approval', message: `Your request to sign in with ${provider} was sent to the pool’s admin. Sign in again once they’ve approved it.` };
    case 'denied':
        return { title: 'Not Allowed', message: `This ${provider} account isn’t allowed to sign in here.`, failed: true };
    case 'refused':
        return { title: 'Invitation Needed', message: 'This pool only lets in people an admin has invited. Ask an admin to invite your email address, then sign in again.', failed: true };
    case 'cancelled':
        return { title: 'Sign-In Cancelled', message: 'You didn’t finish signing in.' };
    case 'linked':
        return { title: 'Service Linked', message: `You can sign in with ${provider} from now on.`, linked: true };
    default:
        return { title: 'Couldn’t Sign In', message: params.get('error') || 'The sign-in didn’t complete. Try again.', failed: true };
    }
};

/**
 * the names of how an account signs in, with services' ids replaced by their names
 **/
export const methodNames = (methods, providers = []) => (methods || []).map((method) => {
    if (method === 'password') {
        return 'Password';
    }
    const provider = providers.find((p) => p.id === method);
    return provider ? provider.displayName : method;
});

/**
 * ready-made settings for common services; trustEmail says whether their verified addresses
 * may redeem invitations
 **/
export const SERVICE_PRESETS = [
    { id: 'google', displayName: 'Google', kind: 'oidc', issuer: 'https://accounts.google.com', trustEmail: true },
    { id: 'microsoft', displayName: 'Microsoft', kind: 'oidc', issuer: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0', trustEmail: false },
    { id: 'apple', displayName: 'Apple', kind: 'apple', issuer: 'https://appleid.apple.com', trustEmail: true },
    { id: '', displayName: '', kind: 'oidc', issuer: '', trustEmail: false, other: true }
];

// MARK: event log

/**
 * the event log's filter buttons, each covering one or more of the server's event types
 **/
export const EVENT_KINDS = [
    { id: 'equipment', title: 'Equipment', icon: 'toggle', tint: 'blue', serverTypes: ['status'] },
    { id: 'readings', title: 'Readings', icon: 'thermometer', tint: 'teal', serverTypes: ['info'] },
    { id: 'keypad', title: 'Panel Keys', icon: 'keyboard', tint: 'indigo', serverTypes: ['control'] },
    { id: 'actions', title: 'User Actions', icon: 'user', tint: 'green', serverTypes: ['action'] },
    { id: 'protocolErrors', title: 'Communication Errors', icon: 'warning', tint: 'orange', serverTypes: ['failed', 'unrecognized'] }
];

export const eventKindOf = (serverType) => EVENT_KINDS.find((kind) => kind.serverTypes.includes(serverType)) || EVENT_KINDS[EVENT_KINDS.length - 1];

/**
 * starts on what people did and what the equipment did; readings change often enough to bury
 * those, and communication errors are for diagnosing the connection
 **/
export const DEFAULT_EVENT_KINDS = ['equipment', 'actions'];

// MARK: panel

export const PANEL_KEYS = {
    menu: { title: 'Menu', label: 'Menu' },
    left: { title: 'Left', label: '<' },
    right: { title: 'Right', label: '>' },
    minus: { title: 'Minus', label: '−' },
    plus: { title: 'Plus', label: '+' }
};
