'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';
import { ApiError } from '../utils/writer';

var utils = require('../utils/writer');
var Heating = require('../service/HeatingService');
var HeatingModel = require('../service/HeatingModelService');

var answer = (res: any, promise: any) => promise
  .then(function (response: any) {
    utils.writeJson(res, response);
  })
  .catch(function (response: any) {
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

module.exports.getHeating = function getHeating (req: AuthedRequest, res: Response) {
  Heating.getHeating()
    .then(function (response: any) {
      utils.writeJson(res, response);
    })
    .catch(function (response: any) {
      utils.writeJson(res, response);
    });
};

module.exports.getSetpoint = function getSetpoint (req: AuthedRequest, res: Response) {
  Heating.getSetpoint(swaggerValue(req, 'body'), swaggerValue(req, 'device'))
    .then(function (response: any) {
      utils.writeJson(res, response);
    })
    .catch(function (response: any) {
      utils.writeJson(res, response);
    });
};

module.exports.setSetpoint = function setSetpoint (req: AuthedRequest, res: Response) {
  Heating.setSetpoint(swaggerValue(req, 'body'), swaggerValue(req, 'device'),
                      swaggerValue(req, 'degrees'), req.user)
    .then(function (response: any) {
      utils.writeJson(res, response);
    })
    .catch(function (response: any) {
      utils.writeJson(res, response);
    });
};

module.exports.getHeatingModel = function getHeatingModel (req: AuthedRequest, res: Response) {
  answer(res, HeatingModel.getModel());
};

module.exports.saveHeatingModel = function saveHeatingModel (req: AuthedRequest, res: Response) {
  answer(res, HeatingModel.save(swaggerValue(req, 'request'), req.user));
};

module.exports.startHeatingScan = function startHeatingScan (req: AuthedRequest, res: Response) {
  const body = (req.swagger.params['request'] ? swaggerValue(req, 'request') : undefined);
  answer(res, HeatingModel.startScan(body || {}, req.user).then(function (scan: any) {
    return utils.respondWithCode(202, scan);
  }));
};

module.exports.getHeatingScan = function getHeatingScan (req: AuthedRequest, res: Response) {
  answer(res, HeatingModel.getScan().then(function (scan: any) {
    return scan || utils.respondWithCode(404, { code: 404, message: 'history hasn’t been scanned since the server started' });
  }));
};

module.exports.getHeatingWindows = function getHeatingWindows (req: AuthedRequest, res: Response) {
  answer(res, HeatingModel.getWindows());
};

module.exports.previewHeatingModel = function previewHeatingModel (req: AuthedRequest, res: Response) {
  answer(res, HeatingModel.preview(swaggerValue(req, 'request')));
};
