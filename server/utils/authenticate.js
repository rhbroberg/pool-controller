const log4js = require('log4js');

var { User } = require('./../models/user');
var logger = log4js.getLogger();

var authenticate = (req, def, scopes, next) => {
    logger.debug('authenticate sees', def);
    var token = req.headers['x-auth'];

    User.findByToken(token).then((user) => {
        if (!user) {
            return Promise.reject();
        }
        req.user = user;
        req.token = token;
        next();
    }).catch((e) => { // eslint-disable-line no-unused-vars
        next({ statusCode: 401 });
    });
};

module.exports = { authenticate };
