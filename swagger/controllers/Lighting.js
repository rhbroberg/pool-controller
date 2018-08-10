'use strict';

var utils = require('../utils/writer.js');
var Lighting = require('../service/LightingService');

module.exports.getLightingState = function getLightingState (req, res, next) {
  var lightId = req.swagger.params['lightId'].value;
  Lighting.getLightingState(lightId)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.getLights = function getLights (req, res, next) {
  Lighting.getLights()
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.setLightingState = function setLightingState (req, res, next) {
  var lightId = req.swagger.params['lightId'].value;
  var state = req.swagger.params['state'].value;
  Lighting.setLightingState(lightId,state)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};
