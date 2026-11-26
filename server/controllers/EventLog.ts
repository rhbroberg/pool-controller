'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';

var utils = require('../utils/writer');
var EventLog = require('../service/EventLogService');

module.exports.getEvents = function getEvents (req: AuthedRequest, res: Response) {
  var params = req.swagger.params;
  EventLog.getEvents(params['types'].value, params['user'].value, params['cursor'].value, params['order'].value, params['limit'].value)
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
