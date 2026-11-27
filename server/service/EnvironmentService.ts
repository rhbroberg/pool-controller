'use strict';

import '../config/config';
import { Event } from '../models/event';
import * as heatingService from './HeatingService';
import log4js from 'log4js';
var logger = log4js.getLogger();

// lines up with strings in db storage
const tempNames: Record<string, string> = {
    'pool': 'pool temp',
    'spa': 'spa temp'
};

/**
 * gets the state of the heater
 *
 * poolId String 
 * returns HeaterState
 **/
export async function getHeaterState(poolId: any) {
    const heater = (await heatingService.getHeating()).devices.heater1;
    return {
        'id': 'heater1',
        'units': 'fahrenheit',
        'timestamp': new Date().toISOString(),
        'state': heater.enabled ? 'on' : 'off',
        'setPoint': heatingService.setpoint(poolId, 'heater1')
    };
};


/**
 *
 * poolId String 
 * returns TemperatueZoneStatus
 **/
export async function getPoolTemperature(poolId: any, date: any, limit: any) {
    var statuses = [] as any[];
    var examples: any = {};

    if (typeof date === 'undefined') {
        await getMostRecentInfo(tempNames[poolId], statuses);
    } else {
        var temperatures = [] as any[];
        const events = await Event.find({
            'eventType': 'info',
            'status': { $elemMatch: { 'name': 'pool temp' } },
            timestamp: { $gte: date }
        }).select('timestamp').select('status').sort('timestamp').limit(typeof limit !== 'undefined' ? limit : 0);

        let lastTime: any;
        events.forEach(function(event: any) {
            logger.trace('event: ', event.timestamp, event.status[0].value);
            if (limit === -1 /* code disabled for now; option to fill in time slots*/ ) {
                const nextTime = new Date(event.timestamp).getTime();
                if (typeof lastTime !== 'undefined') {
                    logger.trace('comparing old ', lastTime, ' to new ', nextTime);
                    for (let makeup = lastTime + 60 * 60 * 1000; makeup < nextTime + 60 * 60 * 1000; makeup += 60 * 60 * 1000) {
                        logger.trace('making up time', new Date(makeup));
                        temperatures.push([new Date(makeup), event.status[0].value]);
                    }
                }
                lastTime = nextTime;
            }
            temperatures.push([event.timestamp, event.status[0].value]);
        });
        statuses.push({
            'name': tempNames[poolId],
            'units': 'fahrenheit',
            'values': temperatures
        });
    }

    examples['application/json'] = {
        'zoneStatus': statuses
    };

    if (Object.keys(examples).length > 0) {
        return examples[Object.keys(examples)[0]];
    }
};


/**
 * turns the heater on or off
 *
 * poolId String 
 * state String 
 * returns ApiResponse
 **/
export function setHeaterState(poolId: any, state: any) { // eslint-disable-line no-unused-vars
    return new Promise<any>(function(resolve, reject) { // eslint-disable-line no-unused-vars
        var examples: any = {};
        examples['application/json'] = {
            'code': 0,
            'message': 'everything is ok'
        };
        if (Object.keys(examples).length > 0) {
            resolve(examples[Object.keys(examples)[0]]);
        } else {
            resolve(undefined);
        }
    });
};

async function getMostRecentInfo(name: any, statuses: any) {
    const doc = await Event.findOne({ eventType: 'info', 'status': { $elemMatch: { 'name': name } } }).sort({ timestamp: -1 });
    logger.debug('found newest env for ', name, doc);
    if (doc) {
        statuses.push({
            'name': doc.status[0].name,
            'id': doc.status[0]._id,
            'units': 'fahrenheit',
            'value': doc.status[0].value,
            'timestamp': doc.timestamp
        });
    }
}

var controlCB; // eslint-disable-line no-unused-vars

export function registerControlListener(cb: any) {
    controlCB = cb;
};

/**
 *
 * returns TemperatureSummary
 **/
export async function temperatureSummary() {
    var examples: any = {};
    var statuses = [] as any[];

    await getMostRecentInfo('ambient', statuses);
    await getMostRecentInfo('pool temp', statuses);
    await getMostRecentInfo('spa temp', statuses);

    examples['application/json'] = {
        'zoneStatus': statuses
    };

    if (Object.keys(examples).length > 0) {
        return examples[Object.keys(examples)[0]];
    }
};
