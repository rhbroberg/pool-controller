'use strict';

var utils = require('../utils/writer.js');
var Filtration = require('../service/FiltrationService');

module.exports.getFiltrationDevices = function getFiltrationDevices (req, res, next) {
  Filtration.getFiltrationDevices()
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.getFiltrationState = function getFiltrationState (req, res, next) {
  var pumpId = req.swagger.params['pumpId'].value;
  Filtration.getFiltrationState(pumpId)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.setFiltrationState = function setFiltrationState (req, res, next) {
  var pumpId = req.swagger.params['pumpId'].value;
  var state = req.swagger.params['state'].value;
  Filtration.setFiltrationState(pumpId,state)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};
