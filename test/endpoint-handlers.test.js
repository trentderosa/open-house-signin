'use strict';

const { loadGas } = require('./helpers/load.js');
const { FakeSpreadsheet, installGasMocks } = require('./helpers/fakes.js');

const gas = loadGas([
  'apps-script/endpoint/sheet-core.js',
  'apps-script/endpoint/signin-rules.js',
  'apps-script/endpoint/EndpointLib.js',
  'apps-script/endpoint/Code.js'
]);

const HOUSE_ID = 'a1b2c3d4e5f6a7b8c9d0';
const OFF_ID = 'f0e1d2c3b4a5968778695a4b';

function makeSs(settingsOverrides = {}) {
  const settings = {
    website_url: 'https://www.example.com',
    agent_name: 'Agent Example',
    office_name: 'Example Realty',
    ...settingsOverrides
  };
  return new FakeSpreadsheet({
    Houses: [
      global.HOUSE_HEADERS,
      [HOUSE_ID, new Date('2026-11-01'), true, '12 Oak St', 450000, 3, 2, 1800, 'Sunny.', 'https://www.example.com/l'],
      [OFF_ID, new Date('2026-10-01'), false, '9 Elm Ave', '', '', '', '', '', '']
    ],
    SignIns: [global.SIGNIN_HEADERS.slice()],
    Settings: [global.SETTINGS_HEADERS, ...Object.entries(settings).map(([k, v]) => [k, v, ''])]
  });
}

function post(body) {
  const out = gas.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
  return JSON.parse(out.text);
}

function get(h) {
  return JSON.parse(gas.doGet({ parameter: h === undefined ? {} : { h } }).text);
}

const guest = {
  h: HOUSE_ID,
  name: 'Jane Doe',
  phone: '555-555-0123',
  email: 'jane@example.com',
  agent: 'Not yet',
  timeline: '3–6 months',
  preapproved: 'Paying cash',
  heard_from: 'Zillow',
  comments: 'Nice yard',
  hp_contact_ref: ''
};

describe('doGet', () => {
  test('returns public info for an active house', () => {
    const ss = makeSs();
    installGasMocks(ss);
    const res = get(HOUSE_ID);
    expect(res.ok).toBe(true);
    expect(res.house.address).toBe('12 Oak St');
    expect(res.house).not.toHaveProperty('id');
    expect(res.house).not.toHaveProperty('active');
    expect(res.branding).toEqual({ agent_name: 'Agent Example', office_name: 'Example Realty' });
    expect(JSON.stringify(res)).not.toMatch(/notify_email|website_url|signins/i);
  });

  test('404-style error for unknown, inactive, missing or malformed ids', () => {
    installGasMocks(makeSs());
    for (const h of [undefined, '', 'zzz', 'b'.repeat(20), OFF_ID]) {
      const res = get(h);
      expect(res.ok).toBe(false);
      expect(res.status).toBe(404);
    }
  });

  test('never returns sign-ins', () => {
    const ss = makeSs();
    installGasMocks(ss);
    post(guest);
    expect(JSON.stringify(get(HOUSE_ID))).not.toContain('jane@example.com');
  });
});

