'use strict';
// What this server was built from: the git commit, and the REST API version it serves.

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import jsyaml from 'js-yaml';

const UNKNOWN = 'unknown';

// an image has no .git, so its build passes the commit in as POOL_GIT_COMMIT
const describeCommit = (): string => {
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

const readApiVersion = (): string => {
    // js-yaml 3 exposes safeLoad; @types is for v4's load
    const load = (jsyaml as unknown as { safeLoad: (input: string) => unknown }).safeLoad;
    const spec = load(fs.readFileSync(path.join(__dirname, '../api/openapi.yaml'), 'utf8')) as {
        info: { version: string };
    };
    return spec.info.version;
};

export const commit = describeCommit();
export const apiVersion = readApiVersion();
