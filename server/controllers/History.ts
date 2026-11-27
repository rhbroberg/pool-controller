'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

var utils = require('../utils/writer');
var History = require('../service/HistoryService');

module.exports.getHistory = function getHistory (req: AuthedRequest, res: Response) {
  var names = swaggerValue<string | string[]>(req, 'names');
  var from = swaggerValue<string>(req, 'from');
  var to = swaggerValue<string>(req, 'to');
  var maxPoints = swaggerValue<number | undefined>(req, 'maxPoints');
  var resolution = swaggerValue<number | undefined>(req, 'resolution');
  History.getHistory(names, from, to, maxPoints, resolution)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

module.exports.getHistoryAvailability = function getHistoryAvailability (req: AuthedRequest, res: Response) {
  History.getAvailability(swaggerValue<string>(req, 'from'), swaggerValue<string>(req, 'to'), swaggerValue<string | string[]>(req, 'names'))
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};
