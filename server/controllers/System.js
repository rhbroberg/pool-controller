'use strict';

var utils = require('../utils/writer.js');
var System = require('../service/SystemService');

module.exports.factoryReset = function factoryReset (req, res) {
  System.factoryReset(req.user)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.restartServer = function restartServer (req, res) {
  System.restart(req.user)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};
