'use strict';

/* Repo-level guards: shared copies, manifests, and the static site. */
const fs = require('fs');
const path = require('path');
const { outOfDate, COPIES } = require('../scripts/sync-shared.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('shared files', () => {
  test('every copy matches its shared/ source (run `npm run sync` if this fails)', () => {
    expect(outOfDate()).toEqual([]);
  });

  test('the form and the endpoint use the same answer lists', () => {
    const web = require('../web/signin-rules.js');
    const endpoint = require('../apps-script/endpoint/signin-rules.js');
    expect(web.CHOICES).toEqual(endpoint.CHOICES);
    expect(web.FIELD_LIMITS).toEqual(endpoint.FIELD_LIMITS);
    expect(COPIES.map((e) => e.src)).toContain('shared/signin-rules.js');
  });
});

describe('Apps Script manifests', () => {
  test('admin: only-me web app with the narrowest Sheets scope', () => {
    const m = JSON.parse(read('apps-script/admin/appsscript.json'));
    expect(m.webapp).toEqual({ access: 'MYSELF', executeAs: 'USER_DEPLOYING' });
    expect(m.oauthScopes).toEqual(['https://www.googleapis.com/auth/spreadsheets.currentonly']);
    expect(m.runtimeVersion).toBe('V8');
  });

  test('endpoint: anonymous web app with exactly the scopes it needs', () => {
    const m = JSON.parse(read('apps-script/endpoint/appsscript.json'));
    expect(m.webapp).toEqual({ access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' });
    expect(m.oauthScopes.sort()).toEqual([
      'https://www.googleapis.com/auth/script.external_request',
      'https://www.googleapis.com/auth/script.send_mail',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/userinfo.email'
    ]);
  });

  test('UrlFetchApp is used only by the email-image loader (no other outside calls)', () => {
    const code = read('apps-script/endpoint/Code.js');
    const calls = code.match(/UrlFetchApp\.\w+\(/g) || [];
    expect(calls).toEqual(['UrlFetchApp.fetchAll(']);
    const loader = code.slice(code.indexOf('function loadInlineImages_'), code.indexOf('if (typeof module'));
    expect(loader).toContain('UrlFetchApp.fetchAll(');
    for (const f of fs.readdirSync(path.join(ROOT, 'apps-script/endpoint')).filter((x) => x !== 'Code.js' && x.endsWith('.js'))) {
      expect(read('apps-script/endpoint/' + f)).not.toMatch(/UrlFetchApp\.\w+\(/);
    }
  });

  test('endpoint never uses GmailApp or Drive', () => {
    for (const f of fs.readdirSync(path.join(ROOT, 'apps-script/endpoint')).filter((x) => x.endsWith('.js'))) {
      expect(read('apps-script/endpoint/' + f)).not.toMatch(/GmailApp|DriveApp/);
    }
  });
});

describe('guest form (static site)', () => {
  const html = read('web/index.html');

  test('has a strict CSP meta tag limited to self + Apps Script', () => {
    const m = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
    expect(m).not.toBeNull();
    const csp = m[1];
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/script-src 'self'(;|$)/);
    expect(csp).toMatch(/connect-src https:\/\/script\.google\.com https:\/\/script\.googleusercontent\.com(;|$)/);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(html).toMatch(/<meta name="referrer" content="no-referrer">/);
  });

  test('loads no third-party scripts, styles or fonts and uses relative paths', () => {
    const srcs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((x) => x[1]);
    for (const s of srcs) {
      expect(s).not.toMatch(/^(https?:)?\/\//);
      expect(s).not.toMatch(/^\//); // GitHub Pages serves under /<repo>/
    }
    expect(html).not.toMatch(/googleapis|gstatic|analytics|gtag/i);
    expect(html).not.toMatch(/<script>(?!\s*<\/script>)/); // no inline scripts
  });

  test('Pages workflow writes config.js from a repo variable, never ${{ }} inside run:', () => {
    const yml = read('.github/workflows/pages.yml');
    expect(yml).toMatch(/workflow_run:\s*\n\s*workflows: \[CI\]/);
    expect(yml).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(yml).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(yml).toContain('!github.event.repository.private');
    expect(yml).toContain('ENDPOINT_URL: ${{ vars.ENDPOINT_URL }}');
    expect(yml).toContain("grep -Eq '^https://script\\.google\\.com/macros/s/[A-Za-z0-9_-]+/exec$'");
    const runBlocks = yml.split(/\n\s*run: \|\n/).slice(1).map((b) => b.split(/\n\s*- /)[0]);
    expect(runBlocks.length).toBeGreaterThan(0);
    for (const b of runBlocks) expect(b).not.toContain('${{');
  });

  test('no _headers file (GitHub Pages ignores it)', () => {
    expect(fs.existsSync(path.join(ROOT, 'web/_headers'))).toBe(false);
  });

  test('honeypot field is hidden from people and skipped by keyboard', () => {
    expect(html).toMatch(/<input id="hp_contact_ref" name="hp_contact_ref" type="text" tabindex="-1" autocomplete="off">/);
  });

  test('config.js holds only the endpoint placeholder', () => {
    const cfg = read('web/config.js').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    expect(cfg).toBe("var ENDPOINT_URL = 'PASTE_ENDPOINT_URL_HERE';");
  });
});
