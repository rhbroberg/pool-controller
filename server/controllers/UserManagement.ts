'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

var utils = require('../utils/writer');
var UserManagement = require('../service/UserManagementService');

var respond = (res: any, promise: any) => promise
    .then(function(response: any) {
        utils.writeJson(res, response);
    })
    .catch(function(response: any) {
        utils.writeJson(res, response);
    });

module.exports.createUser = function createUser (req: AuthedRequest, res: Response) {
    respond(res, UserManagement.createUser(req.user, swaggerValue(req, 'account')));
};

module.exports.listUsers = function listUsers (req: AuthedRequest, res: Response) {
    respond(res, UserManagement.listUsers());
};

module.exports.updateUser = function updateUser (req: AuthedRequest, res: Response) {
    respond(res, UserManagement.updateUser(req.user, swaggerValue(req, 'name'), swaggerValue(req, 'changes')));
};

module.exports.deleteUser = function deleteUser (req: AuthedRequest, res: Response) {
    respond(res, UserManagement.deleteUser(req.user, swaggerValue(req, 'name')));
};

module.exports.getUser = function getUser (req: AuthedRequest, res: Response) {
    respond(res, UserManagement.getUser(req.user));
};

module.exports.loginUser = function loginUser (req: AuthedRequest, res: Response) {
    respond(res, UserManagement.loginUser(swaggerValue(req, 'credentials')));
};

module.exports.changeCredentials = function changeCredentials (req: AuthedRequest, res: Response) {
    respond(res, UserManagement.changeCredentials(req.user, swaggerValue(req, 'credentials')));
};

module.exports.logoutUser = function logoutUser (req: AuthedRequest, res: Response) {
    respond(res, UserManagement.logoutUser(req.user, req.token));
};
