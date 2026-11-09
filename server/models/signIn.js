'use strict';
var mongoose = require('mongoose');

// an OpenID Connect service accounts can sign in with
var ProviderSchema = new mongoose.Schema({
    // short and URL-safe, as in /auth/google/start
    _id: String,
    displayName: { type: String, required: true },
    // oidc for any standard service; apple builds Apple's signed client secret from the key
    kind: { type: String, enum: ['oidc', 'apple'], default: 'oidc' },
    issuer: { type: String, required: true },
    clientId: { type: String, required: true },
    clientSecret: String,
    apple: {
        teamId: String,
        keyId: String,
        privateKey: String
    },
    enabled: { type: Boolean, default: true },
    // whether the service's verified email addresses are trusted enough to redeem invitations
    trustEmail: { type: Boolean, default: false }
}, { timestamps: true });

// someone who signed in through a service without an account or an invitation
var AccessRequestSchema = new mongoose.Schema({
    provider: { type: String, required: true },
    subject: { type: String, required: true },
    email: String,
    name: String,
    status: { type: String, enum: ['pending', 'denied'], default: 'pending' },
    firstSeen: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    attempts: { type: Number, default: 1 }
});
AccessRequestSchema.index({ provider: 1, subject: 1 }, { unique: true });

// an email address an admin has let in ahead of time, with the role it gets
var InvitationSchema = new mongoose.Schema({
    email: { type: String, required: true, lowercase: true, trim: true },
    // null for any service that trusts its email addresses
    provider: { type: String, default: null },
    role: { type: String, required: true },
    createdBy: String,
    createdAt: { type: Date, default: Date.now }
});
InvitationSchema.index({ email: 1 }, { unique: true });

var Provider = mongoose.model('Provider', ProviderSchema);
var AccessRequest = mongoose.model('AccessRequest', AccessRequestSchema);
var Invitation = mongoose.model('Invitation', InvitationSchema);

module.exports = { Provider, AccessRequest, Invitation };
