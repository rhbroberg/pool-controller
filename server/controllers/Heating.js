'use strict';

var utils = require('../utils/writer.js');
var Heating = require('../service/HeatingService');

module.exports.getHeating = function getHeating (req, res) {
  Heating.getHeating()
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.getSetpoint = function getSetpoint (req, res) {
  Heating.getSetpoint(req.swagger.params['body'].value, req.swagger.params['device'].value)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.setSetpoint = function setSetpoint (req, res) {
  Heating.setSetpoint(req.swagger.params['body'].value, req.swagger.params['device'].value,
                      req.swagger.params['degrees'].value, req.user)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};
