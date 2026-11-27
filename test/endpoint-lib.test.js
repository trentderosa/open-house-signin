'use strict';

const { loadGas } = require('./helpers/load.js');

const lib = loadGas([
  'apps-script/endpoint/sheet-core.js',
  'apps-script/endpoint/signin-rules.js',
  'apps-script/endpoint/EndpointLib.js'
]);

const XSS = '<script>alert("x")</script>';

const signin = {
  houseId: 'a1b2c3d4e5f6a7b8c9d0',
  name: 'Jane Doe',
  phone: '555-555-0123',
  email: 'jane@example.com',
  agent: 'No',
  timeline: '12+ months',
  preapproved: 'Cash',
  heard_from: 'Signs',
  comments: 'Is the roof new?\nThanks!'
};

const house = {
  id: 'a1b2c3d4e5f6a7b8c9d0',
  created_at: new Date('2026-11-01T12:00:00Z'),
  active: true,
  address: '12 Oak St',
  price: 450000,
  beds: 3,
  baths: 2.5,
  sqft: 1800,
  description: 'Sunny colonial.',
  listing_url: 'https://www.example.com/listing/12-oak',
  notes: 'private note',
  secret_field: 'nope'
};

const settings = {
  agent_name: 'Agent Example',
  agent_phone: '555-555-0100',
  office_name: 'Example Realty',
  logo_url: 'https://www.example.com/logo.png',
  website_url: '',
  notify_email: ''
};

