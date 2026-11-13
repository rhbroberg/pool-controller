'use strict';

var utils = require('../utils/writer.js');
var Tasks = require('../service/TaskService');

var answer = (res, promise) => promise
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

module.exports.getTasks = function getTasks (req, res) {
  answer(res, Tasks.getTasks());
};

module.exports.setPoolTask = function setPoolTask (req, res) {
  answer(res, Tasks.setPool(req.swagger.params['change'].value.on, req.user));
};

module.exports.setSpaPreheatTask = function setSpaPreheatTask (req, res) {
  const change = req.swagger.params['change'].value;
  answer(res, Tasks.setSpaPreheat(change.on, change.readyAt, req.user));
};

module.exports.setSpaPartyTask = function setSpaPartyTask (req, res) {
  answer(res, Tasks.setSpaParty(req.swagger.params['change'].value.on, req.user));
};
