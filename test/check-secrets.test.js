'use strict';

/*
 * Tests for scripts/check-secrets.js. Fake secrets are assembled from pieces
 * at runtime so this file itself stays clean for the scanner.
 */
const { scanText, scanFiles, isForbiddenPath, ALLOW_MARKER, BLOCKED_WORD_HASHES, sha256 } = require('../scripts/check-secrets.js');

const j = (...parts) => parts.join('');
const rules = (file, text) => scanText(file, text).map((f) => f.rule);
const LONG_ID = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2';

describe('emails', () => {
  test('allows example.com / example.org', () => {
    expect(rules('a.md', 'write to jane@example.com or ops@mail.example.org')).toEqual([]);
  });
  test('flags real-looking addresses', () => {
    expect(rules('a.js', j('const to = "someone', '@', 'gmail.com";'))).toEqual(['email']);
  });
  test('the Claude noreply address is allowed only under docs/', () => {
    const line = j('Co-Authored-By: Claude <noreply', '@', 'anthropic.com>');
    expect(rules('docs/x.md', line)).toEqual([]);
    expect(rules('src/x.js', line)).toEqual(['email']);
  });
  test('package-lock.json is exempt from the email rule only', () => {
    expect(rules('package-lock.json', j('contact i', '@', 'izs.me'))).toEqual([]);
    expect(rules('package-lock.json', j('gh', 'p_', 'a'.repeat(36)))).toEqual(['github-token']);
  });
  test('ignores npm scopes and CSS at-rules', () => {
    expect(rules('a.js', 'require("@eslint/js"); @media print {}')).toEqual([]);
  });
});

describe('phone numbers', () => {
  test('allows the fake 555-01xx range', () => {
    expect(rules('a.js', '555-555-0123 (555) 555-0199 +1 555 555 0100')).toEqual([]);
  });
  test('flags other US numbers', () => {
    expect(rules('a.js', j('call 703', '-', '555', '-', '1234'))).toEqual(['phone']);
    expect(rules('a.js', j('(202) ', '456', '-', '1111'))).toEqual(['phone']);
    expect(rules('a.js', j('+1 ', '571 ', '555 ', '0200'))).toEqual(['phone']);
  });
  test('does not flag long digit runs, versions, or hashes', () => {
    expect(rules('a.js', 'ts 1764355200000 v1.2.3 sha512-ab1234567890cd')).toEqual([]);
  });
});

describe('Google IDs', () => {
  test('flags long IDs in Sheet and Script URLs', () => {
    expect(rules('a.md', j('https://docs.google.com/', 'spreadsheets/d/', LONG_ID, '/edit'))).toEqual(['google-id-url']);
    expect(rules('a.js', j('https://script.google.com/', 'macros/s/', LONG_ID, '/exec'))).toEqual(['google-id-url']);
  });
  test('flags long IDs assigned to sheet/script id keys', () => {
    expect(rules('a.json', j('{"script', 'Id": "', LONG_ID, '"}'))).toEqual(['google-id-key']);
    expect(rules('a.js', j('SHEET', '_ID = \'', LONG_ID, '\''))).toEqual(['google-id-key']);
  });
  test('allows placeholders', () => {
    expect(rules('a.json', '{"scriptId": "PASTE_SCRIPT_ID_HERE"}')).toEqual([]);
    expect(rules('a.js', "var ENDPOINT_URL = 'PASTE_ENDPOINT_URL_HERE';")).toEqual([]);
    expect(rules('a.md', 'https://script.google.com/macros/s/<deployment-id>/exec')).toEqual([]);
  });
});

