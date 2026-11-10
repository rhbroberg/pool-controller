// The Reprocess History page apart from its drawing: the range and kinds chosen, what may start,
// what is sent, and the run followed until it's done.

import { EVENT_KINDS } from './model.js';

export const POLL_MS = 1000;
// user actions come from accounts, not the controller, so there are no frames to read again
export const REPROCESS_KINDS = EVENT_KINDS.filter((kind) => kind.id !== 'actions');
// frames the server couldn't read are what a protocol fix recovers; stored readings and switches
// also drop repeats the server once recorded, so they're opt-in
export const DEFAULT_REPROCESS_KINDS = ['protocolErrors'];
const TYPE_TITLES = {
    info: 'Readings',
    status: 'Equipment',
    control: 'Panel keys',
    failed: 'Failed frames',
    unrecognized: 'Unrecognized frames',
    removed: 'Removed'
};

const pad = (n) => String(n).padStart(2, '0');
/** a time as a datetime-local input shows it, in this browser's zone */
export const inputValue = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
/** what a datetime-local input holds, or null when it's empty or not a time */
export const fromInput = (text) => {
    const date = text ? new Date(text) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
};

export const isActive = (run) => Boolean(run) && (run.state === 'waiting' || run.state === 'running');

/** "Failed frames → Readings": one of a run's kind changes */
export const transitionTitle = ({ from, to }) => `${TYPE_TITLES[from] || from} → ${TYPE_TITLES[to] || to}`;

/** how a run is going, in a sentence; formatTime writes a date */
export const runStateText = (run, formatTime) => {
    const kind = run.dryRun ? 'Preview' : 'Reprocessing';
    switch (run.state) {
    case 'waiting': return `${kind} waits for a maintenance job to finish`;
    case 'running': return run.through ? `${kind} is through ${formatTime(run.through)}` : `${kind} has started`;
    case 'failed': return `${kind} stopped: ${run.error || 'an error'}`;
    default: return run.dryRun ? 'Previewed' : 'Reprocessed';
    }
};

/** a run's counts, labelled for a preview or for changes made */
export const runRows = (run) => {
    const label = (text) => run.dryRun ? `Would be ${text.toLowerCase()}` : text;
    return [
        ['Events read again', run.examined],
        [label('Rewritten'), run.updated],
        [label('Removed'), run.removed],
        ['Unchanged', run.unchanged],
        ...run.transitions.map((each) => [transitionTitle(each), each.count])
    ];
};

/** what the page says under a finished run, or null */
export const runFooter = (run) => {
    if (run.state !== 'finished') {
        return null;
    }
    if (run.dryRun) {
        return 'Nothing has changed yet. Reprocess makes these changes.';
    }
    return run.updated || run.removed ? 'The history summaries are being redone from the start of the range; graphs catch up as they are.' : null;
};

export class ReprocessForm {
    /**
     * store has reprocessRun() and startReprocess(request); changed is called whenever there's
     * something new to draw; sleep waits between looks at a run under way
     **/
    constructor(store, { now = new Date(), changed = () => {}, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
        this.store = store;
        this.changed = changed;
        this.sleep = sleep;
        const monthAgo = new Date(now);
        // calendar days, so a clock change on the way leaves the time of day alone
        monthAgo.setDate(monthAgo.getDate() - 30);
        this.from = inputValue(monthAgo);
        this.to = inputValue(now);
        this.kinds = new Set(DEFAULT_REPROCESS_KINDS);
        this.run = null;
        this.starting = false;
        this.error = null;
        this.following = false;
        this.stopped = false;
    }

    get range() {
        return [fromInput(this.from), fromInput(this.to)];
    }

    get eventTypes() {
        return REPROCESS_KINDS.filter((kind) => this.kinds.has(kind.id)).flatMap((kind) => kind.serverTypes);
    }

    /** what's wrong with the range, or null */
    get rangeProblem() {
        const [start, end] = this.range;
        if (!start || !end) {
            return 'Choose when to start and stop.';
        }
        return start < end ? null : 'The start has to be before the end.';
    }

    /** why nothing can start, or null */
    get problem() {
        return this.rangeProblem || (this.kinds.size ? null : 'Choose at least one kind of event.');
    }

    get busy() {
        return this.starting || isActive(this.run);
    }

    canStart(isAdmin) {
        return isAdmin && !this.busy && !this.problem;
    }

    toggle(id) {
        this.kinds = new Set(this.kinds);
        if (!this.kinds.delete(id)) {
            this.kinds.add(id);
        }
        this.changed();
    }

    /** reads the run under way or the last one, and follows it while it goes on */
    async load() {
        try {
            this.run = await this.store.reprocessRun();
            this.error = null;
        } catch (error) {
            this.error = error.message;
        }
        this.changed();
        this.follow();
    }

    async start(dryRun) {
        const [from, to] = this.range;
        this.starting = true;
        this.error = null;
        this.changed();
        try {
            this.run = await this.store.startReprocess({ from, to, eventTypes: this.eventTypes, dryRun });
        } catch (error) {
            this.error = error.message;
        } finally {
            this.starting = false;
            this.changed();
        }
        await this.follow();
    }

    /** looks at the run every POLL_MS until it's done or the page goes away */
    async follow() {
        if (this.following) {
            return;
        }
        this.following = true;
        try {
            while (!this.stopped && isActive(this.run)) {
                await this.sleep(POLL_MS);
                if (this.stopped) {
                    return;
                }
                try {
                    this.run = await this.store.reprocessRun();
                    this.error = null;
                } catch (error) {
                    this.error = error.message;
                }
                this.changed();
            }
        } finally {
            this.following = false;
        }
    }

    stop() {
        this.stopped = true;
    }
}
