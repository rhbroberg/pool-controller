'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { ApiError } from '../utils/writer';

import * as utils from '../utils/writer';
import * as Weather from '../service/WeatherService';

export function getWeather(req: AuthedRequest, res: Response) {
  Weather.getWeather()
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
};
