'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

import * as utils from '../utils/writer';
import * as Environment from '../service/EnvironmentService';

export function getHeaterState(req: AuthedRequest, res: Response) {
  var poolId = swaggerValue(req, 'poolId');
  Environment.getHeaterState(poolId)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

export function getPoolTemperature(req: AuthedRequest, res: Response) {
  var poolId = swaggerValue(req, 'poolId');
  var date = swaggerValue(req, 'date');
  var limit = swaggerValue<number>(req, 'limit');
  Environment.getPoolTemperature(poolId,date,limit)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

export function setHeaterState(req: AuthedRequest, res: Response) {
  var poolId = swaggerValue(req, 'poolId');
  var state = swaggerValue<string>(req, 'state');
  Environment.setHeaterState(poolId,state)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

export function temperatureSummary(req: AuthedRequest, res: Response) {
  Environment.temperatureSummary()
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};
