const log4js = require('log4js');

var { User } = require('./../models/user');
var logger = log4js.getLogger();

// the only requests an uncommissioned admin account may make
const allowedBeforeCommissioning = ['changeCredentials', 'logoutUser', 'getUser'];

// the OpenAPI validator passes the OAuth2 scopes the operation lists; the signed-in account's role
// must grant every one of them
var authenticate = async (req, scopes) => {
    logger.debug('authenticate sees', scopes);
    var token = req.headers['x-auth'];
    const operation = req.openapi && req.openapi.schema ? req.openapi.schema.operationId : undefined;

    const user = await User.findByToken(token).catch(() => undefined);
    if (!user) {
        throw { status: 401, message: 'sign in to do that' };
    }
    if (user.mustChangeCredentials && !allowedBeforeCommissioning.includes(operation)) {
        logger.warn(`REST ${user.email}: refused ${operation}; the account name and password must be changed first`);
        throw { status: 403, message: 'change the admin account name and password first' };
    }
    const missing = (scopes || []).filter((scope) => !user.hasScope(scope));
    if (missing.length > 0) {
        logger.warn(`REST ${user.email}: refused ${operation}; the ${user.role} role lacks ${missing.join(', ')}`);
        throw { status: 403, message: `the ${user.role} role cannot do that` };
    }
    req.user = user;
    req.token = token;
    return true;
};

module.exports = { authenticate };
