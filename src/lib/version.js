// Server version identity — shared by /api/version and the update check.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { PUB } from './files.js';

export const VERSION = JSON.parse(fs.readFileSync(path.join(PUB, '..', 'package.json'), 'utf8')).version;
// Commit the deploy pulled — .deploy-sha is written by tarball self-update
// (always newer than the build-time env sha), then GIT_SHA for container
// builds, then git for checkout installs.
export const SHA = (() => { try { return fs.readFileSync(path.join(PUB, '..', '.deploy-sha'), 'utf8').trim(); } catch { return ''; } })()
    || process.env.GIT_SHA
    || (() => { try { return execSync('git rev-parse --short HEAD', { cwd: path.join(PUB, '..') }).toString().trim(); } catch { return ''; } })();
