'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';

var utils = require('../utils/writer');
var Status = require('../service/StatusService');

module.exports.getCurrentStatus = function getCurrentStatus (req: AuthedRequest, res: Response) {
  Status.getCurrentStatus()
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, { code: 500, message: String(response) }, 500);
    });
};
