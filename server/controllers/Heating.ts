'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';

var utils = require('../utils/writer');
var Heating = require('../service/HeatingService');
var HeatingModel = require('../service/HeatingModelService');

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

module.exports.getHeating = function getHeating (req: AuthedRequest, res: Response) {
  Heating.getHeating()
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.getSetpoint = function getSetpoint (req: AuthedRequest, res: Response) {
  Heating.getSetpoint(req.swagger.params['body'].value, req.swagger.params['device'].value)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.setSetpoint = function setSetpoint (req: AuthedRequest, res: Response) {
  Heating.setSetpoint(req.swagger.params['body'].value, req.swagger.params['device'].value,
                      req.swagger.params['degrees'].value, req.user)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.getHeatingModel = function getHeatingModel (req: AuthedRequest, res: Response) {
  answer(res, HeatingModel.getModel());
};

module.exports.saveHeatingModel = function saveHeatingModel (req: AuthedRequest, res: Response) {
  answer(res, HeatingModel.save(req.swagger.params['request'].value, req.user));
};

module.exports.startHeatingScan = function startHeatingScan (req: AuthedRequest, res: Response) {
  const body = req.swagger.params['request'] ? req.swagger.params['request'].value : undefined;
  answer(res, HeatingModel.startScan(body || {}, req.user).then(function (scan) {
    return utils.respondWithCode(202, scan);
  }));
};

module.exports.getHeatingScan = function getHeatingScan (req: AuthedRequest, res: Response) {
  answer(res, HeatingModel.getScan().then(function (scan) {
    return scan || utils.respondWithCode(404, { code: 404, message: 'history hasn’t been scanned since the server started' });
  }));
};

module.exports.getHeatingWindows = function getHeatingWindows (req: AuthedRequest, res: Response) {
  answer(res, HeatingModel.getWindows());
};

module.exports.previewHeatingModel = function previewHeatingModel (req: AuthedRequest, res: Response) {
  answer(res, HeatingModel.preview(req.swagger.params['request'].value));
};
