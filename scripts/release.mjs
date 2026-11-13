/**
 * release.mjs — BOLLOCKS release planner.
 *
 * Conventional-commit versioning for this repo, consumed by
 * .github/workflows/release.yml and beta.yml (vendored; originally adapted
 * from StructuredChaos' shared family-release.mjs).
 *
 * Versioning semantics:
 *   - feat -> minor, BREAKING CHANGE / `!` -> major
 *   - feat -> minor, BREAKING CHANGE / `!` -> major
 *   - every other commit -> patch (any commit bumps at least patch)
 *   - the single highest bump across commits since the latest vX.Y.Z tag
 *     is applied once
 *   - if no tag exists the first release is always v0.1.0
 *
 * Side-effect-light: writes a JSON plan and a markdown release body, and
 * (with --github-output) appends outputs to $GITHUB_OUTPUT. Tag and release
 * creation are done by the workflow, not this script.
 *
 * Usage:
 *   node scripts/release.mjs plan --root=. [--head=HEAD] [--notes=path] [--json=path]
 *       [--github-output]
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
}

const SIGNOFF_RE = /^(Signed-off-by:|Co-authored-by:|Reviewed-by:|Acked-by:|Change-Id:|Generated[ -](with|by)\b)/i;
const CONVENTIONAL_PREFIX_RE = /^(?:[a-z]+(?:\([^)]+\))?!?:\s*|BREAKING CHANGE:?\s*)/i;
const SKIP_SUBJECT_RE = /^chore\((release|release-notes)\):/i;

function parseSemverTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function formatVersion(version) {
  return `v${version[0]}.${version[1]}.${version[2]}`;
}

function bumpSemver(version, bumpType) {
  switch (bumpType) {
    case 'major':
      return [version[0] + 1, 0, 0];
    case 'minor':
      return [version[0], version[1] + 1, 0];
    case 'patch':
      return [version[0], version[1], version[2] + 1];
    default:
      return version.slice();
  }
}

// Breaking is signalled by `!` in the subject or a `BREAKING CHANGE:` /
// `BREAKING-CHANGE:` footer. The footer check is line-anchored so prose that
// merely mentions the convention doesn't count as breaking.
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/m;

function isBreaking(subject, body = '') {
  return /!:/.test(subject) || BREAKING_FOOTER_RE.test(body);
}

function getCommitBump(subject, body = '') {
  if (isBreaking(subject, body)) return 'major';
  if (/^feat(\([^)]+\))?!?:/i.test(subject)) return 'minor';
  return 'patch';
}

function getChangelogGroup(subject, body = '') {
  if (isBreaking(subject, body)) return 'breaking';
  if (/^feat(\([^)]+\))?!?:/i.test(subject)) return 'feature';
  if (/^fix(\([^)]+\))?!?:/i.test(subject)) return 'fix';
  if (/^docs(\([^)]+\))?:/i.test(subject)) return 'docs';
  if (/^refactor(\([^)]+\))?:/i.test(subject)) return 'refactor';
  if (/^test(\([^)]+\))?:/i.test(subject)) return 'test';
  if (/^chore(\([^)]+\))?:/i.test(subject)) return 'chore';
  return 'other';
}

function humanizeCommitSubject(subject) {
  const cleaned = subject.replace(CONVENTIONAL_PREFIX_RE, '').trim();
  if (cleaned === '') return subject.trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// Extract a readable description from a commit body: bullet lines become a
// list, otherwise the first meaningful paragraph. Mirrors the PHP
// cleanCommitDescription() in BoxOfDragons' GenerateBuildInfo.php.
function cleanCommitDescription(subject, body) {
  body = (body || '').trim();
  if (body === '') return null;

  const lines = body.split(/\r?\n+/);
  const hasBullets = lines.some((line) => {
    const t = line.trim();
    return t !== '' && !SIGNOFF_RE.test(t) && /^[-*]\s/.test(t);
  });

  const subjectSummary = subject.replace(CONVENTIONAL_PREFIX_RE, '').trim();
  const stripRedundant = (text) => {
    let t = text.trim().replace(/\s+/g, ' ');
    const m = CONVENTIONAL_PREFIX_RE.exec(t);
    if (m) {
      const rest = t.slice(m[0].length).trim();
      if (rest !== '') t = rest;
    }
    if (subjectSummary !== '' && t.toLowerCase().startsWith(subjectSummary.toLowerCase())) {
      t = t.slice(subjectSummary.length).trim();
    }
    return t;
  };

  if (hasBullets) {
    const bullets = [];
    let current = null;
    const flush = () => {
      if (current === null) return;
      const t = stripRedundant(current);
      if (t !== '') bullets.push(t);
      current = null;
    };
    for (const line of lines) {
      const t = line.trim();
      if (t === '' || SIGNOFF_RE.test(t)) {
        flush();
        continue;
      }
      if (/^[-*]\s+/.test(line)) {
        flush();
        current = t.replace(/^[-*]\s+/, '');
      } else if (current !== null && /^\s+/.test(line)) {
        current += ' ' + t;
      } else {
        flush();
        current = t;
      }
    }
    flush();
    return bullets.length > 0 ? bullets : null;
  }

  for (const line of lines) {
    const t = line.trim();
    if (t === '' || SIGNOFF_RE.test(t)) continue;
    const cleaned = stripRedundant(t.replace(/^[-*]\s*/, ''));
    if (cleaned !== '') return cleaned;
  }
  return null;
}


