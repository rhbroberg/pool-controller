'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

var utils = require('../utils/writer');
var Lighting = require('../service/LightingService');

module.exports.getLightingState = function getLightingState (req: AuthedRequest, res: Response) {
  var lightId = swaggerValue(req, 'lightId');
  Lighting.getLightingState(lightId)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.getLights = function getLights (req: AuthedRequest, res: Response) {
  Lighting.getLights()
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.setLightingState = function setLightingState (req: AuthedRequest, res: Response) {
  var lightId = swaggerValue(req, 'lightId');
  var state = swaggerValue(req, 'state');
  Lighting.setLightingState(lightId,state)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};
