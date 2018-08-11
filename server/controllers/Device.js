'use strict';

var utils = require('../utils/writer.js');
var Device = require('../service/DeviceService');

module.exports.getDeviceState = function getDeviceState (req, res, next) {
  var deviceId = req.swagger.params['deviceId'].value;
  Device.getDeviceState(deviceId)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.getDevices = function getDevices (req, res, next) {
  var skip = req.swagger.params['skip'].value;
  var limit = req.swagger.params['limit'].value;
  Device.getDevices(skip,limit)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.registerDevice = function registerDevice (req, res, next) {
  var deviceId = req.swagger.params['deviceId'].value;
  Device.registerDevice(deviceId)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.setDeviceState = function setDeviceState (req, res, next) {
  var deviceId = req.swagger.params['deviceId'].value;
  var state = req.swagger.params['state'].value;
  Device.setDeviceState(deviceId,state)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};
