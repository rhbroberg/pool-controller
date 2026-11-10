// Live updates from the pool server: socket.io over a WebSocket, reached through the web
// service like the API. Only what the page needs of the protocol (Engine.IO 4, Socket.IO 5):
//
//   0{…}           the server opens the session, saying how often it pings
//   2 / 3          its ping and the page's pong
//   40 / 40{…}     joining the default namespace, and the server's welcome
//   42["name",…]   an event
//   44{…} / 41 / 1 refused, left, or closed
//
// Each event is handed on as it arrives; after losing the server, it reconnects with backoff.

export const LIVE_PATH = '/socket.io/?EIO=4&transport=websocket';
const FIRST_RETRY_MS = 1000;
const LONGEST_RETRY_MS = 30000;
// how long to wait for the session to open when the server hasn't said yet
const OPEN_TIMEOUT_MS = 10000;

/** one Engine.IO packet as received; null if it isn't one */
export const parsePacket = (text) => {
    if (typeof text !== 'string' || text.length === 0) {
        return null;
    }
    const json = (body) => {
        try {
            return body ? JSON.parse(body) : null;
        } catch {
            return undefined;
        }
    };
    switch (text[0]) {
    case '0': {
        const open = json(text.slice(1));
        return open ? { type: 'open', pingInterval: open.pingInterval, pingTimeout: open.pingTimeout } : null;
    }
    case '1': return { type: 'close' };
    case '2': return { type: 'ping' };
    case '4': return parseMessage(text.slice(1), json);
    default: return null;
    }
};

const parseMessage = (text, json) => {
    // a namespace other than the default one would follow the type, as "/name,"
    if (text.length > 1 && text[1] === '/') {
        return null;
    }
    switch (text[0]) {
    case '0': return { type: 'connect' };
    case '1': return { type: 'disconnect' };
    case '4': return { type: 'refused', reason: (json(text.slice(1)) || {}).message || 'refused' };
    case '2': {
        // an acknowledgement id may sit between the type and the payload
        const body = json(text.slice(1).replace(/^\d+/, ''));
        if (!Array.isArray(body) || typeof body[0] !== 'string') {
            return null;
        }
        return { type: 'event', name: body[0], data: body[1] };
    }
    default: return null;
    }
};

/** where the live updates are, for a page at location */
export const liveUrl = (location) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${LIVE_PATH}`;

export class LiveConnection {
    /**
     * onEvent(name, data) receives each event; onStateChange(isLive) hears of joining and losing
     * the server
     **/
    constructor(url, { onEvent = () => {}, onStateChange = () => {}, WebSocketImpl = globalThis.WebSocket,
        // a browser's timers must be called unbound, not as methods of this
        setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id) } = {}) {
        this.url = url;
        this.onEvent = onEvent;
        this.onStateChange = onStateChange;
        this.WebSocketImpl = WebSocketImpl;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.socket = null;
        this.isLive = false;
        this.running = false;
        this.retryMs = FIRST_RETRY_MS;
        this.retryTimer = null;
        this.watchdog = null;
    }

    start() {
        if (this.running || !this.WebSocketImpl) {
            return;
        }
        this.running = true;
        this.retryMs = FIRST_RETRY_MS;
        this.open();
    }

    stop() {
        this.running = false;
        this.clearTimer(this.retryTimer);
        this.retryTimer = null;
        this.drop();
    }

    open() {
        let socket;
        try {
            socket = new this.WebSocketImpl(this.url);
        } catch {
            this.lost();
            return;
        }
        this.socket = socket;
        this.expectWithin(OPEN_TIMEOUT_MS);
        socket.onmessage = (message) => {
            if (socket === this.socket) {
                this.receive(String(message.data));
            }
        };
        socket.onclose = () => {
            if (socket === this.socket) {
                this.lost();
            }
        };
        socket.onerror = () => {};
    }

    receive(text) {
        const packet = parsePacket(text);
        if (!packet) {
            return;
        }
        switch (packet.type) {
        case 'open':
            // the server pings every pingInterval and gives up after pingTimeout more
            this.silenceMs = (packet.pingInterval || 25000) + (packet.pingTimeout || 20000);
            this.expectWithin(this.silenceMs);
            this.send('40');
            break;
        case 'ping':
            this.send('3');
            this.expectWithin(this.silenceMs || OPEN_TIMEOUT_MS);
            break;
        case 'connect':
            this.retryMs = FIRST_RETRY_MS;
            this.setLive(true);
            break;
        case 'event':
            if (this.isLive) {
                this.onEvent(packet.name, packet.data);
            }
            break;
        default:
            this.lost();
        }
    }

    send(text) {
        try {
            this.socket.send(text);
        } catch {
            this.lost();
        }
    }

    /** hangs up unless the server is heard from within ms */
    expectWithin(ms) {
        this.clearTimer(this.watchdog);
        this.watchdog = this.setTimer(() => this.lost(), ms);
    }

    lost() {
        this.drop();
        if (!this.running || this.retryTimer) {
            return;
        }
        const wait = this.retryMs;
        this.retryMs = Math.min(this.retryMs * 2, LONGEST_RETRY_MS);
        this.retryTimer = this.setTimer(() => {
            this.retryTimer = null;
            if (this.running) {
                this.open();
            }
        }, wait);
    }

    drop() {
        this.clearTimer(this.watchdog);
        this.watchdog = null;
        const socket = this.socket;
        this.socket = null;
        if (socket) {
            try {
                socket.close();
            } catch {
                // already closed
            }
        }
        this.setLive(false);
    }

    setLive(isLive) {
        if (this.isLive !== isLive) {
            this.isLive = isLive;
            this.onStateChange(isLive);
        }
    }
}
