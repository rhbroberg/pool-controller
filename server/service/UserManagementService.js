'use strict';


/**
 *
 * returns User
 **/
exports.createUser = function() {
  return new Promise(function(resolve, reject) {
    var examples = {};
    examples['application/json'] = {
  "id" : "id",
  "email" : "email"
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
 * returns User
 **/
exports.getUser = function() {
  return new Promise(function(resolve, reject) {
    var examples = {};
    examples['application/json'] = {
  "id" : "id",
  "email" : "email"
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
 * returns User
 **/
exports.loginUser = function() {
  return new Promise(function(resolve, reject) {
    var examples = {};
    examples['application/json'] = {
  "id" : "id",
  "email" : "email"
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
 * no response value expected for this operation
 **/
exports.logoutUser = function() {
  return new Promise(function(resolve, reject) {
    resolve();
  });
}

