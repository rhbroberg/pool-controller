'use strict';


/**
 * gets the state of the heater
 *
 * poolId String 
 * returns HeaterState
 **/
exports.getHeaterState = function(poolId) {
  return new Promise(function(resolve, reject) {
    var examples = {};
    examples['application/json'] = {
  "id" : "id",
  "state" : "state"
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
 * poolId String 
 * returns TemperatueZoneStatus
 **/
exports.getPoolTemperature = function(poolId) {
  return new Promise(function(resolve, reject) {
    var examples = {};
    examples['application/json'] = {
  "name" : "name",
  "id" : "id",
  "units" : "fahrenheit",
  "value" : 5.962133916683182,
  "timestamp" : "2000-01-23T04:56:07.000+00:00"
};
    if (Object.keys(examples).length > 0) {
      resolve(examples[Object.keys(examples)[0]]);
    } else {
      resolve();
    }
  });
}


/**
 * turns the heater on or off
 *
 * poolId String 
 * state String 
 * returns ApiResponse
 **/
exports.setHeaterState = function(poolId,state) {
  return new Promise(function(resolve, reject) {
    var examples = {};
    examples['application/json'] = {
  "code" : 0,
  "message" : "everything is ok"
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
 * returns TemperatureSummary
 **/
exports.temperatureSummary = function() {
  return new Promise(function(resolve, reject) {
    var examples = {};
    examples['application/json'] = {
  "zoneStatus" : [ {
    "name" : "name",
    "id" : "id",
    "units" : "fahrenheit",
    "value" : 5.962133916683182,
    "timestamp" : "2000-01-23T04:56:07.000+00:00"
  }, {
    "name" : "name",
    "id" : "id",
    "units" : "fahrenheit",
    "value" : 5.962133916683182,
    "timestamp" : "2000-01-23T04:56:07.000+00:00"
  } ],
  "zones" : [ {
    "inputPosition" : 6,
    "outputPosition" : 1,
    "zone" : "zone",
    "name" : "name",
    "id" : 0
  }, {
    "inputPosition" : 6,
    "outputPosition" : 1,
    "zone" : "zone",
    "name" : "name",
    "id" : 0
  } ]
};
    if (Object.keys(examples).length > 0) {
      resolve(examples[Object.keys(examples)[0]]);
    } else {
      resolve();
    }
  });
}

