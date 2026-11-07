'use strict';

var utils = require('../utils/writer.js');
var Status = require('../service/StatusService');

module.exports.getCurrentStatus = function getCurrentStatus (req, res) {
  Status.getCurrentStatus()
    .then(function (response) {
      utils.writeJson(res, response);
    })
    .catch(function (response) {
      utils.writeJson(res, { code: 500, message: String(response) }, 500);
    });
};
