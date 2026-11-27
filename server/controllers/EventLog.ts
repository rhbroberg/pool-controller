'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

import * as utils from '../utils/writer';
import * as EventLog from '../service/EventLogService';

export function getEvents(req: AuthedRequest, res: Response) {
  EventLog.getEvents(swaggerValue<string | string[]>(req, 'types'), swaggerValue<string | undefined>(req, 'user'), swaggerValue<string | undefined>(req, 'cursor'), swaggerValue<string | undefined>(req, 'order'), swaggerValue<number>(req, 'limit'))
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};

export function getEventUsers(req: AuthedRequest, res: Response) {
  EventLog.getEventUsers()
    .then(function (response: unknown) {
      utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
      utils.writeJson(res, response);
    });
};