describe('doPost', () => {
  test('saves the sign-in, emails agent and guest, returns redirect', () => {
    const ss = makeSs();
    const m = installGasMocks(ss);
    const res = post(guest);
    expect(res).toEqual({ ok: true, redirect: 'https://www.example.com' });

    const rows = ss.getSheetByName('SignIns').rows;
    expect(rows).toHaveLength(2);
    expect(rows[1].slice(1)).toEqual([HOUSE_ID, '12 Oak St', 'Jane Doe', '555-555-0123', 'jane@example.com', 'Not yet', '3–6 months', 'Paying cash', 'Zillow', 'Nice yard']);

    expect(m.sent).toHaveLength(2);
    const [owner, thanks] = m.sent;
    expect(owner.to).toBe('agent@example.com');
    expect(owner.subject).toBe('Open House Sign-in: Jane Doe — 12 Oak St');
    expect(owner.replyTo).toBe('jane@example.com');
    expect(thanks.to).toBe('jane@example.com');
    expect(thanks.name).toBe('Agent Example');
    expect(thanks.replyTo).toBe('agent@example.com');

    // No images configured, so nothing is fetched from outside.
    expect(m.fetches).toHaveLength(0);
  });

  test('uses notify_email when set and redirect "" when website_url blank', () => {
    const m = installGasMocks(makeSs({ notify_email: 'office@example.com', website_url: '' }));
    const res = post(guest);
    expect(res).toEqual({ ok: true, redirect: '' });
    expect(m.sent[0].to).toBe('office@example.com');
  });

  test('honeypot filled: reports success but stores and sends nothing', () => {
    const ss = makeSs();
    const m = installGasMocks(ss);
    const res = post({ ...guest, hp_contact_ref: 'http://spam.example.com' });
    expect(res.ok).toBe(true);
    expect(ss.getSheetByName('SignIns').rows).toHaveLength(1);
    expect(m.sent).toHaveLength(0);
    expect(m.fetches).toHaveLength(0);
  });

  test('validation errors are friendly and nothing is saved', () => {
    const ss = makeSs();
    const m = installGasMocks(ss);
    const res = post({ ...guest, email: 'nope' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/email/i);
    expect(ss.getSheetByName('SignIns').rows).toHaveLength(1);
    expect(m.sent).toHaveLength(0);
  });

  test('rejects inactive or unknown houses', () => {
    installGasMocks(makeSs());
    expect(post({ ...guest, h: OFF_ID }).ok).toBe(false);
    expect(post({ ...guest, h: 'c'.repeat(20) }).error).toMatch(/isn.t valid/);
  });

  test('rejects unreadable or oversized bodies', () => {
    installGasMocks(makeSs());
    expect(post('not json').ok).toBe(false);
    expect(post('x'.repeat(20001)).ok).toBe(false);
    expect(JSON.parse(gas.doPost({}).text).ok).toBe(false);
  });

  test('formula injection is neutralised in the saved row', () => {
    const ss = makeSs();
    installGasMocks(ss);
    post({ ...guest, name: '=HYPERLINK("http://evil.example.com")', comments: '@cmd' });
    const row = ss.getSheetByName('SignIns').rows[1];
    expect(row[3]).toBe('\'=HYPERLINK("http://evil.example.com")');
    expect(row[10]).toBe("'@cmd");
  });

  test('email and image-fetch failures do not lose the sign-in', () => {
    const ss = makeSs();
    installGasMocks(ss, { mailThrows: true, fetchThrows: true });
    const res = post(guest);
    expect(res.ok).toBe(true);
    expect(ss.getSheetByName('SignIns').rows).toHaveLength(2);
    expect(console.error).toHaveBeenCalled();
  });

  test('rate limit: max 30 per house per window', () => {
    // Freeze the clock mid-window so the test can't straddle a window boundary.
    jest.useFakeTimers({ now: new Date('2026-11-28T18:01:00Z') });
    const ss = makeSs();
    installGasMocks(ss);
    for (let i = 0; i < 30; i++) expect(post({ ...guest, email: `guest${i}@example.com` }).ok).toBe(true);
    const res = post(guest);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/too many/i);
    expect(ss.getSheetByName('SignIns').rows).toHaveLength(31);
    jest.useRealTimers();
  });

  test('busy lock returns a friendly error and saves nothing', () => {
    const ss = makeSs();
    installGasMocks(ss, { lockOk: false });
    const res = post(guest);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/moment/);
    expect(ss.getSheetByName('SignIns').rows).toHaveLength(1);
  });

  describe('inline email images', () => {
    const PNG = [-119, 80, 78, 71, 13, 10, 26, 10, 0, 0];
    const JPG = [-1, -40, -1, -32, 0, 16];
    const LOGO = 'https://example.github.io/oh/assets/logo.png';
    const HEAD = 'https://example.github.io/oh/assets/headshot.jpg';

    test('fetches, embeds by cid, and caches small images', () => {
      const m = installGasMocks(makeSs({ logo_url: LOGO, headshot_url: HEAD }), {
        responses: {
          [LOGO]: { code: 200, headers: { 'Content-Type': 'image/png' }, bytes: PNG },
          [HEAD]: { code: 200, headers: { 'content-type': 'image/jpeg' }, bytes: JPG }
        }
      });
      expect(post(guest).ok).toBe(true);
      const thanks = m.sent.find((x) => x.to === 'jane@example.com');
      expect(Object.keys(thanks.inlineImages).sort()).toEqual(['headshot', 'logo']);
      expect(thanks.inlineImages.logo.mime).toBe('image/png');
      expect(thanks.htmlBody).toContain('cid:logo');
      expect(thanks.htmlBody).toContain('cid:headshot');
      expect(m.cache.get('img:' + LOGO)).toMatch(/^image\/png\|/);

      // Second guest: served from cache, no new fetches.
      const before = m.fetches.length;
      post({ ...guest, email: 'john@example.com' });
      expect(m.fetches.length).toBe(before);
      const second = m.sent.find((x) => x.to === 'john@example.com');
      expect(second.inlineImages.logo.bytes).toEqual(PNG);
    });

    test('a bad image is left out but the email still goes and the sign-in is saved', () => {
      const ss = makeSs({ logo_url: LOGO, headshot_url: HEAD });
      const m = installGasMocks(ss, {
        responses: {
          [LOGO]: { code: 200, headers: { 'Content-Type': 'image/svg+xml' }, bytes: [60, 115, 118, 103] },
          [HEAD]: { code: 404, headers: {}, bytes: [] }
        }
      });
      expect(post(guest).ok).toBe(true);
      const thanks = m.sent.find((x) => x.to === 'jane@example.com');
      expect(thanks.inlineImages).toBeUndefined();
      expect(thanks.htmlBody).not.toContain('cid:');
      expect(ss.getSheetByName('SignIns').rows).toHaveLength(2);
    });

    test('a network error fetching images never fails the sign-in', () => {
      const ss = makeSs({ logo_url: LOGO });
      const m = installGasMocks(ss, { fetchThrows: true });
      expect(post(guest).ok).toBe(true);
      expect(m.sent.find((x) => x.to === 'jane@example.com')).toBeDefined();
    });
  });

  describe('mail quota and abuse limits', () => {
    test('skips the guest thank-you when fewer than 20 emails are left today (agent still emailed)', () => {
      const m = installGasMocks(makeSs(), { mailQuota: 19 });
      expect(post(guest).ok).toBe(true);
      expect(m.sent.map((x) => x.to)).toEqual(['agent@example.com']);
      expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/Skipping guest thank-you email: only 19 emails left/));
    });

    test('caps thank-you emails at 10 per house per hour', () => {
      jest.useFakeTimers({ now: new Date('2026-11-28T18:01:00Z') });
      const m = installGasMocks(makeSs());
      for (let i = 0; i < 12; i++) expect(post({ ...guest, email: `g${i}@example.com` }).ok).toBe(true);
      const thanks = m.sent.filter((x) => x.to !== 'agent@example.com');
      expect(thanks).toHaveLength(10);
      expect(m.sent.filter((x) => x.to === 'agent@example.com')).toHaveLength(12);
      jest.useRealTimers();
    });
  });

  describe('idempotent retries (sid)', () => {
    const sid = 'ab12'.repeat(8);

    test('the same sid is saved and notified only once', () => {
      const ss = makeSs();
      const m = installGasMocks(ss);
      expect(post({ ...guest, sid })).toEqual({ ok: true, redirect: 'https://www.example.com' });
      expect(post({ ...guest, sid })).toEqual({ ok: true, redirect: 'https://www.example.com' });
      expect(ss.getSheetByName('SignIns').rows).toHaveLength(2);
      expect(m.sent).toHaveLength(2);
    });

    test('different sids are separate sign-ins', () => {
      const ss = makeSs();
      installGasMocks(ss);
      post({ ...guest, sid });
      post({ ...guest, sid: 'cd34'.repeat(8) });
      expect(ss.getSheetByName('SignIns').rows).toHaveLength(3);
    });
  });

  test.each([
    ['SpreadsheetApp.flush', () => { global.SpreadsheetApp.flush = () => { throw new Error('flush boom'); }; }],
    ['cache.put', () => {
      const realGet = global.CacheService.getScriptCache;
      global.CacheService.getScriptCache = () => {
        const c = realGet();
        return { ...c, put: () => { throw new Error('cache boom'); } };
      };
    }]
  ])('a %s failure after the row is saved still returns ok (no duplicate-inducing error)', (_name, breakIt) => {
    const ss = makeSs();
    installGasMocks(ss);
    breakIt();
    expect(post({ ...guest, sid: 'ef56'.repeat(8) }).ok).toBe(true);
    expect(ss.getSheetByName('SignIns').rows).toHaveLength(2);
  });

  test('a failure while preparing alerts (e.g. date formatting) still returns ok', () => {
    const ss = makeSs();
    installGasMocks(ss, { formatDateThrows: true });
    global.Session.getScriptTimeZone = () => { throw new Error('boom'); };
    expect(post(guest).ok).toBe(true);
    expect(ss.getSheetByName('SignIns').rows).toHaveLength(2);
  });

  test('even if every notification path throws, a saved sign-in returns ok', () => {
    const ss = makeSs();
    installGasMocks(ss, { mailThrows: true, fetchThrows: true });
    global.MailApp.getRemainingDailyQuota = () => { throw new Error('quota service down'); };
    global.Session.getEffectiveUser = () => { throw new Error('no session'); };
    expect(post(guest).ok).toBe(true);
    expect(ss.getSheetByName('SignIns').rows).toHaveLength(2);
  });

  test('only one thank-you email per guest per house in the dedupe window', () => {
    const m = installGasMocks(makeSs());
    post(guest);
    post(guest);
    const toGuest = m.sent.filter((s) => s.to === 'jane@example.com');
    expect(toGuest).toHaveLength(1);
  });
});
