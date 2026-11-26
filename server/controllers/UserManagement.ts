'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';

var utils = require('../utils/writer');
var UserManagement = require('../service/UserManagementService');

var respond = (res, promise) => promise
    .then(function(response) {
        utils.writeJson(res, response);
    })
    .catch(function(response) {
        utils.writeJson(res, response);
    });

module.exports.createUser = function createUser (req: AuthedRequest, res: Response) {
    respond(res, UserManagement.createUser(req.user, req.swagger.params['account'].value));
};

module.exports.listUsers = function listUsers (req: AuthedRequest, res: Response) {
    respond(res, UserManagement.listUsers());
};

module.exports.updateUser = function updateUser (req: AuthedRequest, res: Response) {
    respond(res, UserManagement.updateUser(req.user, req.swagger.params['name'].value, req.swagger.params['changes'].value));
};

module.exports.deleteUser = function deleteUser (req: AuthedRequest, res: Response) {
    respond(res, UserManagement.deleteUser(req.user, req.swagger.params['name'].value));
};

module.exports.getUser = function getUser (req: AuthedRequest, res: Response) {
    respond(res, UserManagement.getUser(req.user));
};

module.exports.loginUser = function loginUser (req: AuthedRequest, res: Response) {
    respond(res, UserManagement.loginUser(req.swagger.params['credentials'].value));
};

module.exports.changeCredentials = function changeCredentials (req: AuthedRequest, res: Response) {
    respond(res, UserManagement.changeCredentials(req.user, req.swagger.params['credentials'].value));
};

module.exports.logoutUser = function logoutUser (req: AuthedRequest, res: Response) {
    respond(res, UserManagement.logoutUser(req.user, req.token));
};
