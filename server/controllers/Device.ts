'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

var utils = require('../utils/writer');
var Device = require('../service/DeviceService');

module.exports.getDeviceState = function getDeviceState (req: AuthedRequest, res: Response) {
  var deviceId = swaggerValue<string>(req, 'deviceId');
  Device.getDeviceState(deviceId)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

module.exports.getDevices = function getDevices (req: AuthedRequest, res: Response) {
  var skip = swaggerValue<number>(req, 'skip');
  var limit = swaggerValue<number>(req, 'limit');
  Device.getDevices(skip,limit)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

module.exports.registerDevice = function registerDevice (req: AuthedRequest, res: Response) {
  var deviceId = swaggerValue<string>(req, 'deviceId');
  Device.registerDevice(deviceId)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

module.exports.setDeviceState = function setDeviceState (req: AuthedRequest, res: Response) {
  var deviceId = swaggerValue<string>(req, 'deviceId');
  var state = swaggerValue<string>(req, 'state');
  Device.setDeviceState(deviceId, state, req.user)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};
