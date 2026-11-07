const crypto = require('crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const _ = require('lodash');
const bcrypt = require('bcryptjs');

// a fresh or factory-reset server has only this account, and it must be renamed and given a
// new password before it can change anything
const DEFAULT_ADMIN_NAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'admin';

// each role holds every OAuth2 scope of the roles before it
const ROLES = ['viewer', 'user', 'admin'];
const ROLE_SCOPES = {
    viewer: ['account'],
    user: ['account', 'control'],
    admin: ['account', 'control', 'admin']
};

var UserSchema = new mongoose.Schema({
    // historically an email address; any account name is accepted
    email: {
        type: String,
        minlength: 1,
        required: true,
        trim: true,
        unique: true
    },
    password: {
        type: String,
        required: true,
        minlength: 6
    },
    mustChangeCredentials: {
        type: Boolean,
        default: false
    },
    role: {
        type: String,
        enum: ROLES,
        default: 'user'
    },
    tokens: [{
        access: {
            type: String,
            required: true
        },
        token: {
            type: String,
            required: true
        }
    }]
});

UserSchema.methods.toJSON = function() {
    var user = this;
    var userObject = user.toObject();

    return _.pick(userObject, ['_id', 'email', 'role', 'mustChangeCredentials']);
};

UserSchema.methods.hasScope = function(scope) {
    return (ROLE_SCOPES[this.role] || []).includes(scope);
};

UserSchema.methods.generateAuthToken = function() {
    var user = this;
    var access = 'auth';
    // the random id keeps two sign-ins in the same second from sharing a token, so signing one
    // out leaves the other signed in
    var token = jwt.sign({ _id: user._id.toHexString(), access, jti: crypto.randomUUID() }, process.env.JWT_SECRET).toString();

    user.tokens = user.tokens.concat({ access, token });
    return user.save().then(() => {
        return token;
    });
};

UserSchema.methods.removeToken = function(token) {
    var user = this;

    return user.updateOne({
        $pull: {
            tokens: { token }
        }
    });
};

UserSchema.statics.findByToken = function(token) {
    var User = this;
    var decoded;

    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return Promise.reject();
    }

    return User.findOne({
        '_id': decoded._id,
        'tokens.token': token,
        'tokens.access': 'auth'
    });
};

UserSchema.statics.findByCredentials = function(email, password) {
    var User = this;

    return User.findOne({ email }).then((user) => {
        if (!user) {
            return Promise.reject();
        }

        return new Promise((resolve, reject) => {
            bcrypt.compare(password, user.password, (err, result) => {
                if (result) {
                    resolve(user);
                } else {
                    reject();
                }
            });
        });
    });
};

// creates admin/admin when no accounts exist; resolves true if it did. The default password is
// shorter than the schema allows, so the account is inserted directly rather than validated.
UserSchema.statics.ensureDefaultAdmin = async function() {
    if (await this.countDocuments({}) > 0) {
        return false;
    }
    await this.collection.insertOne({
        email: DEFAULT_ADMIN_NAME,
        password: await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10),
        mustChangeCredentials: true,
        role: 'admin',
        tokens: []
    });
    return true;
};

// accounts from before roles existed had every privilege, so they become admins; resolves
// with how many were changed
UserSchema.statics.assignLegacyRoles = async function() {
    const { modifiedCount } = await this.updateMany({ role: { $exists: false } }, { $set: { role: 'admin' } });
    return modifiedCount;
};

UserSchema.pre('save', function(next) {
    var user = this;

    if (user.isModified('password')) {
        bcrypt.genSalt(10, (err, salt) => {
            bcrypt.hash(user.password, salt, (err, hash) => {
                user.password = hash;
                next();
            });
        });
    } else {
        next();
    }
});

var User = mongoose.model('User', UserSchema);

module.exports = { User, DEFAULT_ADMIN_NAME, DEFAULT_ADMIN_PASSWORD, ROLES, ROLE_SCOPES };
