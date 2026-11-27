'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';
import { ApiError } from '../utils/writer';

import * as utils from '../utils/writer';
import * as Heating from '../service/HeatingService';
import * as HeatingModel from '../service/HeatingModelService';

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

export function getHeating(req: AuthedRequest, res: Response) {
  Heating.getHeating()
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

export function getSetpoint(req: AuthedRequest, res: Response) {
  Heating.getSetpoint(swaggerValue<string>(req, 'body'), swaggerValue<string>(req, 'device'))
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

export function setSetpoint(req: AuthedRequest, res: Response) {
  Heating.setSetpoint(swaggerValue<string>(req, 'body'), swaggerValue<string>(req, 'device'),
                      swaggerValue<number>(req, 'degrees'), req.user)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

export function getHeatingModel(req: AuthedRequest, res: Response) {
  answer(res, HeatingModel.getModel());
};

export function saveHeatingModel(req: AuthedRequest, res: Response) {
  answer(res, HeatingModel.save(swaggerValue<Record<string, unknown>>(req, 'request'), req.user));
};

export function startHeatingScan(req: AuthedRequest, res: Response) {
  const body = (req.swagger.params['request'] ? swaggerValue<Record<string, unknown>>(req, 'request') : undefined);
  answer(res, HeatingModel.startScan(body || {}, req.user).then(function (scan: any) {
    return utils.respondWithCode(202, scan);
  }));
};

export function getHeatingScan(req: AuthedRequest, res: Response) {
  answer(res, HeatingModel.getScan().then(function (scan: any) {
    return scan || utils.respondWithCode(404, { code: 404, message: 'history hasn’t been scanned since the server started' });
  }));
};

export function getHeatingWindows(req: AuthedRequest, res: Response) {
  answer(res, HeatingModel.getWindows());
};

export function previewHeatingModel(req: AuthedRequest, res: Response) {
  answer(res, HeatingModel.preview(swaggerValue<Record<string, unknown>>(req, 'request')));
};
