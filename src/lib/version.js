// Server version identity — shared by /api/version and the update check.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { PUB } from './files.js';

export const VERSION = JSON.parse(fs.readFileSync(path.join(PUB, '..', 'package.json'), 'utf8')).version;
// Commit the deploy pulled — .git exists on checkout-style deploys; otherwise
// a container build can pass GIT_SHA explicitly.
export const SHA = process.env.GIT_SHA
    || (() => { try { return fs.readFileSync(path.join(PUB, '..', '.deploy-sha'), 'utf8').trim(); } catch { return ''; } })()
    || (() => { try { return execSync('git rev-parse --short HEAD', { cwd: path.join(PUB, '..') }).toString().trim(); } catch { return ''; } })();
