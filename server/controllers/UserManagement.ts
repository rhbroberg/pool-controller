'use strict';

import type { Response } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

import * as utils from '../utils/writer';
import * as UserManagement from '../service/UserManagementService';

var respond = (res: any, promise: any) => promise
    .then(function (response: unknown) {
        utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
        utils.writeJson(res, response);
    });

export function createUser(req: AuthedRequest, res: Response) {
    respond(res, UserManagement.createUser(req.user, swaggerValue(req, 'account')));
};

export function listUsers(req: AuthedRequest, res: Response) {
    const archived = swaggerValue<string | undefined>(req, 'archived');
    respond(res, UserManagement.listUsers(archived));
};

export function createGuest(req: AuthedRequest, res: Response) {
    const options = swaggerValue<Record<string, unknown>>(req, 'options') || {};
    respond(res, UserManagement.createGuest(req.user, options));
};

export function deleteArchivedUsers(req: AuthedRequest, res: Response) {
    respond(res, UserManagement.deleteArchivedUsers(req.user));
};

export function loginGuest(req: AuthedRequest, res: Response) {
    respond(res, UserManagement.loginGuest(swaggerValue(req, 'credentials')));
};

export function updateUser(req: AuthedRequest, res: Response) {
    respond(res, UserManagement.updateUser(req.user, swaggerValue<string>(req, 'name'), swaggerValue<Record<string, unknown>>(req, 'changes')));
};

export function deleteUser(req: AuthedRequest, res: Response) {
    respond(res, UserManagement.deleteUser(req.user, swaggerValue<string>(req, 'name')));
};

export function getUser(req: AuthedRequest, res: Response) {
    respond(res, UserManagement.getUser(req.user));
};

export function loginUser(req: AuthedRequest, res: Response) {
    respond(res, UserManagement.loginUser(swaggerValue(req, 'credentials')));
};

export function changeCredentials(req: AuthedRequest, res: Response) {
    respond(res, UserManagement.changeCredentials(req.user, swaggerValue(req, 'credentials')));
};

export function logoutUser(req: AuthedRequest, res: Response) {
    respond(res, UserManagement.logoutUser(req.user, req.token));
};
