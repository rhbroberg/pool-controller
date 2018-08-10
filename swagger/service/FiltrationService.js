'use strict';


/**
 * returns all registered devices
 *
 * skip Integer number of records to skip (optional)
 * limit Integer max number of records to return (optional)
 * returns List
 **/
exports.getFiltrationDevices = function(skip,limit) {
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
 * pumpId String 
 * returns ApiResponse
 **/
exports.getFiltrationState = function(pumpId) {
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
 * pumpId String 
 * state String 
 * returns ApiResponse
 **/
exports.setFiltrationState = function(pumpId,state) {
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

