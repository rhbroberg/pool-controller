'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

import * as utils from '../utils/writer';
import * as Panel from '../service/PanelService';

export function getPanelDisplay(req: AuthedRequest, res: Response) {
  Panel.getPanelDisplay()
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

export function pressPanelKey(req: AuthedRequest, res: Response) {
  var key = swaggerValue<string>(req, 'key');
  Panel.pressPanelKey(key, req.user)
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};
