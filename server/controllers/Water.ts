'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

var utils = require('../utils/writer');
var Water = require('../service/WaterService');

module.exports.setWaterMode = function setWaterMode (req: AuthedRequest, res: Response) {
  Water.setWaterMode(swaggerValue(req, 'mode'), req.user)
    .then(function (response: any) {
      utils.writeJson(res, response);
    })
    .catch(function (response: any) {
      utils.writeJson(res, response);
    });
};
