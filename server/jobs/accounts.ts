'use strict';
// Archives accounts past their expiry, such as guests after their week, which signs them out
// everywhere. Signing in also catches one that has just expired, so this only keeps the account
// list and the event log up to date in between.

import * as users from '../service/UserManagementService';

var run = async () => {
    const archived = await users.archiveExpired();
    return { summary: archived === 0 ? 'no accounts had expired' : `archived ${archived} expired ${archived === 1 ? 'account' : 'accounts'}` };
};

module.exports = {
    name: 'accounts',
    description: 'archives accounts past their expiry',
    everyMs: Number(process.env.ACCOUNTS_EVERY_MS) || 15 * 60 * 1000,
    firstDelayMs: Number(process.env.ACCOUNTS_FIRST_DELAY_MS) || 60 * 1000,
    run
};