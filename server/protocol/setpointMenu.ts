'use strict';
// Read and write AquaLogic spa/pool × heater/heat-pump setpoints by driving the Settings menu
// with the same keys the wireless remote uses (MENU / LEFT / RIGHT / + / −).
//
// Settings order on this installation (MENU → Settings → RIGHT…):
//   Spa Heater1 → Pool Heater1 → Spa Heat Pump → Pool Heat Pump → …
// Heater values are Off or 65–104°F. Heat-pump values show as "Manual Off" when off, else NNN°F.

import log4js from 'log4js';
import {
    BODIES,
    DEVICES,
    SETPOINT_MIN_F,
    SETPOINT_MAX_F,
    isSetpoint
} from './heating';
import type { WaterBody, HeatDevice } from './heating';

const logger = log4js.getLogger();

export type PanelKey = 'menu' | 'left' | 'right' | 'minus' | 'plus';

export interface PanelDisplay {
    lines: string[];
    blinking?: number[][];
    timestamp?: string;
}

export interface PanelPort {
    /** queue one panel key (wireless remote) — must be a single frame, not a held-key repeat */
    press(key: PanelKey): void | Promise<void>;
    /** drop unsent TX after the LCD moves, so a late keep-alive cannot register as another press */
    clearPending?: () => void;
    /** most recent two-line LCD text from the panel */
    display(): PanelDisplay | undefined | Promise<PanelDisplay | undefined>;
    /** override the default pause after each key (ms); tests use a small value */
    settleMs?: number;
}

export type SetpointValue = number | 'off';

// long enough for one keep-alive TX + the panel to paint; shorter invites a retry that double-steps
const KEY_SETTLE_MS = 2800;
const MENU_ATTEMPTS = 40;
const ITEM_ATTEMPTS = 24;
const ADJUST_ATTEMPTS = 80;
const DISPLAY_WAIT_MS = 8000;

/** first-line labels on Settings, as this panel shows them */
const SCREEN_TITLE: Record<WaterBody, Record<HeatDevice, string>> = {
    spa: { heater1: 'Spa Heater1', heatpump: 'Spa Heat Pump' },
    pool: { heater1: 'Pool Heater1', heatpump: 'Pool Heat Pump' }
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const norm = (display: PanelDisplay) =>
    (display.lines || []).map((line) => line.replace(/\s+/g, ' ').trim());

const isSettingsTitle = (display: PanelDisplay) => {
    const [a, b] = norm(display);
    return /^settings$/i.test(a || '') && /^menu\b/i.test(b || '');
};

/** idle home on this panel — MENU cycles top-level menus until this title */
const isDefaultMenu = (display: PanelDisplay) => {
    const [a, b] = norm(display);
    return /^default$/i.test(a || '') && /^menu\b/i.test(b || '');
};

/**
 * true on the temperature row for this body/device — not the lookalike Priority rows,
 * which reuse the same first line ("Spa Heat Pump" / "Pool Heat Pump") with
 * "Priority: Always|Never" on the second.
 **/
const isSetpointRow = (display: PanelDisplay, title: string) => {
    const [line0, line1] = norm(display);
    return (line0 || '').toLowerCase() === title.toLowerCase()
        && parseSetpointText(line1 || '') !== undefined;
};

/**
 * parse the blinking value line: "104°F", "Off", "Manual Off"
 **/
export const parseSetpointText = (line: string): SetpointValue | undefined => {
    const text = (line || '').replace(/\s+/g, ' ').trim();
    if (!text) {
        return undefined;
    }
    if (/^(manual\s+)?off$/i.test(text)) {
        return 'off';
    }
    const match = text.match(/(\d+)\s*°\s*F/i) || text.match(/(\d+)\s*F\b/i);
    if (!match) {
        return undefined;
    }
    const degrees = Number(match[1]);
    return isSetpoint(degrees) || degrees === SETPOINT_MIN_F || degrees === SETPOINT_MAX_F
        ? degrees
        : undefined;
};

/** values the +/− keys walk through for these Settings items (Off ↔ 65…104 ↔ Off) */
const ring: SetpointValue[] = [
    'off',
    ...Array.from({ length: SETPOINT_MAX_F - SETPOINT_MIN_F + 1 }, (_, i) => SETPOINT_MIN_F + i)
];

const ringIndex = (value: SetpointValue) => {
    const i = ring.indexOf(value);
    if (i < 0) {
        throw new Error(`setpoint ${value} is not on the Settings ring`);
    }
    return i;
};

/** fewest +/− presses from `from` to `to` on the Off/65…104 ring */
export const adjustPlan = (from: SetpointValue, to: SetpointValue): { key: 'plus' | 'minus'; count: number } => {
    const a = ringIndex(from);
    const b = ringIndex(to);
    const n = ring.length;
    const up = (b - a + n) % n;
    const down = (a - b + n) % n;
    return up <= down ? { key: 'plus', count: up } : { key: 'minus', count: down };
};

var chain: Promise<unknown> = Promise.resolve();

/** one Settings visit at a time so panel keys from two callers don't interleave */
const exclusive = <T>(label: string, work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work, work);
    chain = run.then(() => undefined, () => undefined);
    return run.catch((e) => {
        logger.warn(`setpoint menu ${label}: ${e && e.message ? e.message : e}`);
        throw e;
    });
};