describe('tokens and keys', () => {
  test.each([
    ['github-token', j('gh', 'o_', 'A'.repeat(36))],
    ['github-token', j('gh', 'p_', 'b'.repeat(36))],
    ['github-token', j('github', '_pat_', '11ABC', '_'.repeat(2), 'x'.repeat(40))],
    ['google-oauth-token', j('ya', '29.', 'a0AfH6SMB', 'x'.repeat(30))],
    ['google-oauth-token', j('1/', '/0', 'gAbCdEfGhIjKlMnOpQrStUv')],
    ['refresh-token', j('{"refresh', '_token": "x"}')],
    ['private-key', j('-----BEGIN ', 'RSA PRIVATE', ' KEY-----')],
    ['private-key', j('-----BEGIN ', 'PRIVATE', ' KEY-----')]
  ])('flags %s', (rule, text) => {
    expect(rules('a.txt', text)).toContain(rule);
  });

  test('does not flag ordinary URLs with //', () => {
    expect(rules('a.js', 'https://www.example.com/path and http://1.example.com')).toEqual([]);
  });
});

describe('blocked words (stored as sha256 hashes)', () => {
  const fakeHash = sha256('zzblockedname');
  const scan = (text) => scanText('a.md', text, { blockedHashes: [fakeHash] }).map((f) => f.rule);

  test('flags a blocked word anywhere, any case, as a whole token', () => {
    expect(scan('see github.com/zzblockedname/repo')).toEqual(['blocked-word']);
    expect(scan('ZZBlockedName wrote this')).toEqual(['blocked-word']);
    expect(scan('zzblockedname.github.io')).toEqual(['blocked-word']);
  });

  test('does not flag other tokens or partial matches', () => {
    expect(scan('zzblocked name, zzblockednamex, nothing here')).toEqual([]);
  });

  test('the match is masked in the report', () => {
    const [f] = scanText('a.md', 'zzblockedname', { blockedHashes: [fakeHash] });
    expect(f.match).not.toBe('zzblockedname');
  });

  test('the default list holds only sha256 hex, never readable words', () => {
    expect(BLOCKED_WORD_HASHES.length).toBeGreaterThan(0);
    for (const h of BLOCKED_WORD_HASHES) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('allowlist marker', () => {
  test('a line with the marker is skipped', () => {
    expect(rules('a.js', j('x = "a', '@', 'gmail.com"; // ', ALLOW_MARKER))).toEqual([]);
  });
  test('the marker only covers its own line', () => {
    const text = j('ok // ', ALLOW_MARKER, '\nx = "a', '@', 'gmail.com"');
    const found = scanText('a.js', text);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
  });
});

describe('files', () => {
  test('clasp credential/config files may never be tracked', () => {
    expect(isForbiddenPath('.clasprc.json')).toBe(true);
    expect(isForbiddenPath('apps-script/admin/.clasp.json')).toBe(true);
    expect(isForbiddenPath('apps-script/admin/.clasp.json.example')).toBe(false);
  });

  test('binary images in web/assets are skipped even if their bytes look like secrets', () => {
    const fakeText = Buffer.from(j('703', '-', '555', '-', '1234 someone', '@', 'gmail.com'));
    const files = {
      'web/assets/logo.png': fakeText,
      'web/assets/photo.jpg': fakeText,
      'web/assets/PHOTO.JPEG': fakeText,
      'web/assets/logo.svg': fakeText
    };
    const found = scanFiles(Object.keys(files), (f) => files[f]);
    expect([...new Set(found.map((f) => f.file))]).toEqual(['web/assets/logo.svg']);
  });

  test('scanFiles reports forbidden files, skips binaries, and masks matches', () => {
    const files = {
      'apps-script/endpoint/.clasp.json': Buffer.from('{}'),
      'web/assets/logo.png': Buffer.from([0x89, 0x50, 0x00, 0x01]),
      'README.md': Buffer.from(j('mail me: real.person', '@', 'gmail.com'))
    };
    const found = scanFiles(Object.keys(files), (f) => files[f]);
    expect(found.map((f) => f.rule).sort()).toEqual(['email', 'forbidden-file']);
    const email = found.find((f) => f.rule === 'email');
    expect(email.match).not.toContain('person');
  });
});
