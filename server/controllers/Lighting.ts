'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

import * as utils from '../utils/writer';
import * as Lighting from '../service/LightingService';

export function getLightingState(req: AuthedRequest, res: Response) {
  var lightId = swaggerValue<string>(req, 'lightId');
  Lighting.getLightingState(lightId)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

export function getLights(req: AuthedRequest, res: Response) {
  Lighting.getLights()
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

export function setLightingState(req: AuthedRequest, res: Response) {
  var lightId = swaggerValue<string>(req, 'lightId');
  var state = swaggerValue<string>(req, 'state');
  Lighting.setLightingState(lightId,state)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};
