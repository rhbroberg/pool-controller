'use strict';

var utils = require('../utils/writer.js');
var Weather = require('../service/WeatherService');

module.exports.getWeather = function getWeather (req, res) {
  Weather.getWeather()
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
};
