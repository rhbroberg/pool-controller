'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

var utils = require('../utils/writer');
var History = require('../service/HistoryService');

module.exports.getHistory = function getHistory (req: AuthedRequest, res: Response) {
  var names = swaggerValue(req, 'names');
  var from = swaggerValue(req, 'from');
  var to = swaggerValue(req, 'to');
  var maxPoints = swaggerValue(req, 'maxPoints');
  var resolution = swaggerValue(req, 'resolution');
  History.getHistory(names, from, to, maxPoints, resolution)
    .then(function (response: any) {
      utils.writeJson(res, response);
    })
    .catch(function (response: any) {
      utils.writeJson(res, response);
    });
};

module.exports.getHistoryAvailability = function getHistoryAvailability (req: AuthedRequest, res: Response) {
  History.getAvailability(swaggerValue(req, 'from'), swaggerValue(req, 'to'), swaggerValue(req, 'names'))
    .then(function (response: any) {
      utils.writeJson(res, response);
    })
    .catch(function (response: any) {
      utils.writeJson(res, response);
    });
};
