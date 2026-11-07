'use strict';

var utils = require('../utils/writer.js');
var UserManagement = require('../service/UserManagementService');

var respond = (res, promise) => promise
    .then(function(response) {
        utils.writeJson(res, response);
    })
    .catch(function(response) {
        utils.writeJson(res, response);
    });

module.exports.createUser = function createUser(req, res) {
    respond(res, UserManagement.createUser(req.user, req.swagger.params['account'].value));
};

module.exports.listUsers = function listUsers(req, res) {
    respond(res, UserManagement.listUsers());
};

module.exports.updateUser = function updateUser(req, res) {
    respond(res, UserManagement.updateUser(req.user, req.swagger.params['name'].value, req.swagger.params['changes'].value));
};

module.exports.deleteUser = function deleteUser(req, res) {
    respond(res, UserManagement.deleteUser(req.user, req.swagger.params['name'].value));
};

module.exports.getUser = function getUser(req, res) {
    respond(res, UserManagement.getUser(req.user));
};

module.exports.loginUser = function loginUser(req, res) {
    respond(res, UserManagement.loginUser(req.swagger.params['credentials'].value));
};

module.exports.changeCredentials = function changeCredentials(req, res) {
    respond(res, UserManagement.changeCredentials(req.user, req.swagger.params['credentials'].value));
};

module.exports.logoutUser = function logoutUser(req, res) {
    respond(res, UserManagement.logoutUser(req.user, req.token));
};
