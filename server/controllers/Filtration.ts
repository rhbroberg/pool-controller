'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

var utils = require('../utils/writer');
var Filtration = require('../service/FiltrationService');

module.exports.getFiltrationDevices = function getFiltrationDevices (req: AuthedRequest, res: Response) {
  Filtration.getFiltrationDevices()
    .then(function (response: any) {
      utils.writeJson(res, response);
    })
    .catch(function (response: any) {
      utils.writeJson(res, response);
    });
};

module.exports.getFiltrationState = function getFiltrationState (req: AuthedRequest, res: Response) {
  var pumpId = swaggerValue(req, 'pumpId');
  Filtration.getFiltrationState(pumpId)
    .then(function (response: any) {
      utils.writeJson(res, response);
    })
    .catch(function (response: any) {
      utils.writeJson(res, response);
    });
};

module.exports.setFiltrationState = function setFiltrationState (req: AuthedRequest, res: Response) {
  var pumpId = swaggerValue(req, 'pumpId');
  var state = swaggerValue(req, 'state');
  Filtration.setFiltrationState(pumpId,state)
    .then(function (response: any) {
      utils.writeJson(res, response);
    })
    .catch(function (response: any) {
      utils.writeJson(res, response);
    });
};
