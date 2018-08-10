'use strict';

var utils = require('../utils/writer.js');
var Environment = require('../service/EnvironmentService');

module.exports.getHeaterState = function getHeaterState (req, res, next) {
  var poolId = req.swagger.params['poolId'].value;
  Environment.getHeaterState(poolId)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.getPoolTemperature = function getPoolTemperature (req, res, next) {
  var poolId = req.swagger.params['poolId'].value;
  Environment.getPoolTemperature(poolId)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.setHeaterState = function setHeaterState (req, res, next) {
  var poolId = req.swagger.params['poolId'].value;
  var state = req.swagger.params['state'].value;
  Environment.setHeaterState(poolId,state)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.temperatureSummary = function temperatureSummary (req, res, next) {
  Environment.temperatureSummary()
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};
