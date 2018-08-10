'use strict';


/**
 *
 * deviceId String 
 * no response value expected for this operation
 **/
exports.getDeviceState = function(deviceId) {
  return new Promise(function(resolve, reject) {
    resolve();
  });
}


/**
 * returns all configured devices
 *
 * skip Integer number of records to skip (optional)
 * limit Integer max number of records to return (optional)
 * returns List
 **/
exports.getDevices = function(skip,limit) {
  return new Promise(function(resolve, reject) {
    var examples = {};
    examples['application/json'] = [ "http://10.0.0.225:8080", "http://10.0.0.225:8080" ];
    if (Object.keys(examples).length > 0) {
      resolve(examples[Object.keys(examples)[0]]);
    } else {
      resolve();
    }
  });
}


/**
 *
 * deviceId String 
 * returns DeviceRegistrationInfo
 **/
exports.registerDevice = function(deviceId) {
  return new Promise(function(resolve, reject) {
    var examples = {};
    examples['application/json'] = {
  "id" : "0729a580-2240-11e6-9eb5-0002a5d5c51b",
  "uri" : "http://10.0.0.220:8080"
};
    if (Object.keys(examples).length > 0) {
      resolve(examples[Object.keys(examples)[0]]);
    } else {
      resolve();
    }
  });
}


/**
 *
 * deviceId String 
 * state String 
 * returns DeviceState
 **/
exports.setDeviceState = function(deviceId,state) {
  return new Promise(function(resolve, reject) {
    var examples = {};
    examples['application/json'] = {
  "level" : 0,
  "lastUpdate" : "2000-01-23T04:56:07.000+00:00",
  "name" : "name",
  "id" : "id"
};
    if (Object.keys(examples).length > 0) {
      resolve(examples[Object.keys(examples)[0]]);
    } else {
      resolve();
    }
  });
}

