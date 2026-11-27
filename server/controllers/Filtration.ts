'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

import * as utils from '../utils/writer';
import * as Filtration from '../service/FiltrationService';

export function getFiltrationDevices(req: AuthedRequest, res: Response) {
  Filtration.getFiltrationDevices()
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

export function getFiltrationState(req: AuthedRequest, res: Response) {
  var pumpId = swaggerValue<string>(req, 'pumpId');
  Filtration.getFiltrationState(pumpId)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

export function setFiltrationState(req: AuthedRequest, res: Response) {
  var pumpId = swaggerValue<string>(req, 'pumpId');
  var state = swaggerValue<string>(req, 'state');
  Filtration.setFiltrationState(pumpId,state)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};
