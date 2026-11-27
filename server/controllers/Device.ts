'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

var utils = require('../utils/writer');
var Device = require('../service/DeviceService');

module.exports.getDeviceState = function getDeviceState (req: AuthedRequest, res: Response) {
  var deviceId = swaggerValue(req, 'deviceId');
  Device.getDeviceState(deviceId)
    .then(function (response: any) {
      utils.writeJson(res, response);
    })
    .catch(function (response: any) {
      utils.writeJson(res, response);
    });
};

module.exports.getDevices = function getDevices (req: AuthedRequest, res: Response) {
  var skip = swaggerValue(req, 'skip');
  var limit = swaggerValue(req, 'limit');
  Device.getDevices(skip,limit)
    .then(function (response: any) {
      utils.writeJson(res, response);
    })
    .catch(function (response: any) {
      utils.writeJson(res, response);
    });
};

module.exports.registerDevice = function registerDevice (req: AuthedRequest, res: Response) {
  var deviceId = swaggerValue(req, 'deviceId');
  Device.registerDevice(deviceId)
    .then(function (response: any) {
      utils.writeJson(res, response);
    })
    .catch(function (response: any) {
      utils.writeJson(res, response);
    });
};

module.exports.setDeviceState = function setDeviceState (req: AuthedRequest, res: Response) {
  var deviceId = swaggerValue(req, 'deviceId');
  var state = swaggerValue(req, 'state');
  Device.setDeviceState(deviceId, state, req.user)
    .then(function (response: any) {
      utils.writeJson(res, response);
    })
    .catch(function (response: any) {
      utils.writeJson(res, response);
    });
};
