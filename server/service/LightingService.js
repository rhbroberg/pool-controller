'use strict';


/**
 *
 * lightId String 
 * returns LightingZoneStatus
 **/
exports.getLightingState = function(lightId) { // eslint-disable-line no-unused-vars
    return new Promise(function(resolve, reject) { // eslint-disable-line no-unused-vars
        var examples = {};
        examples['application/json'] = {
            'level': 0,
            'lastUpdate': '2000-01-23T04:56:07.000+00:00',
            'name': 'name',
            'id': 'id'
        };
        if (Object.keys(examples).length > 0) {
            resolve(examples[Object.keys(examples)[0]]);
        } else {
            resolve();
        }
    });
};


/**
 *
 * returns List
 **/
exports.getLights = function() {
    return new Promise(function(resolve, reject) { // eslint-disable-line no-unused-vars
        var examples = {};
        examples['application/json'] = ['', ''];
        if (Object.keys(examples).length > 0) {
            resolve(examples[Object.keys(examples)[0]]);
        } else {
            resolve();
        }
    });
};


/**
 *
 * lightId String 
 * state String 
 * returns LightingZoneStatus
 **/
exports.setLightingState = function(lightId, state) { // eslint-disable-line no-unused-vars
    return new Promise(function(resolve, reject) { // eslint-disable-line no-unused-vars
        var examples = {};
        examples['application/json'] = {
            'level': 0,
            'lastUpdate': '2000-01-23T04:56:07.000+00:00',
            'name': 'name',
            'id': 'id'
        };
        if (Object.keys(examples).length > 0) {
            resolve(examples[Object.keys(examples)[0]]);
        } else {
            resolve();
        }
    });
};
