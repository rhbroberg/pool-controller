'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';
import { ApiError } from '../utils/writer';

var utils = require('../utils/writer');
var System = require('../service/SystemService');
var Settings = require('../service/SettingsService');
var Reprocess = require('../service/ReprocessService');
var scheduler = require('../jobs/scheduler');

var answer = (res: any, promise: any) => promise
  .then(function (response: unknown) {
    utils.writeJson(res, response);
  })
  .catch(function (response: unknown) {
    if (response instanceof ApiError) {
      utils.writeJson(res, response.body, response.code);
      return;
    }
    if (response instanceof Error) {
      utils.writeJson(res, { code: 500, message: response.message }, 500);
      return;
    }
    utils.writeJson(res, response);
  });

module.exports.getSettings = function getSettings (req: AuthedRequest, res: Response) {
  answer(res, Settings.getSettings());
};

module.exports.updateSettings = function updateSettings (req: AuthedRequest, res: Response) {
  answer(res, Settings.updateSettings(swaggerValue<Record<string, unknown>>(req, 'changes'), req.user));
};

module.exports.listJobs = function listJobs (req: AuthedRequest, res: Response) {
  answer(res, scheduler.status());
};

module.exports.runJob = function runJob (req: AuthedRequest, res: Response) {
  var name = swaggerValue<string>(req, 'name');
  if (!scheduler.has(name)) {
    utils.writeJson(res, { code: 404, message: `there is no job named ${name}` }, 404);
    return;
  }
  answer(res, scheduler.runNow(name).then(function (status: any) {
    if (status.busy) {
      throw utils.respondWithCode(409, { code: 409, message: `${name} is already running in another process` });
    }
    delete status.busy;
    return status;
  }));
};

module.exports.startReprocess = function startReprocess (req: AuthedRequest, res: Response) {
  answer(res, Reprocess.start(swaggerValue<Record<string, unknown>>(req, 'request'), req.user).then(function (run: any) {
    return utils.respondWithCode(202, run);
  }));
};

module.exports.getReprocess = function getReprocess (req: AuthedRequest, res: Response) {
  answer(res, Reprocess.status().then(function (run: any) {
    return run || utils.respondWithCode(404, { code: 404, message: 'history hasn’t been reprocessed since the server started' });
  }));
};

module.exports.getSystemInfo = function getSystemInfo (req: AuthedRequest, res: Response) {
  utils.writeJson(res, System.info());
};

module.exports.factoryReset = function factoryReset (req: AuthedRequest, res: Response) {
  System.factoryReset(req.user)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

module.exports.restartServer = function restartServer (req: AuthedRequest, res: Response) {
  System.restart(req.user)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};
