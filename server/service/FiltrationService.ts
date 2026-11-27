'use strict';

import '../config/config';
import log4js from 'log4js';
var logger = log4js.getLogger(); // eslint-disable-line no-unused-vars


/**
 * returns all filtration devices
 *
 * returns List
 **/
export function getFiltrationDevices() {
    return new Promise<any>(function(resolve, reject) { // eslint-disable-line no-unused-vars
        var examples: any = {};
        examples['application/json'] = ['pool', 'spa'];
        if (Object.keys(examples).length > 0) {
            resolve(examples[Object.keys(examples)[0]]);
        } else {
            resolve(undefined);
        }
    });
};


/**
 *
 * pumpId String 
 * returns ApiResponse
 **/
export function getFiltrationState(pumpId: any) { // eslint-disable-line no-unused-vars
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


/**
 *
 * pumpId String 
 * state String 
 * returns ApiResponse
 **/
export function setFiltrationState(pumpId: any, state: any) { // eslint-disable-line no-unused-vars
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
