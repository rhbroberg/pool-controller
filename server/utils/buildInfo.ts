'use strict';
// What this server was built from: the git commit, and the REST API version it serves.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const jsyaml = require('js-yaml');

const UNKNOWN = 'unknown';

// an image has no .git, so its build passes the commit in as POOL_GIT_COMMIT
var describeCommit = () => {
    if (process.env.POOL_GIT_COMMIT) {
        return process.env.POOL_GIT_COMMIT;
    }
    try {
        return execFileSync('git', ['describe', '--always', '--dirty'],
            { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || UNKNOWN;
    } catch {
        return UNKNOWN;
    }
};

var readApiVersion = () => {
    const spec = jsyaml.safeLoad(fs.readFileSync(path.join(__dirname, '../api/openapi.yaml'), 'utf8'));
    return spec.info.version;
};

module.exports = {
    commit: describeCommit(),
    apiVersion: readApiVersion()
};
