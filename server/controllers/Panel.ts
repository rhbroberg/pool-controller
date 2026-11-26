'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

var utils = require('../utils/writer');
var Panel = require('../service/PanelService');

module.exports.getPanelDisplay = function getPanelDisplay (req: AuthedRequest, res: Response) {
  Panel.getPanelDisplay()
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.pressPanelKey = function pressPanelKey (req: AuthedRequest, res: Response) {
  var key = swaggerValue(req, 'key');
  Panel.pressPanelKey(key, req.user)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};
