const log4js = require('log4js');

var { User } = require('./../models/user');
var logger = log4js.getLogger();

// the only requests an uncommissioned admin account may make
const allowedBeforeCommissioning = ['changeCredentials', 'logoutUser', 'getUser'];

// swagger-tools passes the OAuth2 scopes the operation lists; the signed-in account's role
// must grant every one of them
var authenticate = (req, def, scopes, next) => {
    logger.debug('authenticate sees', def, scopes);
    var token = req.headers['x-auth'];
    const operation = req.swagger && req.swagger.operation ? req.swagger.operation.operationId : undefined;

    User.findByToken(token).then((user) => {
        if (!user) {
            return Promise.reject();
        }
        if (user.mustChangeCredentials && !allowedBeforeCommissioning.includes(operation)) {
            logger.warn(`REST ${user.email}: refused ${operation}; the account name and password must be changed first`);
            next({ statusCode: 403, message: 'change the admin account name and password first' });
            return;
        }
        const missing = (scopes || []).filter((scope) => !user.hasScope(scope));
        if (missing.length > 0) {
            logger.warn(`REST ${user.email}: refused ${operation}; the ${user.role} role lacks ${missing.join(', ')}`);
            next({ statusCode: 403, message: `the ${user.role} role cannot do that` });
            return;
        }
        req.user = user;
        req.token = token;
        next();
    }).catch((e) => { // eslint-disable-line no-unused-vars
        next({ statusCode: 401 });
    });
};

module.exports = { authenticate };
