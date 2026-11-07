'use strict';

const { User } = require('./../models/user');
var utils = require('../utils/writer.js');
const log4js = require('log4js');
var logger = log4js.getLogger();

var requireJwtSecret = () => {
    if (!process.env.JWT_SECRET) {
        throw utils.respondWithCode(500, { code: 500, message: 'the server has no JWT_SECRET configured' });
    }
};

/**
 * The first account can be created by anyone; after that, only a signed-in user can add one.
 *
 * returns User
 **/
exports.createUser = async function(credentials, token) {
    requireJwtSecret();
    logger.info('creating user', credentials.email);

    if (await User.estimatedDocumentCount() > 0) {
        const creator = await User.findByToken(token).catch(() => undefined);
        if (!creator) {
            throw utils.respondWithCode(403, { code: 403, message: 'sign in to create another user' });
        }
    }

    try {
        const user = new User({ email: credentials.email, password: credentials.password });
        await user.save();
        const newToken = await user.generateAuthToken();
        return { email: user.email, token: newToken };
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
 * returns User with a token to send as the x-auth header
 **/
exports.loginUser = async function(credentials) {
    requireJwtSecret();

    let user;
    try {
        user = await User.findByCredentials(credentials.email, credentials.password);
    } catch (e) {
        throw utils.respondWithCode(401, { code: 401, message: 'incorrect email or password' });
    }

    const token = await user.generateAuthToken();
    logger.info('signed in', user.email);
    return { email: user.email, token: token };
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
