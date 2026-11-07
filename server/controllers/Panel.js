'use strict';

var utils = require('../utils/writer.js');
var Panel = require('../service/PanelService');

module.exports.getPanelDisplay = function getPanelDisplay (req, res, next) {
  Panel.getPanelDisplay()
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.pressPanelKey = function pressPanelKey (req, res, next) {
  var key = req.swagger.params['key'].value;
  Panel.pressPanelKey(key, req.user)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};
