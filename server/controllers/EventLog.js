'use strict';

var utils = require('../utils/writer.js');
var EventLog = require('../service/EventLogService');

module.exports.getEvents = function getEvents (req, res, next) {
  var params = req.swagger.params;
  EventLog.getEvents(params['types'].value, params['user'].value, params['cursor'].value, params['order'].value, params['limit'].value)
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};

module.exports.getEventUsers = function getEventUsers (req, res, next) {
  EventLog.getEventUsers()
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, response);
    });
};