function findLatestTag(root, headRef) {
  const output = git(root, 'tag', '--merged', headRef, '--list', 'v*');
  const tags = [];
  for (const line of output.split('\n')) {
    const version = parseSemverTag(line);
    if (version) tags.push({ tag: line.trim(), version });
  }
  if (tags.length === 0) return null;
  tags.sort((a, b) => compareSemver(b.version, a.version));
  return tags[0];
}

function getCommitsSince(root, latestTag, headRef) {
  const rangeArgs = latestTag ? [`${latestTag}..${headRef}`] : [headRef];
  const output = git(
    root,
    'log',
    ...rangeArgs,
    '--reverse',
    '--no-merges',
    '--date=short',
    '--pretty=format:%H%x1f%ad%x1f%s%x1f%B%x1e',
    '--',
    '.',
  );

  const commits = [];
  for (const record of output.split('\x1e')) {
    if (record.trim() === '') continue;
    const parts = record.split('\x1f', 4);
    if (parts.length !== 4) continue;
    const subject = parts[2].trim();
    if (SKIP_SUBJECT_RE.test(subject)) continue;
    commits.push({
      sha: parts[0].trim(),
      date: parts[1].trim(),
      subject,
      body: parts[3],
    });
  }
  return commits;
}

function buildPlan(root, headRef, notesPath, jsonPath) {
  const latestTag = findLatestTag(root, headRef);
  const commits = getCommitsSince(root, latestTag ? latestTag.tag : null, headRef);

  // Single-bump semantics: the highest bump across all commits since the
  // latest tag is applied once. Any commit counts — non-feat/breaking types
  // bump patch.
  let bumpType = 'none';
  const rank = { none: 0, patch: 1, minor: 2, major: 3 };

  const groupOrder = ['breaking', 'feature', 'fix', 'docs', 'refactor', 'test', 'chore', 'other'];
  const groupLabels = {
    breaking: 'Breaking Changes',
    feature: 'Features',
    fix: 'Fixes',
    docs: 'Documentation',
    refactor: 'Refactors',
    test: 'Tests',
    chore: 'Maintenance',
    other: 'Other Changes',
  };
  const grouped = Object.fromEntries(groupOrder.map((g) => [g, []]));

  for (const commit of commits) {
    const bump = getCommitBump(commit.subject, commit.body);
    if (rank[bump] > rank[bumpType]) bumpType = bump;

    const description = cleanCommitDescription(commit.subject, commit.body);
    grouped[getChangelogGroup(commit.subject, commit.body)].push({
      title: humanizeCommitSubject(commit.subject),
      details: description === null
        ? []
        : Array.isArray(description)
          ? description
          : [description],
    });
  }

  const shouldRelease = bumpType !== 'none';
  // With no prior tag the first release is always v0.1.0, regardless of the
  // bump types in history.
  const nextVersion = shouldRelease
    ? latestTag
      ? bumpSemver(latestTag.version, bumpType)
      : [0, 1, 0]
    : null;
  const releaseTag = nextVersion ? formatVersion(nextVersion) : null;
  const displayVersion = releaseTag || (latestTag ? latestTag.tag : 'v0.1.0');

  const notes = [];
  if (shouldRelease) {
    notes.push(`# ${releaseTag}`, '', latestTag ? `Changes since ${latestTag.tag}.` : 'Initial tagged release.', '');
    for (const group of groupOrder) {
      const items = grouped[group];
      if (items.length === 0) continue;
      notes.push(`## ${groupLabels[group]}`, '');
      for (const item of items) {
        notes.push(`- ${item.title}`);
        for (const detail of item.details) notes.push(`  - ${detail}`);
      }
      notes.push('');
    }
    notes.push('---', '', `_Generated from ${commits.length} commits._`, '');
  } else {
    notes.push(
      '# No release planned',
      '',
      'No commits were found',
      latestTag ? `since ${latestTag.tag}.` : 'in the history.',
      '',
    );
  }

  mkdirSync(dirname(notesPath), { recursive: true });
  writeFileSync(notesPath, notes.join('\n'), 'utf8');

  const plan = {
    latestTag: latestTag ? latestTag.tag : null,
    latestVersion: latestTag ? formatVersion(latestTag.version) : null,
    nextVersion: releaseTag,
    releaseTag,
    displayVersion,
    bumpType,
    shouldRelease,
    commitCount: commits.length,
    notesPath,
  };

  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return plan;
}

const args = parseArgs(process.argv);
const command = args._[0] || 'plan';
const root = args.root ? resolve(args.root) : process.cwd();
const headRef = args.head || 'HEAD';
const notesPath = args.notes ? resolve(args.notes) : resolve(root, '.github/release-notes.md');
const jsonPath = args.json ? resolve(args.json) : resolve(root, '.github/release-plan.json');

if (command !== 'plan') {
  console.error(`Unknown command: ${command}. Only "plan" is supported.`);
  process.exit(1);
}

const plan = buildPlan(root, headRef, notesPath, jsonPath);

if (args['github-output'] && process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `release_tag=${plan.releaseTag || ''}`,
      `should_release=${plan.shouldRelease}`,
      `display_version=${plan.displayVersion}`,
      `bump_type=${plan.bumpType}`,
      `notes_path=${plan.notesPath}`,
    ].join('\n') + '\n',
  );
}

console.log(JSON.stringify(plan, null, 2));
