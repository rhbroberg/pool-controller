'use strict';

import type { Response, NextFunction } from 'express';
import type { AuthedRequest } from '../types/domain';
import { swaggerValue } from '../types/domain';

import * as utils from '../utils/writer';
import * as ExternalAuth from '../service/ExternalAuthService';

var respond = (res: any, promise: any) => promise
    .then(function (response: unknown) {
        utils.writeJson(res, response);
    })
    .catch(function (response: unknown) {
        utils.writeJson(res, response);
    });

var redirect = (res: any, location: any) => {
    res.set('Cache-Control', 'no-store');
    res.redirect(302, location);
};

var param = <T = any>(req: any, name: string): T => swaggerValue<T>(req, name);

export function listProviders(req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.listProviders());
};

export function startSignIn(req: AuthedRequest, res: Response, next: NextFunction) {
    ExternalAuth.start(req, param(req, 'provider'), { client: typeof req.query.client === 'string' ? req.query.client : undefined, link: typeof req.query.link === 'string' ? req.query.link : undefined })
        .then((location: any) => redirect(res, location))
        .catch(next);
};

export function finishSignIn(req: AuthedRequest, res: Response, next: NextFunction) {
    ExternalAuth.callback(req, param(req, 'provider'))
        .then((location: any) => redirect(res, location))
        .catch(next);
};

export function exchangeTicket(req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.exchangeTicket((param(req, 'ticket') || {}).ticket));
};

export function linkIdentity(req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.linkStart(req, req.user!, param(req, 'provider'), (req.body || {}).client));
};

export function unlinkIdentity(req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.unlink(req.user!, param(req, 'provider')));
};

export function getSignInSettings(req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.getSignInSettings(req));
};

export function updateSignInSettings(req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.updateSignInSettings(req, req.user!, param(req, 'changes')));
};

export function createProvider(req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.createProvider(req, req.user!, param(req, 'service')));
};

export function updateProvider(req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.updateProvider(req, req.user!, param(req, 'id'), param(req, 'changes')));
};

export function deleteProvider(req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.deleteProvider(req.user!, param(req, 'id')));
};

export function listRequests(req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.listRequests());
};

export function approveRequest(req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.approveRequest(req.user!, param(req, 'id'), (param(req, 'approval') || {}).role));
};

export function denyRequest(req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.denyRequest(req.user!, param(req, 'id')));
};

export function forgetRequest(req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.forgetRequest(req.user!, param(req, 'id')));
};

export function listInvitations(req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.listInvitations());
};

export function createInvitation(req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.createInvitation(req.user!, param(req, 'invitation')));
};

export function deleteInvitation(req: AuthedRequest, res: Response) {
    respond(res, ExternalAuth.deleteInvitation(req.user!, param(req, 'id')));
};
