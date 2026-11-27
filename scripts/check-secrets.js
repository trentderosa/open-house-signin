#!/usr/bin/env node
/*
 * Fails if anything private is about to be published. This repo is PUBLIC,
 * so real emails, phone numbers, Sheet/Script IDs, tokens, keys, blocked
 * personal names and clasp credential files must never be committed.
 *
 * Scans every file git would publish: tracked files plus new files that are
 * not ignored (`git ls-files --cached --others --exclude-standard`).
 *
 * Deliberate placeholder or test fixture on one line? Put the marker
 *   check-secrets: allow
 * in a comment on that same line. Use sparingly; reviewers should question it.
 *
 *   npm run check:secrets
 */
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALLOW_MARKER = 'check-secrets: allow';
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const ALLOWED_EMAIL_DOMAINS = ['example.com', 'example.org', 'example.net'];
const DOCS_ONLY_EMAILS = ['noreply@anthropic.com']; // check-secrets: allow
// Generated files we can't annotate. package-lock.json quotes public npm
// deprecation notices that include maintainers' addresses; tokens, IDs and
// keys are still scanned there.
const RULE_EXEMPT_FILES = { email: ['package-lock.json'] };
// Binary images (e.g. web/assets/logo.png) are skipped: their
// bytes can look like phone numbers or tokens by accident. SVG is text and is
// still scanned.
const BINARY_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif'];
const FORBIDDEN_FILES = ['.clasprc.json', '.clasp.json'];
// Blocked words (personal account names), stored only as sha256 hex of the
// lowercase word so the words themselves never appear in this public repo.
// Every alphanumeric token in a scanned file is lowercased, hashed, and
// compared. To add one:  printf '%s' 'word' | shasum -a 256
const BLOCKED_WORD_HASHES = [
  '3197cafb6cd7ecf256dbb3d833a80698543c2543d75acd3f2059946dbf3f94f0'
];

const RULES = [
  {
    id: 'email',
    message: 'Real email address (use name@example.com in examples)',
    pattern: /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g,
    allow(match, file) {
      const lower = match.toLowerCase();
      const domain = lower.split('@')[1];
      if (ALLOWED_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) return true;
      return DOCS_ONLY_EMAILS.includes(lower) && file.startsWith('docs/');
    }
  },
  {
    id: 'phone',
    message: 'US phone number outside the fake 555-01xx range',
    pattern: /(?<![\w.])(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?![\w])/g,
    allow(match, file, groups) {
      return groups[2] === '555' && /^01\d\d$/.test(groups[3]);
    }
  },
  {
    id: 'google-id-url',
    message: 'Google Sheet or Script ID in a URL',
    pattern: /(?:spreadsheets\/d\/|macros\/s\/)[A-Za-z0-9_-]{40,}/g
  },
  {
    id: 'google-id-key',
    message: 'Sheet/Script/Deployment ID assigned to a key',
    pattern: /(?:sheet|script|deployment)[_-]?id["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{40,}/gi
  },
  {
    id: 'github-token',
    message: 'GitHub token',
    pattern: /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g
  },
  {
    id: 'google-oauth-token',
    message: 'Google OAuth token',
    pattern: /ya29\.[A-Za-z0-9_-]{10,}|(?<![\w/])1\/\/0[A-Za-z0-9_-]{20,}/g
  },
  {
    id: 'refresh-token',
    message: 'OAuth refresh_token field',
    pattern: new RegExp('"refresh' + '_token"', 'g')
  },
  {
    id: 'private-key',
    message: 'Private key',
    pattern: new RegExp('-----BEGIN [A-Z ]*PRIVATE' + ' KEY-----', 'g')
  },
];

const sha256 = (w) => crypto.createHash('sha256').update(w).digest('hex');

/** Finds blocked words by hashing each lowercase alphanumeric token. */
function findBlockedWords(line, blockedHashes, cache) {
  const hits = [];
  if (!blockedHashes.size) return hits;
  const tokens = line.toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const t of tokens) {
    let h = cache.get(t);
    if (h === undefined) {
      h = sha256(t);
      cache.set(t, h);
    }
    if (blockedHashes.has(h)) hits.push(t);
  }
  return hits;
}

function mask(s) {
  if (s.length <= 8) return s.slice(0, 2) + '***';
  return s.slice(0, 4) + '***' + s.slice(-2);
}

function isForbiddenPath(file) {
  return FORBIDDEN_FILES.includes(path.posix.basename(file.replace(/\\/g, '/')));
}

const DEFAULT_BLOCKED = new Set(BLOCKED_WORD_HASHES);
const HASH_CACHE = new Map();

/**
 * Returns findings for one file's text: [{ file, line, rule, message, match }].
 * options.blockedHashes (iterable of sha256 hex) overrides the default list (tests).
 */
function scanText(file, text, options) {
  const blocked = options && options.blockedHashes ? new Set(options.blockedHashes) : DEFAULT_BLOCKED;
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes(ALLOW_MARKER)) return;
    for (const rule of RULES) {
      if ((RULE_EXEMPT_FILES[rule.id] || []).includes(file)) continue;
      rule.pattern.lastIndex = 0;
      let m;
      while ((m = rule.pattern.exec(line)) !== null) {
        if (!rule.allow || !rule.allow(m[0], file, m)) {
          findings.push({ file, line: i + 1, rule: rule.id, message: rule.message, match: mask(m[0]) });
        }
        if (m[0].length === 0) rule.pattern.lastIndex++;
      }
    }
    for (const word of findBlockedWords(line, blocked, HASH_CACHE)) {
      findings.push({ file, line: i + 1, rule: 'blocked-word', message: 'Blocked personal name/account (keep the repo owner-neutral)', match: mask(word) });
    }
  });
  return findings;
}

/** Scans a list of repo-relative paths. readFile(path) returns a Buffer. */
function scanFiles(files, readFile, options) {
  const findings = [];
  for (const file of files) {
    if (isForbiddenPath(file)) {
      findings.push({ file, line: 0, rule: 'forbidden-file', message: 'clasp credential/config file must never be committed', match: path.posix.basename(file) });
      continue;
    }
    if (BINARY_IMAGE_EXTENSIONS.includes(path.posix.extname(file).toLowerCase())) continue;
    let buf;
    try {
      buf = readFile(file);
    } catch {
      continue; // deleted in the working tree
    }
    if (buf.length > MAX_FILE_BYTES || buf.includes(0)) continue; // binary or huge
    findings.push(...scanText(file, buf.toString('utf8'), options));
  }
  return findings;
}

function listPublishableFiles(root) {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root });
  return out.toString('utf8').split('\0').filter(Boolean);
}

function main() {
  const root = path.join(__dirname, '..');
  const files = listPublishableFiles(root);
  const findings = scanFiles(files, (f) => fs.readFileSync(path.join(root, f)));
  if (findings.length) {
    console.error('check-secrets: found ' + findings.length + ' problem(s):');
    for (const f of findings) {
      console.error(`  ${f.file}${f.line ? ':' + f.line : ''}  [${f.rule}] ${f.message}: ${f.match}`);
    }
    console.error(`\nRemove the private value. For a deliberate fake placeholder, add "${ALLOW_MARKER}" in a comment on that line.`);
    process.exit(1);
  }
  console.log('check-secrets: scanned ' + files.length + ' files, nothing private found.');
}

if (require.main === module) main();

module.exports = { BINARY_IMAGE_EXTENSIONS, BLOCKED_WORD_HASHES, RULES, sha256, ALLOW_MARKER, scanText, scanFiles, isForbiddenPath, listPublishableFiles };
