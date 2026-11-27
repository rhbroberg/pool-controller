'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

var utils = require('../utils/writer');
var EventLog = require('../service/EventLogService');

module.exports.getEvents = function getEvents (req: AuthedRequest, res: Response) {
  EventLog.getEvents(swaggerValue<string | string[]>(req, 'types'), swaggerValue<string | undefined>(req, 'user'), swaggerValue<string | undefined>(req, 'cursor'), swaggerValue<string | undefined>(req, 'order'), swaggerValue<number>(req, 'limit'))
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

module.exports.getEventUsers = function getEventUsers (req: AuthedRequest, res: Response) {
  EventLog.getEventUsers()
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};
