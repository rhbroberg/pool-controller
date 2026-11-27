import crypto from 'crypto';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import _ from 'lodash';
import bcrypt from 'bcryptjs';
import { USER_ROLES } from '../types/domain';
import type { UserRole, OAuthScope } from '../types/domain';

// a fresh or factory-reset server has only this account, and it must be renamed and given a
// new password before it can change anything. Guests too must set a password before anything
// else, through the same mustChangeCredentials.
const DEFAULT_ADMIN_NAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'admin';

// each role holds every OAuth2 scope of the roles before it
const ROLES: UserRole[] = [...USER_ROLES];
const ROLE_SCOPES: Record<string, OAuthScope[]> = {
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
    // an account that signs in only through an external service has none, and nor does a guest
    // until it sets one
    password: {
        type: String,
        required: function(this: { identities?: unknown[]; setupCode?: string }) {
            return (!this.identities || this.identities.length === 0) && !this.setupCode;
        },
        minlength: 6
    },
    // a guest's one-time code, in the link and QR code that let it in to set its own password;
    // kept readable so an admin can show the QR code again, and gone once the password is set
    setupCode: String,
    guest: {
        type: Boolean,
        default: false
    },
    // accounts from before this was kept fall back to when their id was made
    createdAt: {
        type: Date,
        default: Date.now
    },
    firstSignInAt: Date,
    // once past, the account is archived and can't sign in
    expiresAt: Date,
    archivedAt: Date,
    // the external services this account signs in with, each by the provider's own id for it
    identities: [{
        _id: false,
        provider: { type: String, required: true },
        subject: { type: String, required: true },
        email: String,
        linkedAt: { type: Date, default: Date.now }
    }],
    displayName: String,
    lastSignInAt: Date,
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

UserSchema.index({ 'identities.provider': 1, 'identities.subject': 1 },
    { unique: true, partialFilterExpression: { 'identities.subject': { $exists: true } } });

UserSchema.methods.toJSON = function() {
    var user = this;
    var userObject = user.toObject();

    return _.pick(userObject, ['_id', 'email', 'role', 'mustChangeCredentials']);
};

UserSchema.methods.hasPassword = function() {
    return Boolean(this.password);
};

// how the account signs in: password and/or the ids of its external services
UserSchema.methods.signInMethods = function() {
    return (this.hasPassword() ? ['password'] : []).concat((this.identities || []).map((identity: any) => identity.provider));
};

// the account as the API reports it, without secrets
UserSchema.methods.describe = function() {
    const described: {
        email: string;
        role: string;
        mustChangeCredentials: boolean;
        methods: string[];
        guest: boolean;
        createdAt: Date;
        firstSignInAt: Date | null;
        lastSignInAt: Date | null;
        expiresAt: Date | null;
        archivedAt: Date | null;
        displayName?: string;
    } = {
        email: this.email,
        role: this.role,
        mustChangeCredentials: this.mustChangeCredentials,
        methods: this.signInMethods(),
        guest: this.guest === true,
        createdAt: this.createdAt || this._id.getTimestamp(),
        firstSignInAt: this.firstSignInAt || null,
        lastSignInAt: this.lastSignInAt || null,
        expiresAt: this.expiresAt || null,
        archivedAt: this.archivedAt || null
    };
    if (this.displayName) {
        described.displayName = this.displayName;
    }
    return described;
};

// as an admin sees it: with a guest's one-time code, for its QR code, until it's been used
UserSchema.methods.describeForAdmin = function() {
    return Object.assign(this.describe(), { setupCode: this.setupCode || null });
};

UserSchema.methods.hasExpired = function(now = new Date()) {
    return Boolean(this.expiresAt) && this.expiresAt.getTime() <= now.getTime();
};

// neither archived nor past its expiry
UserSchema.methods.isActive = function(now = new Date()) {
    return !this.archivedAt && !this.hasExpired(now);
};

// stops the account signing in and signs it out everywhere
UserSchema.methods.archive = function(now = new Date()) {
    this.archivedAt = now;
    this.tokens = [];
    return this.save();
};

// archives every account past its expiry; resolves with them
UserSchema.statics.archiveExpired = async function(now = new Date()) {
    const expired = await this.find({ archivedAt: null, expiresAt: { $ne: null, $lte: now } });
    for (const account of expired) {
        await account.archive(now);
    }
    return expired;
};

// a successful sign-in, of any kind
UserSchema.methods.recordSignIn = function(now = new Date()) {
    this.lastSignInAt = now;
    if (!this.firstSignInAt) {
        this.firstSignInAt = now;
    }
};

UserSchema.statics.findByIdentity = function(provider: string, subject: string) {
    return this.findOne({ identities: { $elemMatch: { provider, subject } } });
};

UserSchema.methods.hasScope = function(scope: string) {
    return (ROLE_SCOPES[this.role] || []).includes(scope as OAuthScope);
};

UserSchema.methods.generateAuthToken = function() {
    var user = this;
    var access = 'auth';
    // the random id keeps two sign-ins in the same second from sharing a token, so signing one
    // out leaves the other signed in
    var token = jwt.sign({ _id: user._id.toHexString(), access, jti: crypto.randomUUID() }, process.env.JWT_SECRET as string).toString();

    user.tokens = user.tokens.concat({ access, token });
    return user.save().then(() => {
        return token;
    });
};

UserSchema.methods.removeToken = function(token: string) {
    var user = this;

    return user.updateOne({
        $pull: {
            tokens: { token }
        }
    });
};

UserSchema.statics.findByToken = function(token: string) {
    var User = this;
    var decoded;

    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { _id: string };
    } catch {
        return Promise.reject();
    }

    return User.findOne({
        '_id': decoded._id,
        'tokens.token': token,
        'tokens.access': 'auth'
    });
};

UserSchema.statics.findByCredentials = function(email: string, password: string) {
    var User = this;

    return User.findOne({ email }).then((user: any) => {
        if (!user || !user.password) {
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
        createdAt: new Date(),
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
            bcrypt.hash(user.password as string, salt!, (err, hash) => {
                user.password = hash;
                next();
            });
        });
    } else {
        next();
    }
});

var User = mongoose.model('User', UserSchema);

export { User, DEFAULT_ADMIN_NAME, DEFAULT_ADMIN_PASSWORD, ROLES, ROLE_SCOPES };
