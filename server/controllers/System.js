'use strict';

var utils = require('../utils/writer.js');
var System = require('../service/SystemService');
var Settings = require('../service/SettingsService');
var scheduler = require('../jobs/scheduler');

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

module.exports.getSettings = function getSettings (req, res) {
  answer(res, Settings.getSettings());
};

module.exports.updateSettings = function updateSettings (req, res) {
  answer(res, Settings.updateSettings(req.swagger.params['changes'].value, req.user));
};

module.exports.listJobs = function listJobs (req, res) {
  answer(res, scheduler.status());
};

module.exports.runJob = function runJob (req, res) {
  var name = req.swagger.params['name'].value;
  if (!scheduler.has(name)) {
    utils.writeJson(res, { code: 404, message: `there is no job named ${name}` }, 404);
    return;
  }
  answer(res, scheduler.runNow(name).then(function (status) {
    if (status.busy) {
      throw utils.respondWithCode(409, { code: 409, message: `${name} is already running in another process` });
    }
    delete status.busy;
    return status;
  }));
};

module.exports.getSystemInfo = function getSystemInfo (req, res) {
  utils.writeJson(res, System.info());
};

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
