'use strict';

var utils = require('../utils/writer.js');
var Water = require('../service/WaterService');

module.exports.setWaterMode = function setWaterMode (req, res, next) {
  Water.setWaterMode(req.swagger.params['mode'].value, req.user)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};
