const log4js = require('log4js');

var { User } = require('./../models/user');
var logger = log4js.getLogger();

// the only requests an uncommissioned admin account may make
const allowedBeforeCommissioning = ['changeCredentials', 'logoutUser'];

var authenticate = (req, def, scopes, next) => {
    logger.debug('authenticate sees', def);
    var token = req.headers['x-auth'];

    User.findByToken(token).then((user) => {
        if (!user) {
            return Promise.reject();
        }
        const operation = req.swagger && req.swagger.operation ? req.swagger.operation.operationId : undefined;
        if (user.mustChangeCredentials && !allowedBeforeCommissioning.includes(operation)) {
            logger.warn(`REST ${user.email}: refused ${operation}; the account name and password must be changed first`);
            next({ statusCode: 403, message: 'change the admin account name and password first' });
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
