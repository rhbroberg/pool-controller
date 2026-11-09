'use strict';

var utils = require('../utils/writer.js');
var ExternalAuth = require('../service/ExternalAuthService');

var respond = (res, promise) => promise
    .then(function(response) {
        utils.writeJson(res, response);
    })
    .catch(function(response) {
        utils.writeJson(res, response);
    });

var redirect = (res, location) => {
    res.set('Cache-Control', 'no-store');
    res.redirect(302, location);
};

var param = (req, name) => req.swagger.params[name].value;

module.exports.listProviders = function listProviders(req, res) {
    respond(res, ExternalAuth.listProviders());
};

module.exports.startSignIn = function startSignIn(req, res, next) {
    ExternalAuth.start(req, param(req, 'provider'), { client: req.query.client, link: req.query.link })
        .then((location) => redirect(res, location))
        .catch(next);
};

module.exports.finishSignIn = function finishSignIn(req, res, next) {
    ExternalAuth.callback(req, param(req, 'provider'))
        .then((location) => redirect(res, location))
        .catch(next);
};

module.exports.exchangeTicket = function exchangeTicket(req, res) {
    respond(res, ExternalAuth.exchangeTicket((param(req, 'ticket') || {}).ticket));
};

module.exports.linkIdentity = function linkIdentity(req, res) {
    respond(res, ExternalAuth.linkStart(req, req.user, param(req, 'provider'), (req.body || {}).client));
};

module.exports.unlinkIdentity = function unlinkIdentity(req, res) {
    respond(res, ExternalAuth.unlink(req.user, param(req, 'provider')));
};

module.exports.getSignInSettings = function getSignInSettings(req, res) {
    respond(res, ExternalAuth.getSignInSettings(req));
};

module.exports.updateSignInSettings = function updateSignInSettings(req, res) {
    respond(res, ExternalAuth.updateSignInSettings(req, req.user, param(req, 'changes')));
};

module.exports.createProvider = function createProvider(req, res) {
    respond(res, ExternalAuth.createProvider(req, req.user, param(req, 'service')));
};

module.exports.updateProvider = function updateProvider(req, res) {
    respond(res, ExternalAuth.updateProvider(req, req.user, param(req, 'id'), param(req, 'changes')));
};

module.exports.deleteProvider = function deleteProvider(req, res) {
    respond(res, ExternalAuth.deleteProvider(req.user, param(req, 'id')));
};

module.exports.listRequests = function listRequests(req, res) {
    respond(res, ExternalAuth.listRequests());
};

module.exports.approveRequest = function approveRequest(req, res) {
    respond(res, ExternalAuth.approveRequest(req.user, param(req, 'id'), (param(req, 'approval') || {}).role));
};

module.exports.denyRequest = function denyRequest(req, res) {
    respond(res, ExternalAuth.denyRequest(req.user, param(req, 'id')));
};

module.exports.forgetRequest = function forgetRequest(req, res) {
    respond(res, ExternalAuth.forgetRequest(req.user, param(req, 'id')));
};

module.exports.listInvitations = function listInvitations(req, res) {
    respond(res, ExternalAuth.listInvitations());
};

module.exports.createInvitation = function createInvitation(req, res) {
    respond(res, ExternalAuth.createInvitation(req.user, param(req, 'invitation')));
};

module.exports.deleteInvitation = function deleteInvitation(req, res) {
    respond(res, ExternalAuth.deleteInvitation(req.user, param(req, 'id')));
};