const readDisplay = async (port: PanelPort): Promise<PanelDisplay> => {
    const deadline = Date.now() + DISPLAY_WAIT_MS;
    while (Date.now() < deadline) {
        const display = await port.display();
        if (display && Array.isArray(display.lines) && display.lines.length >= 2) {
            return display;
        }
        await sleep(200);
    }
    throw new Error('the panel has not shown any display text');
};

const settleFor = (port: PanelPort, override?: number) =>
    override ?? port.settleMs ?? KEY_SETTLE_MS;

const pressAndSettle = async (port: PanelPort, key: PanelKey, settleMs?: number) => {
    const wait = settleFor(port, settleMs);
    const before = norm(await readDisplay(port)).join('|');
    await port.press(key);
    const deadline = Date.now() + wait;
    while (Date.now() < deadline) {
        await sleep(Math.min(250, wait));
        const after = norm(await readDisplay(port)).join('|');
        if (after !== before) {
            // one step registered — discard any unsent duplicate still waiting on a keep-alive
            port.clearPending?.();
            // brief pause so the next press is not coalesced with this one on the wire
            await sleep(Math.min(500, wait));
            return;
        }
    }
    // no LCD change: still clear the queue so a late TX is not a surprise second step later
    port.clearPending?.();
};

/**
 * MENU until the Settings title, then RIGHT until the body/device row. Leaves the panel on that row.
 **/
const openSetpointScreen = async (port: PanelPort, body: WaterBody, device: HeatDevice) => {
    const title = SCREEN_TITLE[body][device];
    for (let i = 0; i < MENU_ATTEMPTS; i++) {
        const display = await readDisplay(port);
        if (isSettingsTitle(display)) {
            break;
        }
        // already on the row from a prior visit
        if (isSetpointRow(display, title)) {
            return display;
        }
        await pressAndSettle(port, 'menu');
        if (isSettingsTitle(await readDisplay(port))) {
            break;
        }
        if (i === MENU_ATTEMPTS - 1) {
            throw new Error(`could not reach the Settings Menu (at ${norm(await readDisplay(port)).join('|')})`);
        }
    }

    for (let i = 0; i < ITEM_ATTEMPTS; i++) {
        await pressAndSettle(port, 'right');
        const display = await readDisplay(port);
        if (isSetpointRow(display, title)) {
            return display;
        }
        if (isSettingsTitle(display) && i > 0) {
            throw new Error(`Settings has no "${title}" item`);
        }
    }
    throw new Error(`could not find "${title}" in Settings`);
};

/**
 * MENU until Default / Menu so the panel is back on its idle home after a Settings visit.
 **/
const leaveToDefaultMenu = async (port: PanelPort) => {
    for (let i = 0; i < MENU_ATTEMPTS; i++) {
        const display = await readDisplay(port);
        if (isDefaultMenu(display)) {
            return;
        }
        await pressAndSettle(port, 'menu');
        if (isDefaultMenu(await readDisplay(port))) {
            return;
        }
    }
    logger.warn(`setpoint menu: could not reach Default Menu (at ${norm(await readDisplay(port)).join('|')})`);
};

const tryValueOnScreen = (display: PanelDisplay): SetpointValue | undefined => {
    const [, line1] = norm(display);
    return parseSetpointText(line1);
};

const valueOnScreen = (display: PanelDisplay): SetpointValue => {
    const [, line1] = norm(display);
    const value = parseSetpointText(line1);
    if (value === undefined) {
        throw new Error(`could not parse setpoint from "${line1}"`);
    }
    return value;
};

const readSetpointOnce = async (port: PanelPort, body: WaterBody, device: HeatDevice): Promise<SetpointValue> => {
    if (!BODIES.includes(body) || !DEVICES.includes(device)) {
        throw new Error(`unknown body/device ${body}/${device}`);
    }
    const display = await openSetpointScreen(port, body, device);
    const value = valueOnScreen(display);
    logger.info(`setpoint menu: ${SCREEN_TITLE[body][device]} is ${value === 'off' ? 'Off' : `${value}°F`}`);
    return value;
};

