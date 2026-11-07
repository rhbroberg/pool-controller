'use strict';

const { User, DEFAULT_ADMIN_NAME, DEFAULT_ADMIN_PASSWORD } = require('./../models/user');
var utils = require('../utils/writer.js');
const log4js = require('log4js');
var logger = log4js.getLogger();

var requireJwtSecret = () => {
    if (!process.env.JWT_SECRET) {
        throw utils.respondWithCode(500, { code: 500, message: 'the server has no JWT_SECRET configured' });
    }
};

/**
 * Only a signed-in, commissioned user can add an account. A server always has at least the
 * default admin account, so there is no unauthenticated way in.
 *
 * returns User
 **/
exports.createUser = async function(credentials, token) {
    requireJwtSecret();

    const creator = await User.findByToken(token).catch(() => undefined);
    if (!creator || creator.mustChangeCredentials) {
        throw utils.respondWithCode(403, { code: 403, message: 'sign in with a commissioned account to create another user' });
    }

    try {
        const user = new User({ email: credentials.email, password: credentials.password });
        await user.save();
        const newToken = await user.generateAuthToken();
        logger.info(`REST ${creator.email}: created account ${user.email}`);
        return { email: user.email, token: newToken, mustChangeCredentials: false };
    } catch (e) {
        logger.debug('woe: ', e);
        throw utils.respondWithCode(400, { code: 400, message: 'could not create that user' });
    }
};


/**
 *
 * returns User
 **/
exports.getUser = function() {
    return new Promise(function(resolve, reject) {
        var examples = {};
        examples['application/json'] = {
            'id': 'id',
            'email': 'email'
        };
        if (Object.keys(examples).length > 0) {
            resolve(examples[Object.keys(examples)[0]]);
        } else {
            resolve();
        }
    });
};


/**
 * returns User with a token to send as the x-auth header; mustChangeCredentials means the
 * token is only good for changeCredentials until the account is renamed
 **/
exports.loginUser = async function(credentials) {
    requireJwtSecret();

    let user;
    try {
        user = await User.findByCredentials(credentials.email, credentials.password);
    } catch (e) {
        throw utils.respondWithCode(401, { code: 401, message: 'incorrect name or password' });
    }

    const token = await user.generateAuthToken();
    logger.info(user.mustChangeCredentials ? `signed in ${user.email}; the account must be commissioned` : `signed in ${user.email}`);
    return { email: user.email, token: token, mustChangeCredentials: user.mustChangeCredentials };
};


/**
 * renames the signed-in account and sets its password; this is how the default admin account
 * is commissioned. Every earlier token for the account stops working.
 *
 * returns User
 **/
exports.changeCredentials = async function(user, credentials) {
    requireJwtSecret();

    const name = (credentials.email || '').trim();
    const password = credentials.password || '';
    if (!name || name.toLowerCase() === DEFAULT_ADMIN_NAME) {
        throw utils.respondWithCode(400, { code: 400, message: `choose an account name other than ${DEFAULT_ADMIN_NAME}` });
    }
    if (password.length < 6 || password === DEFAULT_ADMIN_PASSWORD) {
        throw utils.respondWithCode(400, { code: 400, message: 'choose a password of at least 6 characters' });
    }
    if (await User.exists({ email: name, _id: { $ne: user._id } })) {
        throw utils.respondWithCode(409, { code: 409, message: 'that account name is already in use' });
    }

    const previousName = user.email;
    user.email = name;
    user.password = password;
    user.mustChangeCredentials = false;
    user.tokens = [];
    await user.save();
    const token = await user.generateAuthToken();

    logger.info(previousName === name
        ? `REST ${name}: changed password`
        : `REST ${previousName}: account renamed to ${name} with a new password`);
    return { email: name, token: token, mustChangeCredentials: false };
};


/**
 *
 * no response value expected for this operation
 **/
exports.logoutUser = function() {
    return new Promise(function(resolve, reject) {
        resolve();
    });
};
