import { writeSync } from 'fs';
import log4js from 'log4js';
import { SerialPort } from 'serialport';

const logger = log4js.getLogger();
let port: SerialPort | undefined;

// Keep-alive the panel polls remotes with; a keypress must go on the wire within ~1ms of it.
const KEEP_ALIVE = Buffer.from([0x10, 0x02, 0x01, 0x01, 0x00, 0x14, 0x10, 0x03]);
const pendingTx: Buffer[] = [];
let roll = Buffer.alloc(0);

// USB-RS485 adapters (CH340/CH341) often drive DE/RE from RTS. Others auto-enable DE on UART
// TX — for those, leave RTS alone (POOL_SERIAL_RTS_TX=off). Default off: driving RTS on the
// Pi's CH341 was what blocked TX entirely.
const rtsMode = (): 'high' | 'low' | 'off' => {
    const raw = (process.env.POOL_SERIAL_RTS_TX || 'off').toLowerCase();
    if (raw === '1' || raw === 'high') {
        return 'high';
    }
    if (raw === '0' || raw === 'low') {
        return 'low';
    }
    return 'off';
};

const settleMs = (envName: string, fallback: number) => {
    const raw = process.env[envName];
    if (raw === undefined || raw === '') {
        return fallback;
    }
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const setRtsSync = (value: boolean) => {
    // serialport's set() is async; for the keep-alive window we need the ioctl before write.
    // Fall back to async if fd tricks fail — still better than nothing.
    try {
        const anyPort = port as SerialPort & { settings?: { rts?: boolean }; _poolRts?: boolean };
        port!.set({ rts: value }, (err) => {
            if (err) {
                logger.error(`serial RTS ${value}: ${err.message}`);
            }
        });
        anyPort._poolRts = value;
    } catch (e) {
        logger.error(`serial RTS ${value}: ${e instanceof Error ? e.message : e}`);
    }
};

const receiveMode = () => {
    const mode = rtsMode();
    if (mode === 'off') {
        return;
    }
    setRtsSync(mode !== 'high');
};

/**
 * Blast a frame onto the bus as soon as a keep-alive ends. Prefer writeSync so we don't yield
 * to the event loop inside the ~1ms reply window. One frame per poll; held-key repeats are
 * separate queued copies.
 **/
const transmitSync = (message: Buffer) => {
    if (!port?.isOpen) {
        return;
    }
    const mode = rtsMode();
    const burst = Math.max(1, Number(process.env.POOL_SERIAL_TX_BURST || 1) || 1);
    const fd = (port as SerialPort & { fd?: number }).fd;
    try {
        if (mode !== 'off') {
            setRtsSync(mode === 'high');
            const beforeMs = settleMs('POOL_SERIAL_RTS_BEFORE_MS', 0);
            if (beforeMs > 0) {
                const end = Date.now() + beforeMs;
                while (Date.now() < end) { /* spin; window is tight */ }
            }
        }
        for (let n = 0; n < burst; n++) {
            if (typeof fd === 'number' && fd >= 0) {
                writeSync(fd, message);
            } else {
                port.write(message);
            }
        }
        if (mode !== 'off') {
            const afterMs = settleMs('POOL_SERIAL_RTS_AFTER_MS', 2);
            if (afterMs > 0) {
                const end = Date.now() + afterMs;
                while (Date.now() < end) { /* spin */ }
            }
            receiveMode();
        }
        logger.debug(`serial TX complete (${burst}× sync)`);
    } catch (e) {
        logger.error(`serial TX failed: ${e instanceof Error ? e.message : e}`);
        try {
            receiveMode();
        } catch (revert) {
            logger.error(`serial RTS revert failed: ${revert instanceof Error ? revert.message : revert}`);
        }
    }
};

const flushPendingAfterKeepAlive = () => {
    if (pendingTx.length === 0 || !port?.isOpen) {
        return;
    }
    const message = pendingTx.shift()!;
    transmitSync(message);
};

/**
 * Queue a frame to send on the next panel keep-alive. The AquaLogic only listens for remote
 * keypresses in the ~1ms after 01 01; sending from the PingEvent handler is already too late.
 **/
const writeEvent = (message: Buffer): Promise<void> => {
    if (!port?.isOpen) {
        logger.error('serial write with the port closed');
        return Promise.resolve();
    }
    pendingTx.push(Buffer.from(message));
    logger.debug(`serial TX queued (${pendingTx.length} pending)`);
    return Promise.resolve();
};

/** Drop unsent key frames once the panel has confirmed — leftover repeats can toggle back. */
const cancelPending = () => {
    if (pendingTx.length > 0) {
        logger.debug(`serial TX cancelled (${pendingTx.length} dropped)`);
        pendingTx.length = 0;
    }
};

const listen = (filename: string, cb: (data: Buffer) => void) => {
    const stopBits = (Number(process.env.POOL_SERIAL_STOP_BITS || 2) === 1 ? 1 : 2) as 1 | 2;
    port = new SerialPort({
        path: filename,
        baudRate: 19200,
        dataBits: 8,
        parity: 'none',
        stopBits,
        autoOpen: false
    });

    port.open((err) => {
        if (err) {
            return logger.error('Error: ', err.message);
        }
        try {
            receiveMode();
            logger.info(`serial open ${filename}; 19200 8N${stopBits}; RTS ${rtsMode()} for TX; send-on-keep-alive`);
        } catch (e) {
            logger.warn(`serial open but RTS init failed: ${e instanceof Error ? e.message : e}`);
        }
    });

    port.on('data', (data: Buffer) => {
        logger.trace('Data:', data);
        // TX before handing bytes to the parser — every ms counts after the keep-alive.
        roll = Buffer.concat([roll.length > 56 ? roll.subarray(roll.length - 56) : roll, data]);
        let at;
        while ((at = roll.indexOf(KEEP_ALIVE)) !== -1) {
            roll = roll.subarray(at + KEEP_ALIVE.length);
            flushPendingAfterKeepAlive();
        }
        cb(data);
    });

    return port;
};

export { listen, writeEvent, cancelPending };