describe('escapeHtml', () => {
  test('escapes the five HTML special characters', () => {
    expect(lib.escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    expect(lib.escapeHtml(null)).toBe('');
  });
});

describe('toPublicHouse', () => {
  test('returns only public fields', () => {
    const pub = lib.toPublicHouse(house);
    expect(Object.keys(pub).sort()).toEqual([...lib.PUBLIC_HOUSE_FIELDS].sort());
    expect(pub).not.toHaveProperty('id');
    expect(pub).not.toHaveProperty('active');
    expect(pub).not.toHaveProperty('created_at');
    expect(pub).not.toHaveProperty('notes');
    expect(JSON.stringify(pub)).not.toMatch(/private note|nope/);
    expect(pub.price).toBe('$450,000');
    expect(pub.baths).toBe('2.5');
  });

  test('drops unsafe listing links', () => {
    expect(lib.toPublicHouse({ ...house, listing_url: 'javascript:alert(1)' }).listing_url).toBe('');
  });
});

describe('resolveRedirect', () => {
  test('uses website_url when it is a real URL', () => {
    expect(lib.resolveRedirect({ website_url: 'https://www.example.com' })).toBe('https://www.example.com');
    expect(lib.resolveRedirect({ website_url: 'www.example.com' })).toBe('https://www.example.com');
  });
  test('falls back to empty string', () => {
    expect(lib.resolveRedirect({ website_url: '' })).toBe('');
    expect(lib.resolveRedirect({})).toBe('');
    expect(lib.resolveRedirect(null)).toBe('');
    expect(lib.resolveRedirect({ website_url: 'javascript:alert(1)' })).toBe('');
    expect(lib.resolveRedirect({ website_url: 'my website' })).toBe('');
  });
});

describe('resolveNotifyEmail', () => {
  test('prefers a valid notify_email, else the owner', () => {
    expect(lib.resolveNotifyEmail({ notify_email: 'a@example.com, b@example.com' }, 'owner@example.com')).toBe('a@example.com,b@example.com');
    expect(lib.resolveNotifyEmail({ notify_email: '' }, 'owner@example.com')).toBe('owner@example.com');
    expect(lib.resolveNotifyEmail({ notify_email: 'not an email' }, 'owner@example.com')).toBe('owner@example.com');
  });
});

describe('owner email', () => {
  test('subject keeps the stable filter prefix', () => {
    const mail = lib.buildOwnerEmail(signin, house, 'today');
    expect(mail.subject).toBe('Open House Sign-in: Jane Doe — 12 Oak St');
    expect(mail.subject.startsWith(lib.OWNER_SUBJECT_PREFIX)).toBe(true);
  });

  test('includes every guest field and the house', () => {
    const mail = lib.buildOwnerEmail(signin, house, 'today');
    for (const v of ['Jane Doe', '555-555-0123', 'jane@example.com', '12+ months', 'Cash', 'Signs', '12 Oak St']) {
      expect(mail.htmlBody).toContain(v);
      expect(mail.body).toContain(v);
    }
  });

  test('HTML-escapes guest input like <script> in the name and comments', () => {
    const evil = { ...signin, name: XSS, comments: `<img src=x onerror=alert(1)>` };
    const mail = lib.buildOwnerEmail(evil, { ...house, address: '<b>12 Oak</b>' }, 'today');
    expect(mail.htmlBody).not.toContain('<script>');
    expect(mail.htmlBody).not.toContain('<img src=x');
    expect(mail.htmlBody).not.toContain('<b>12 Oak</b>');
    expect(mail.htmlBody).toContain('&lt;script&gt;');
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  test('subject cannot carry header-injection newlines', () => {
    const mail = lib.buildOwnerEmail({ ...signin, name: 'Jane\r\nBcc: x@example.com' }, house, 'today');
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });
});

describe('guest thank-you email', () => {
  test('contains the house details and signature', () => {
    const mail = lib.buildGuestEmail(signin, house, settings);
    expect(mail.name).toBe('Agent Example');
    expect(mail.subject).toBe('Thanks for visiting 12 Oak St');
    for (const v of ['Hi Jane', '12 Oak St', '$450,000', '1800', 'Sunny colonial.', 'https://www.example.com/listing/12-oak', 'Agent Example', '555-555-0100', 'Example Realty']) {
      expect(mail.htmlBody).toContain(v);
    }
    expect(mail.htmlBody).not.toContain('<img'); // no images unless they were fetched for embedding
    expect(mail.htmlBody).not.toContain('https://www.example.com/logo.png');
    expect(mail.body).toContain('Full listing: https://www.example.com/listing/12-oak');
    expect(mail.body).not.toMatch(/<[a-z]/i);
  });

  test('HTML-escapes the guest name and house text', () => {
    const mail = lib.buildGuestEmail(
      { ...signin, name: XSS },
      { ...house, description: '<iframe src="https://evil.example.com">', address: '"><script>x</script>' },
      { ...settings, agent_name: '<b>Agent</b>', logo_url: 'javascript:alert(1)' }
    );
    expect(mail.htmlBody).not.toMatch(/<script|<iframe|<b>Agent/);
    expect(mail.htmlBody).not.toContain('javascript:');
    expect(mail.htmlBody).toContain('&lt;iframe');
  });

  test('works with blank optional settings (no logo, no phone)', () => {
    const mail = lib.buildGuestEmail(signin, { address: '12 Oak St' }, { office_name: 'Example Realty' });
    expect(mail.name).toBe('Example Realty');
    expect(mail.htmlBody).not.toContain('<img');
    expect(mail.htmlBody).not.toContain('tel:');
  });
});

describe('guest greeting name', () => {
  test.each([
    ['Jane Doe', 'Jane'],
    ["  O'Brien-Smith  Pat", "O'Brien-Smith"],
    ['J.R. Doe', 'JR'],
    ['Zo\u00eb Example', 'Zo\u00eb'],
    ['A'.repeat(50), 'A'.repeat(30)],
    ['https://evil.example.com/login', 'there'],
    ['www.evil-example.com', 'there'],
    ['evil.com Jane', 'Jane'],
    ['jane@example.com', 'there'],
    ['555-555-0123', 'there'],
    ['<b>x</b>', 'there'],
    ['', 'there']
  ])('greetingName(%p) -> %p', (input, out) => {
    expect(lib.greetingName(input)).toBe(out);
  });

  test('a URL typed as the name never appears in the thank-you email', () => {
    const mail = lib.buildGuestEmail({ ...signin, name: 'https://evil.example.com/login' }, house, settings);
    expect(mail.htmlBody).toContain('Hi there,');
    expect(mail.body).toContain('Hi there,');
    expect(mail.htmlBody).not.toContain('evil.example.com');
    expect(mail.body).not.toContain('evil.example.com');
  });
});

describe('guestMailDecision', () => {
  test('sends when quota and limits allow', () => {
    expect(lib.guestMailDecision({ alreadySent: false, remainingQuota: 50, sentThisHour: 0 })).toEqual({ send: true });
  });
  test('keeps a reserve of 20 daily emails for the agent', () => {
    expect(lib.MAIL_QUOTA_RESERVE).toBe(20);
    expect(lib.guestMailDecision({ remainingQuota: 20, sentThisHour: 0 }).send).toBe(true);
    expect(lib.guestMailDecision({ remainingQuota: 19, sentThisHour: 0 })).toEqual({ send: false, reason: expect.stringMatching(/19 emails left/) });
  });
  test('caps thank-you emails at 10 per house per hour', () => {
    expect(lib.guestMailDecision({ remainingQuota: 90, sentThisHour: 9 }).send).toBe(true);
    expect(lib.guestMailDecision({ remainingQuota: 90, sentThisHour: 10 }).send).toBe(false);
  });
  test('one thank-you per guest', () => {
    expect(lib.guestMailDecision({ alreadySent: true, remainingQuota: 90, sentThisHour: 0 }).send).toBe(false);
  });
});

describe('cache keys stay under 250 characters', () => {
  test('long inputs are hashed, short ones unchanged', () => {
    expect(lib.safeCacheKey('rl:abc:1')).toBe('rl:abc:1');
    const long = lib.guestMailKey('a'.repeat(64), 'x'.repeat(190) + '@example.com');
    expect(long.length).toBeLessThanOrEqual(250);
    expect(lib.submissionKey('f'.repeat(64)).length).toBeLessThanOrEqual(250);
    expect(lib.guestHourKey('a'.repeat(64), Date.UTC(2026, 10, 28, 18)).length).toBeLessThanOrEqual(250);
    expect(lib.safeCacheKey('k'.repeat(300))).not.toBe(lib.safeCacheKey('k'.repeat(299) + 'j'));
  });
});

describe('guest email signature images', () => {
  test('embeds the logo by cid in a white cell, table layout, alt text from office_name', () => {
    const mail = lib.buildGuestEmail(signin, house, settings, { logo: true });
    expect(mail.htmlBody).toContain('<td bgcolor="#ffffff" style="background:#ffffff;');
    expect(mail.htmlBody).toMatch(/<td bgcolor="#ffffff" style="background:#ffffff;[^"]*"><img src="cid:logo" width="160" alt="Example Realty"/);
    expect(mail.htmlBody).toContain('<table role="presentation" cellpadding="0" cellspacing="0" border="0"');
    expect(mail.htmlBody).not.toMatch(/display:\s*(flex|grid)/);
    expect(mail.htmlBody).not.toMatch(/src="https?:/); // nothing hotlinked
  });

  test('only the images that loaded are referenced', () => {
    const none = lib.buildGuestEmail(signin, house, settings, {});
    expect(none.htmlBody).not.toContain('cid:');
    expect(none.htmlBody).not.toContain('<img');
  });

  test('logo alt text is escaped', () => {
    const mail = lib.buildGuestEmail(signin, house, { ...settings, office_name: '"><script>x</script>' }, { logo: true });
    expect(mail.htmlBody).not.toContain('<script>');
  });
});

describe('planEmailImages', () => {
  test('includes the https logo only', () => {
    expect(lib.planEmailImages({ logo_url: 'https://www.example.com/a.png' })).toEqual([
      { key: 'logo', cid: 'logo', url: 'https://www.example.com/a.png' }
    ]);
    expect(Object.keys(lib.EMAIL_IMAGE_CIDS)).toEqual(['logo']);
  });
  test('skips blank, http, non-URL and SVG sources', () => {
    expect(lib.planEmailImages({})).toEqual([]);
    expect(lib.planEmailImages({ logo_url: 'http://www.example.com/a.png' })).toEqual([]);
    expect(lib.planEmailImages({ logo_url: 'javascript:alert(1)' })).toEqual([]);
    expect(lib.planEmailImages({ logo_url: 'https://www.example.com/logo.SVG?v=2' })).toEqual([]);
  });
});

describe('guest email wording and signature', () => {
  const full = {
    agent_name: 'Jane Doe',
    agent_title: 'Realtor',
    office_name: 'Example Realty',
    office_address_line1: '100 Example St',
    office_address_line2: 'Anytown, VA 00000',
    agent_phone: '(555) 555-0123',
    agent_email: 'jane@example.com',
    logo_url: 'https://www.example.com/logo.png',
    website_url: ''
  };
  const textOf = (html) => html.replace(/<[^>]+>/g, '\n').split('\n').map((x) => x.trim()).filter(Boolean);

  test('greeting, then the exact first-person opening, then the details intro (HTML)', () => {
    const mail = lib.buildGuestEmail(signin, house, full);
    expect(mail.htmlBody).toMatch(/>Hi Jane,<\/p><p[^>]*>Thank you for stopping by my open house!<\/p><p[^>]*>Here are the details so you have them handy\.<\/p><div style="border-left:/);
    expect(mail.htmlBody).not.toContain('the open house at');
  });

  test('greeting, opening and details intro in the plain text', () => {
    const mail = lib.buildGuestEmail(signin, house, full);
    expect(mail.body.startsWith('Hi Jane,\n\nThank you for stopping by my open house!\n\nHere are the details so you have them handy.\n\nAddress: 12 Oak St\n')).toBe(true);
  });

  test('house details block is unchanged', () => {
    const mail = lib.buildGuestEmail(signin, house, full);
    for (const label of ['Address', 'Price', 'Beds', 'Baths', 'Square feet']) expect(mail.htmlBody).toContain('>' + label + '</td>');
    expect(mail.htmlBody).toContain('Sunny colonial.');
    expect(mail.htmlBody).toContain('View the full listing</a>');
    expect(mail.body).toContain('3 bd · 2.5 ba · 1800 sq ft');
  });

  test('signature lines are in order (HTML and text)', () => {
    const mail = lib.buildGuestEmail(signin, house, full, { logo: true });
    const sigHtml = mail.htmlBody.slice(mail.htmlBody.indexOf('margin:24px 0 0'));
    expect(textOf(sigHtml.slice(sigHtml.indexOf('>') + 1))).toEqual([
      'Jane Doe', 'Realtor | Example Realty', '100 Example St', 'Anytown, VA 00000',
      'P:', '(555) 555-0123', 'E:', 'jane@example.com'
    ]);
    expect(sigHtml.indexOf('jane@example.com')).toBeLessThan(sigHtml.indexOf('cid:logo'));
    expect(mail.body).toContain('\n\nJane Doe\nRealtor | Example Realty\n100 Example St\nAnytown, VA 00000\nP: (555) 555-0123\nE: jane@example.com');
  });

  test('name is bold serif; P: and E: are bold orange; body font is Helvetica in charcoal', () => {
    const html = lib.buildGuestEmail(signin, house, full).htmlBody;
    expect(html).toContain('<strong style="font-family:Georgia,\'Times New Roman\',serif;font-size:17px;font-weight:bold;color:#232323;">Jane Doe</strong>');
    expect(html).toContain('<strong style="color:#D9875F;font-weight:bold;">P:</strong>');
    expect(html).toContain('<strong style="color:#D9875F;font-weight:bold;">E:</strong>');
    expect(html).toMatch(/^<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;[^"]*color:#232323;/);
  });

  test('tel: link uses digits only; mailto: link for the email', () => {
    const html = lib.buildGuestEmail(signin, house, { ...full, agent_phone: '+1 (555) 555-0123' }).htmlBody;
    expect(html).toContain('<a href="tel:+15555550123" style="color:#232323;text-decoration:none;">+1 (555) 555-0123</a>');
    expect(html).toContain('<a href="mailto:jane@example.com" style="color:#232323;text-decoration:none;">jane@example.com</a>');
  });

  test.each([
    [{ agent_title: 'Realtor', office_name: 'Example Realty' }, 'Realtor | Example Realty'],
    [{ agent_title: '', office_name: 'Example Realty' }, 'Example Realty'],
    [{ agent_title: 'Realtor', office_name: '' }, 'Realtor'],
    [{ agent_title: '  ', office_name: '' }, '']
  ])('title/office line for %p is %p', (extra, line) => {
    const mail = lib.buildGuestEmail(signin, house, { ...full, ...extra });
    if (line) {
      expect(mail.body.split('\n')).toContain(line);
    } else {
      expect(mail.body).not.toContain(' | ');
      expect(mail.body).not.toMatch(/\nRealtor\n/);
    }
    expect(mail.htmlBody).not.toMatch(/>\s*\|\s|\s\|\s*</);
  });

  test('blank settings skip their lines', () => {
    const mail = lib.buildGuestEmail(signin, house, { agent_name: 'Jane Doe' });
    expect(mail.body.endsWith('just reply to this email.\n\nJane Doe')).toBe(true);
    expect(mail.htmlBody).not.toContain('P:');
    expect(mail.htmlBody).not.toContain('E:');
    expect(mail.htmlBody).not.toContain('mailto:');
    expect(mail.htmlBody).not.toContain('tel:');
    const empty = lib.buildGuestEmail(signin, house, {});
    expect(empty.htmlBody).not.toContain('margin:24px 0 0');
    expect(empty.body.endsWith('just reply to this email.')).toBe(true);
  });

  test('an invalid agent_email is treated as blank', () => {
    for (const bad of ['not-an-email', 'jane@example', 'jane doe@example.com', '"><a>@example.com']) {
      const mail = lib.buildGuestEmail(signin, house, { ...full, agent_email: bad });
      expect(mail.htmlBody).not.toContain('E:');
      expect(mail.htmlBody).not.toContain('mailto:');
      expect(mail.body).not.toContain('E: ');
    }
  });

  test('every new signature setting is HTML-escaped and kept to one line', () => {
    const mail = lib.buildGuestEmail(signin, house, {
      agent_name: XSS,
      agent_title: XSS,
      office_name: '<b>Office</b>',
      office_address_line1: XSS,
      office_address_line2: '<img src=x onerror=alert(1)>\nline',
      agent_phone: '<i>555</i>',
      agent_email: 'jane@example.com'
    }, { logo: true });
    expect(mail.htmlBody).not.toMatch(/<script|<b>Office|<img src=x|<i>555/);
    expect(mail.htmlBody).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; | &lt;b&gt;Office&lt;/b&gt;');
    expect(mail.htmlBody).toContain('&lt;img src=x onerror=alert(1)&gt; line');
    expect(mail.body).toContain('<img src=x onerror=alert(1)> line');
  });

  test('long values are capped', () => {
    const mail = lib.buildGuestEmail(signin, house, { ...full, office_address_line1: 'A'.repeat(400) });
    expect(mail.body).toContain('A'.repeat(149) + '…');
    expect(mail.body).not.toContain('A'.repeat(150));
  });

  test('no agent photo anywhere in the output (logo is the only image)', () => {
    const mail = lib.buildGuestEmail(signin, house, { ...full, ['head' + 'shot_url']: 'https://www.example.com/me.jpg' }, { logo: true, ['head' + 'shot']: true });
    expect(JSON.stringify(mail).toLowerCase()).not.toContain('head' + 'shot');
    expect(mail.htmlBody).not.toContain('me.jpg');
    expect(mail.htmlBody.match(/<img /g)).toHaveLength(1);
  });

  test('settings parsed from the Sheet give the "Realtor" default title', () => {
    const parsed = global.parseSettings([['agent_name', 'Jane Doe'], ['office_name', 'Example Realty']]);
    expect(lib.buildGuestEmail(signin, house, parsed).body).toContain('\nJane Doe\nRealtor | Example Realty');
  });
});

describe('checkImageResponse', () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].map((b) => (b > 127 ? b - 256 : b)); // signed, like Apps Script
  const JPG = [-1, -40, -1, -32, 0, 16];
  const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

  test('accepts real PNG, JPEG and GIF under 500 KB', () => {
    expect(lib.checkImageResponse(200, 'image/png', PNG)).toEqual({ ok: true, mime: 'image/png' });
    expect(lib.checkImageResponse(200, 'image/jpeg; charset=binary', JPG)).toEqual({ ok: true, mime: 'image/jpeg' });
    expect(lib.checkImageResponse(200, 'image/jpg', JPG)).toEqual({ ok: true, mime: 'image/jpeg' });
    expect(lib.checkImageResponse(200, 'IMAGE/GIF', GIF)).toEqual({ ok: true, mime: 'image/gif' });
  });

  test('rejects bad status, SVG, other types, empty, oversized and mislabeled files', () => {
    expect(lib.checkImageResponse(404, 'image/png', PNG).reason).toMatch(/HTTP 404/);
    expect(lib.checkImageResponse(200, 'image/svg+xml', [60, 115]).reason).toMatch(/SVG/);
    expect(lib.checkImageResponse(200, 'text/html', [60, 104]).ok).toBe(false);
    expect(lib.checkImageResponse(200, 'image/webp', PNG).ok).toBe(false);
    expect(lib.checkImageResponse(200, '', PNG).ok).toBe(false);
    expect(lib.checkImageResponse(200, 'image/png', []).reason).toMatch(/empty/);
    const big = PNG.concat(new Array(lib.EMAIL_IMAGE_MAX_BYTES).fill(0));
    expect(lib.checkImageResponse(200, 'image/png', big).reason).toMatch(/too large/);
    expect(lib.checkImageResponse(200, 'image/png', JPG).reason).toMatch(/not a real/);
  });

  test('exactly 500 KB is allowed', () => {
    const edge = PNG.concat(new Array(lib.EMAIL_IMAGE_MAX_BYTES - PNG.length).fill(0));
    expect(lib.checkImageResponse(200, 'image/png', edge).ok).toBe(true);
  });

  test('headerValue is case-insensitive', () => {
    expect(lib.headerValue({ 'content-type': 'image/png' }, 'Content-Type')).toBe('image/png');
    expect(lib.headerValue({ 'Content-Type': ['image/gif'] }, 'content-type')).toBe('image/gif');
    expect(lib.headerValue({}, 'Content-Type')).toBe('');
  });

  test('cache helpers', () => {
    expect(lib.imageCacheKey('https://www.example.com/a.png')).toBe('img:https://www.example.com/a.png');
    const long = lib.imageCacheKey('https://www.example.com/' + 'a'.repeat(300));
    expect(long.length).toBeLessThanOrEqual(250);
    expect(long).not.toBe(lib.imageCacheKey('https://www.example.com/' + 'a'.repeat(301)));
    expect(lib.shouldCacheImage(50000)).toBe(true);
    expect(lib.shouldCacheImage(100000)).toBe(false);
    expect(lib.shouldCacheImage(0)).toBe(false);
  });
});

describe('guest email "Learn more about me" link', () => {
  test('present in HTML and plain text when website_url is set', () => {
    const mail = lib.buildGuestEmail(signin, house, { ...settings, website_url: 'https://www.example.com/about?a=1&b=2' });
    expect(mail.htmlBody).toContain('href="https://www.example.com/about?a=1&amp;b=2"');
    expect(mail.htmlBody).toContain('Learn more about me</a>');
    expect(mail.body).toContain('Learn more about me: https://www.example.com/about?a=1&b=2');
  });

  test('absent when website_url is blank', () => {
    const mail = lib.buildGuestEmail(signin, house, { ...settings, website_url: '' });
    expect(mail.htmlBody).not.toContain('Learn more about me');
    expect(mail.body).not.toContain('Learn more about me');
  });

  test('non-http(s) website_url is rejected by the settings parser and never linked', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com', 'mailto:jane@example.com']) {
      const parsed = global.parseSettings([['website_url', bad]]);
      expect(parsed.website_url).toBe('');
      const mail = lib.buildGuestEmail(signin, house, parsed);
      expect(mail.htmlBody).not.toContain('Learn more about me');
      // Even if a raw value slipped past the parser, the builder re-checks it.
      const direct = lib.buildGuestEmail(signin, house, { ...settings, website_url: bad });
      expect(direct.htmlBody).not.toContain('Learn more about me');
      expect(direct.htmlBody).not.toContain(bad);
    }
  });
});

describe('sign-in row', () => {
  test('is formula-escaped and in header order', () => {
    const now = new Date('2026-11-28T18:00:00Z');
    const row = lib.buildSignInRow(global.SIGNIN_HEADERS, { ...signin, name: '=IMPORTXML("http://evil.example.com")', phone: '+1 555 555 0123' }, house, now);
    expect(row[0]).toBe(now);
    expect(row[1]).toBe(signin.houseId);
    expect(row[2]).toBe('12 Oak St');
    expect(row[3]).toBe('\'=IMPORTXML("http://evil.example.com")');
    expect(row[4]).toBe("'+1 555 555 0123");
    expect(row).toHaveLength(11);
  });
});

describe('misc helpers', () => {
  test('extractSheetId accepts URL or bare id', () => {
    const fakeId = 'FAKE_sheet_id_0123456789abcdef';
    expect(lib.extractSheetId('https://docs.google.com/spreadsheets/d/' + fakeId + '/edit#gid=0')).toBe(fakeId);
    expect(lib.extractSheetId(fakeId)).toBe(fakeId);
    expect(lib.extractSheetId('nope')).toBe('');
  });

  test('rate limit keys bucket by 10-minute window', () => {
    const t = Date.UTC(2026, 10, 28, 18, 0, 0);
    expect(lib.rateLimitKey('abc', t)).toBe(lib.rateLimitKey('abc', t + 599000));
    expect(lib.rateLimitKey('abc', t)).not.toBe(lib.rateLimitKey('abc', t + 600000));
  });
});
