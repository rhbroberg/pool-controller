'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

var utils = require('../utils/writer');
var Filtration = require('../service/FiltrationService');

module.exports.getFiltrationDevices = function getFiltrationDevices (req: AuthedRequest, res: Response) {
  Filtration.getFiltrationDevices()
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

module.exports.getFiltrationState = function getFiltrationState (req: AuthedRequest, res: Response) {
  var pumpId = swaggerValue<string>(req, 'pumpId');
  Filtration.getFiltrationState(pumpId)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

module.exports.setFiltrationState = function setFiltrationState (req: AuthedRequest, res: Response) {
  var pumpId = swaggerValue<string>(req, 'pumpId');
  var state = swaggerValue<string>(req, 'state');
  Filtration.setFiltrationState(pumpId,state)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};
