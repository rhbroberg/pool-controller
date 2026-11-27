'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

import * as utils from '../utils/writer';
import * as Device from '../service/DeviceService';

export function getDeviceState(req: AuthedRequest, res: Response) {
  var deviceId = swaggerValue<string>(req, 'deviceId');
  Device.getDeviceState(deviceId)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

export function getDevices(req: AuthedRequest, res: Response) {
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

export function registerDevice(req: AuthedRequest, res: Response) {
  var deviceId = swaggerValue<string>(req, 'deviceId');
  Device.registerDevice(deviceId)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

export function setDeviceState(req: AuthedRequest, res: Response) {
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