const writeSetpointOnce = async (
    port: PanelPort,
    body: WaterBody,
    device: HeatDevice,
    degrees: number
): Promise<number> => {
    if (!BODIES.includes(body) || !DEVICES.includes(device)) {
        throw new Error(`unknown body/device ${body}/${device}`);
    }
    if (!isSetpoint(degrees)) {
        throw new Error(`a setpoint must be a whole number from ${SETPOINT_MIN_F} to ${SETPOINT_MAX_F}°F`);
    }

    let display = await openSetpointScreen(port, body, device);
    let current = tryValueOnScreen(display);
    if (current === degrees) {
        logger.info(`setpoint menu: ${SCREEN_TITLE[body][device]} already ${degrees}°F`);
        await pressAndSettle(port, 'right');
        return degrees;
    }

    // from Off (or an intermediate mode like "Manual On"), step until the row shows `degrees`
    for (let n = 0; n < ADJUST_ATTEMPTS && current !== degrees; n++) {
        const stepMs = Math.min(1200, settleFor(port));
        if (current === undefined || current === 'off') {
            // Off → 65 is one +; heat-pump rows label Off as "Manual Off"
            await pressAndSettle(port, 'plus', stepMs);
        } else {
            const plan = adjustPlan(current, degrees);
            if (plan.count === 0) {
                break;
            }
            // step one degree at a time so a missed RS-485 frame cannot overshoot past the target
            await pressAndSettle(port, plan.key, stepMs);
        }
        display = await readDisplay(port);
        // still on the same Settings row?
        if (!isSetpointRow(display, SCREEN_TITLE[body][device]) && !tryValueOnScreen(display)) {
            throw new Error(`left the ${SCREEN_TITLE[body][device]} row while adjusting (at ${norm(display).join('|')})`);
        }
        current = tryValueOnScreen(display);
    }

    if (current !== degrees) {
        throw new Error(`wanted ${degrees}°F on ${SCREEN_TITLE[body][device]} but the panel shows ${current === undefined ? norm(display)[1] : current}`);
    }
    // advancing off the row is what locks the value into AquaLogic memory
    await pressAndSettle(port, 'right');
    logger.info(`setpoint menu: ${SCREEN_TITLE[body][device]} set to ${degrees}°F`);
    return degrees;
};

/**
 * read the controller's setpoint for one body/device by opening its Settings row,
 * then MENU back to Default
 **/
export const readSetpoint = (port: PanelPort, body: WaterBody, device: HeatDevice): Promise<SetpointValue> =>
    exclusive(`read ${body}/${device}`, async () => {
        try {
            return await readSetpointOnce(port, body, device);
        } finally {
            await leaveToDefaultMenu(port);
        }
    });

/**
 * set the controller's setpoint by opening its Settings row and tapping +/−, then RIGHT once to lock in,
 * then MENU back to Default
 **/
export const writeSetpoint = (
    port: PanelPort,
    body: WaterBody,
    device: HeatDevice,
    degrees: number
): Promise<number> =>
    exclusive(`write ${body}/${device}`, async () => {
        try {
            return await writeSetpointOnce(port, body, device, degrees);
        } finally {
            await leaveToDefaultMenu(port);
        }
    });

export interface MenuSetpointStore {
    reachesController: true;
    get: (body: WaterBody, device: HeatDevice) => number;
    set: (body: WaterBody, device: HeatDevice, degrees: number) => Promise<number>;
    /** pull all four values from the panel into the cache */
    refresh: () => Promise<Record<WaterBody, Record<HeatDevice, SetpointValue>>>;
    /** last value read or written (Off stored as null) */
    peek: (body: WaterBody, device: HeatDevice) => number | null;
}

/**
 * HeatingService-compatible store: get() is cached; set() drives the Settings menu.
 * Call refresh() once the panel is live so estimates start from controller values.
 **/
export const createSetpointStore = (port: PanelPort, defaultF = 80): MenuSetpointStore => {
    const cache = {} as Record<WaterBody, Record<HeatDevice, number>>;
    BODIES.forEach((body) => {
        cache[body] = {} as Record<HeatDevice, number>;
        DEVICES.forEach((device) => {
            cache[body][device] = defaultF;
        });
    });

    const remember = (body: WaterBody, device: HeatDevice, value: SetpointValue) => {
        if (typeof value === 'number') {
            cache[body][device] = value;
        }
    };

    return {
        reachesController: true,
        get: (body, device) => cache[body][device],
        peek: (body, device) => cache[body][device],
        set: async (body, device, degrees) => {
            const written = await writeSetpoint(port, body, device, degrees);
            remember(body, device, written);
            return written;
        },
        // one Settings pass for all four, then back to Default once
        refresh: () =>
            exclusive('refresh', async () => {
                const found = {} as Record<WaterBody, Record<HeatDevice, SetpointValue>>;
                try {
                    for (const body of BODIES) {
                        found[body] = {} as Record<HeatDevice, SetpointValue>;
                        for (const device of DEVICES) {
                            const value = await readSetpointOnce(port, body, device);
                            found[body][device] = value;
                            remember(body, device, value);
                        }
                    }
                    return found;
                } finally {
                    await leaveToDefaultMenu(port);
                }
            })
    };
};
