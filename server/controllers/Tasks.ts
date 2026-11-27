'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';
import { ApiError } from '../utils/writer';

import * as utils from '../utils/writer';
import * as Tasks from '../service/TaskService';

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

export function getTasks(req: AuthedRequest, res: Response) {
  answer(res, Tasks.getTasks());
};

export function setPoolTask(req: AuthedRequest, res: Response) {
  const change = swaggerValue<{ on: boolean; readyAt?: string }>(req, 'change') as { on: boolean };
  answer(res, Tasks.setPool(change.on, req.user));
};

export function setSpaPreheatTask(req: AuthedRequest, res: Response) {
  const change = swaggerValue<{ on: boolean; readyAt?: string }>(req, 'change') as { on: boolean; readyAt?: string };
  answer(res, Tasks.setSpaPreheat(change.on, change.readyAt, req.user));
};

export function setSpaPartyTask(req: AuthedRequest, res: Response) {
  const change = swaggerValue<{ on: boolean; readyAt?: string }>(req, 'change') as { on: boolean };
  answer(res, Tasks.setSpaParty(change.on, req.user));
};
