'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

var utils = require('../utils/writer');
var EventLog = require('../service/EventLogService');

module.exports.getEvents = function getEvents (req: AuthedRequest, res: Response) {
  EventLog.getEvents(swaggerValue(req, 'types'), swaggerValue(req, 'user'), swaggerValue(req, 'cursor'), swaggerValue(req, 'order'), swaggerValue(req, 'limit'))
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.getEventUsers = function getEventUsers (req: AuthedRequest, res: Response) {
  EventLog.getEventUsers()
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};
