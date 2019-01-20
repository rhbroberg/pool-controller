'use strict';

const { User } = require('./../models/user');
const log4js = require('log4js');
var logger = log4js.getLogger();

/**
 *
 * returns User
 **/
exports.createUser = function(credentials) {
    return new Promise(async function(resolve, reject) {

        logger.info('user creds are', credentials);

        try {
            const user = new User({ email: credentials.email, password: credentials.password });

            await user.save();
            const token = await user.generateAuthToken();
            resolve({ token });
        } catch (e) {
            logger.debug('woe: ', e);
            reject();
        }
    });
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
 *
 * returns User
 **/
exports.loginUser = function(credentials) {
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
 *
 * no response value expected for this operation
 **/
exports.logoutUser = function() {
    return new Promise(function(resolve, reject) {
        resolve();
    });
};
