'use strict';
// Writes synthetic temperature, heater and spa history for trying out the history views.
//
//   NODE_ENV=development node tools/seed-history.js --days 30     add 30 days before the oldest real event
//   NODE_ENV=development node tools/seed-history.js --remove      delete everything this tool added
//
// Seeded events have source 'seed'. Like the server, a reading is stored only when it changes.
require('../config/config');
const log4js = require('log4js');
log4js.getLogger().level = 'off';
var { mongoose } = require('../mongoose');
var { Event } = require('../models/event');
const { StatusEvent } = require('../protocol/events');

const STEP_MS = 10 * 60 * 1000;
const SOURCE = 'seed';

var argValue = (flag, fallback) => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? fallback : process.argv[index + 1];
};

var statusFrame = (on) => {
    let mask = 0;
    Object.keys(on).forEach((name) => {
        if (on[name]) {
            mask |= 1 << StatusEvent.bitPosition(name);
        }
    });
    const frame = Buffer.from([0x10, 0x02, 0x01, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10, 0x03]);
    frame.writeUInt32LE(mask >>> 0, 4);
    let checksum = 0;
    for (let i = 0; i < 12; i++) {
        checksum += frame[i];
    }
    frame.writeUInt16BE(checksum, 12);
    return frame;
};

var event = (eventType, timestamp, status, raw) => ({
    _id: new mongoose.Types.ObjectId(),
    source: SOURCE,
    eventType: eventType,
    timestamp: timestamp,
    status: status,
    raw: raw
});

var generate = (start, end) => {
    const events = [];
    const lastInfo = {};
    const switches = { pool: true, 'check system': false, filter: false, heater1: false, aux14: false, valve3: false, aux1: false };
    let pool = 78;
    let spa;

    const recordInfo = (timestamp, name, value) => {
        const rounded = Math.round(value);
        if (lastInfo[name] !== rounded) {
            lastInfo[name] = rounded;
            events.push(event('info', timestamp, [{ name: name, value: rounded }]));
        }
    };

    events.push(event('info', new Date(start), [{ name: 'heater1 mode', value: 1 }]));

    for (let t = start; t < end; t += STEP_MS) {
        const timestamp = new Date(t);
        const hour = timestamp.getHours() + timestamp.getMinutes() / 60;
        // local days, so an evening spa session isn't split at midnight UTC
        const day = Math.floor((t - timestamp.getTimezoneOffset() * 60 * 1000) / (24 * 60 * 60 * 1000));

        const air = 62 + 12 * Math.sin(2 * Math.PI * (hour - 9) / 24) + 4 * Math.sin(2 * Math.PI * day / 9);
        const spaSession = day % 2 === 0 && hour >= 18 && hour < 20.5;
        const poolHeating = !spaSession && hour >= 7 && hour < 10 && pool < 84;
        if (spaSession && typeof spa === 'undefined') {
            spa = pool;
        }
        const spaHeating = spaSession && spa < 102;

        const next = Object.assign({}, switches, {
            filter: (hour >= 6 && hour < 22) || spaSession,
            heater1: poolHeating || spaHeating,
            aux14: spaSession,
            valve3: spaSession,
            aux1: spaSession
        });
        const changed = Object.keys(next).filter((name) => next[name] !== switches[name]);
        if (changed.length > 0) {
            Object.assign(switches, next);
            events.push(event('status', timestamp, changed.map((name) => ({ name: name, value: next[name] ? 1 : 0 })), statusFrame(switches)));
        }

        pool += poolHeating ? 0.4 : (air - pool) * 0.006;
        recordInfo(timestamp, 'ambient', air);
        recordInfo(timestamp, 'pool temp', pool);
        if (spaSession) {
            spa += spaHeating ? 1.5 : -0.1;
            recordInfo(timestamp, 'spa temp', spa);
        } else {
            spa = undefined;
        }
    }
    return events;
};

(async () => {
    await mongoose.connection.asPromise();
    const database = mongoose.connection.name;

    if (process.argv.includes('--remove')) {
        const { deletedCount } = await Event.deleteMany({ source: SOURCE });
        console.log(`removed ${deletedCount} seeded events from ${database}`);
        return;
    }

    const days = Number(argValue('--days', 30));
    if (await Event.exists({ source: SOURCE })) {
        console.log(`${database} already has seeded history; run with --remove first`);
        return;
    }
    const oldest = await Event.findOne({ source: { $ne: SOURCE } }).sort({ timestamp: 1 }).select({ timestamp: 1 }).lean();
    const end = oldest ? oldest.timestamp.getTime() - 1000 : Date.now();
    const start = end - days * 24 * 60 * 60 * 1000;

    const events = generate(start, end);
    for (let i = 0; i < events.length; i += 5000) {
        await Event.insertMany(events.slice(i, i + 5000), { lean: true });
    }
    console.log(`added ${events.length} events to ${database}: ${new Date(start).toISOString()} to ${new Date(end).toISOString()}`);
})()
    .catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
