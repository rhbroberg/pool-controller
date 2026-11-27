'use strict';

import type { Response, NextFunction } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

var utils = require('../utils/writer');
var ExternalAuth = require('../service/ExternalAuthService');

var respond = (res: any, promise: any) => promise
    .then(function(response: any) {
        utils.writeJson(res, response);
    })
    .catch(function(response: any) {
        utils.writeJson(res, response);
    });

var redirect = (res: any, location: any) => {
    res.set('Cache-Control', 'no-store');
    res.redirect(302, location);
};

var param = <T = any>(req: any, name: string): T => swaggerValue<T>(req, name);

module.exports.listProviders = function listProviders (req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.listProviders());
};

module.exports.startSignIn = function startSignIn (req: AuthedRequest, res: Response, next: NextFunction) {
    ExternalAuth.start(req, param(req, 'provider'), { client: req.query.client, link: req.query.link })
        .then((location: any) => redirect(res, location))
        .catch(next);
};

module.exports.finishSignIn = function finishSignIn (req: AuthedRequest, res: Response, next: NextFunction) {
    ExternalAuth.callback(req, param(req, 'provider'))
        .then((location: any) => redirect(res, location))
        .catch(next);
};

module.exports.exchangeTicket = function exchangeTicket (req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.exchangeTicket((param(req, 'ticket') || {}).ticket));
};

module.exports.linkIdentity = function linkIdentity (req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.linkStart(req, req.user, param(req, 'provider'), (req.body || {}).client));
};

module.exports.unlinkIdentity = function unlinkIdentity (req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.unlink(req.user, param(req, 'provider')));
};

module.exports.getSignInSettings = function getSignInSettings (req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.getSignInSettings(req));
};

module.exports.updateSignInSettings = function updateSignInSettings (req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.updateSignInSettings(req, req.user, param(req, 'changes')));
};

module.exports.createProvider = function createProvider (req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.createProvider(req, req.user, param(req, 'service')));
};

module.exports.updateProvider = function updateProvider (req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.updateProvider(req, req.user, param(req, 'id'), param(req, 'changes')));
};

module.exports.deleteProvider = function deleteProvider (req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.deleteProvider(req.user, param(req, 'id')));
};

module.exports.listRequests = function listRequests (req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.listRequests());
};

module.exports.approveRequest = function approveRequest (req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.approveRequest(req.user, param(req, 'id'), (param(req, 'approval') || {}).role));
};

module.exports.denyRequest = function denyRequest (req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.denyRequest(req.user, param(req, 'id')));
};

module.exports.forgetRequest = function forgetRequest (req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.forgetRequest(req.user, param(req, 'id')));
};

module.exports.listInvitations = function listInvitations (req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.listInvitations());
};

module.exports.createInvitation = function createInvitation (req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.createInvitation(req.user, param(req, 'invitation')));
};

module.exports.deleteInvitation = function deleteInvitation (req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.deleteInvitation(req.user, param(req, 'id')));
};
