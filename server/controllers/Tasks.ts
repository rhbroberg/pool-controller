'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';

var utils = require('../utils/writer');
var Tasks = require('../service/TaskService');

var answer = (res, promise) => promise
  .then(function (response) {
    utils.writeJson(res, response);
  })
  .catch(function (response) {
    if (response instanceof Error) {
      utils.writeJson(res, { code: 500, message: response.message }, 500);
      return;
    }
    utils.writeJson(res, response);
  });

module.exports.getTasks = function getTasks (req: AuthedRequest, res: Response) {
  answer(res, Tasks.getTasks());
};

module.exports.setPoolTask = function setPoolTask (req: AuthedRequest, res: Response) {
  const change = req.swagger.params['change'].value as { on: boolean };
  answer(res, Tasks.setPool(change.on, req.user));
};

module.exports.setSpaPreheatTask = function setSpaPreheatTask (req: AuthedRequest, res: Response) {
  const change = req.swagger.params['change'].value as { on: boolean; readyAt?: string };
  answer(res, Tasks.setSpaPreheat(change.on, change.readyAt, req.user));
};

module.exports.setSpaPartyTask = function setSpaPartyTask (req: AuthedRequest, res: Response) {
  const change = req.swagger.params['change'].value as { on: boolean };
  answer(res, Tasks.setSpaParty(change.on, req.user));
};
