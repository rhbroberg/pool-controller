'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';

var utils = require('../utils/writer');
var Filtration = require('../service/FiltrationService');

module.exports.getFiltrationDevices = function getFiltrationDevices (req: AuthedRequest, res: Response) {
  Filtration.getFiltrationDevices()
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.getFiltrationState = function getFiltrationState (req: AuthedRequest, res: Response) {
  var pumpId = req.swagger.params['pumpId'].value;
  Filtration.getFiltrationState(pumpId)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.setFiltrationState = function setFiltrationState (req: AuthedRequest, res: Response) {
  var pumpId = req.swagger.params['pumpId'].value;
  var state = req.swagger.params['state'].value;
  Filtration.setFiltrationState(pumpId,state)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};
