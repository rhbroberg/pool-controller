'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';

import * as utils from '../utils/writer';
import * as Status from '../service/StatusService';

export function getCurrentStatus(req: AuthedRequest, res: Response) {
  Status.getCurrentStatus()
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, { code: 500, message: String(response) }, 500);
    });
};
