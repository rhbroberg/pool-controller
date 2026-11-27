'use strict';

import { errorMessageOf } from '../types/domain';
// Pushes changes to the apps the moment the controller reports them, over socket.io, so they
// needn't wait for their next poll:
//
//   readings  { readings }  entries as GET /status reports them: every switch when a status frame
//                           changes, the readings that changed on the display, or the check
//                           system reason when it or the check system switch changes
//   heating   the same body as GET /heating, once the switches or temperatures behind it change
//   tasks     the same body as GET /tasks, once the switches change or a preheat is scheduled,
//             cancelled or started
//
// The apps keep polling, less often, in case a push is missed.

import log4js from 'log4js';
const logger = log4js.getLogger();

// a status change and the display reading after it often arrive together; one heating push covers both
const HEATING_DELAY_MS = 150;

type PushName = 'heating' | 'tasks';
type SourceFn = () => Promise<unknown>;

let io: { emit(event: string, body: unknown): void } | undefined;
const sources: Record<PushName, SourceFn> = { heating: async () => null, tasks: async () => null };
const timers: Partial<Record<PushName, NodeJS.Timeout | undefined>> = {};

/**
 * io is the socket.io server; heating() and tasks() resolve with what GET /heating and
 * GET /tasks answer
 **/
export function attach(server: typeof io, { heating, tasks }: { heating?: SourceFn; tasks?: SourceFn } = {}) {
    io = server;
    if (heating) {
        sources.heating = heating;
    }
    if (tasks) {
        sources.tasks = tasks;
    }
}

export function readings(entries: unknown[]) {
    if (!io || !entries || entries.length === 0) {
        return;
    }
    io.emit('readings', { readings: entries });
    heatingChanged();
    tasksChanged();
}

// pushes `name` once, a moment after the first change asks for it
const pushSoon = (name: PushName) => {
    if (!io || timers[name]) {
        return;
    }
    timers[name] = setTimeout(async () => {
        timers[name] = undefined;
        try {
            const body = await sources[name]();
            if (body) {
                io!.emit(name, body);
            }
        } catch (e: any) {
            logger.warn(`could not push ${name}: ${errorMessageOf(e)}`);
        }
    }, HEATING_DELAY_MS);
    timers[name]!.unref();
};

export function heatingChanged() {
    pushSoon('heating');
}

export function tasksChanged() {
    pushSoon('tasks');
}
