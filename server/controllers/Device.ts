'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';

var utils = require('../utils/writer');
var Device = require('../service/DeviceService');

module.exports.getDeviceState = function getDeviceState (req: AuthedRequest, res: Response) {
  var deviceId = req.swagger.params['deviceId'].value;
  Device.getDeviceState(deviceId)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.getDevices = function getDevices (req: AuthedRequest, res: Response) {
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

module.exports.registerDevice = function registerDevice (req: AuthedRequest, res: Response) {
  var deviceId = req.swagger.params['deviceId'].value;
  Device.registerDevice(deviceId)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.setDeviceState = function setDeviceState (req: AuthedRequest, res: Response) {
  var deviceId = req.swagger.params['deviceId'].value;
  var state = req.swagger.params['state'].value;
  Device.setDeviceState(deviceId, state, req.user)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};
