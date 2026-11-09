'use strict';

var utils = require('../utils/writer.js');
var History = require('../service/HistoryService');

module.exports.getHistory = function getHistory (req, res) {
  var names = req.swagger.params['names'].value;
  var from = req.swagger.params['from'].value;
  var to = req.swagger.params['to'].value;
  var maxPoints = req.swagger.params['maxPoints'].value;
  var resolution = req.swagger.params['resolution'].value;
  History.getHistory(names, from, to, maxPoints, resolution)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.getHistoryAvailability = function getHistoryAvailability (req, res) {
  History.getAvailability(req.swagger.params['from'].value, req.swagger.params['to'].value, req.swagger.params['names'].value)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};
