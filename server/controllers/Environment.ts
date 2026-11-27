'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

var utils = require('../utils/writer');
var Environment = require('../service/EnvironmentService');

module.exports.getHeaterState = function getHeaterState (req: AuthedRequest, res: Response) {
  var poolId = swaggerValue(req, 'poolId');
  Environment.getHeaterState(poolId)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

module.exports.getPoolTemperature = function getPoolTemperature (req: AuthedRequest, res: Response) {
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

module.exports.setHeaterState = function setHeaterState (req: AuthedRequest, res: Response) {
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

module.exports.temperatureSummary = function temperatureSummary (req: AuthedRequest, res: Response) {
  Environment.temperatureSummary()
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};
