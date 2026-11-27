'use strict';

const core = require('../shared/sheet-core.js');
const { FakeSpreadsheet } = require('./helpers/fakes.js');

describe('escapeFormula (spreadsheet formula injection)', () => {
  test.each([
    ['=HYPERLINK("http://evil.example.com","x")', '\'=HYPERLINK("http://evil.example.com","x")'],
    ['+1 555 555 0100', "'+1 555 555 0100"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\t=1', "'\t=1"],
    ['\r=1', "'\r=1"]
  ])('prefixes %p', (input, expected) => {
    expect(core.escapeFormula(input)).toBe(expected);
  });

  test('leaves safe values and non-strings alone', () => {
    expect(core.escapeFormula('Jane Doe')).toBe('Jane Doe');
    expect(core.escapeFormula('a=b')).toBe('a=b');
    expect(core.escapeFormula(42)).toBe(42);
    const d = new Date();
    expect(core.escapeFormula(d)).toBe(d);
  });
});

describe('settings', () => {
  test('settings keys are exactly the agreed list', () => {
    expect(core.SETTINGS_DEFAULTS.map((d) => d.key)).toEqual([
      'website_url', 'guest_form_url', 'agent_name', 'agent_title', 'agent_phone', 'agent_email', 'office_name',
      'office_address_line1', 'office_address_line2', 'logo_url', 'qr_logo_url', 'print_logo_url', 'notify_email'
    ]);
  });

  test('every default is blank except agent_title ("Realtor"), and each has a plain-English note', () => {
    for (const d of core.SETTINGS_DEFAULTS) {
      expect(d.note.length).toBeGreaterThan(20);
      expect(d.value).toBe(d.key === 'agent_title' ? 'Realtor' : '');
    }
    expect(core.parseSettings([]).agent_title).toBe('Realtor');
    expect(core.parseSettings([['agent_title', '']]).agent_title).toBe('');
  });

  test('an unknown or retired key (e.g. an old row) does not break parseSettings', () => {
    const s = core.parseSettings([
      ['key', 'value', 'what this is'],
      ['old_photo_url', 'https://www.example.com/old.jpg', 'retired'],
      ['agent_name', 'Jane Doe', '']
    ]);
    expect(s.agent_name).toBe('Jane Doe');
    expect(s.agent_email).toBe('');
    expect(s.office_address_line1).toBe('');
  });

  test('parseSettings reads key/value rows, trims, and fills defaults', () => {
    const s = core.parseSettings([
      ['key', 'value', 'what this is'],
      [' Website_URL ', ' https://www.example.com ', 'note'],
      ['agent_phone', 5550100, ''],
      ['', 'ignored', '']
    ]);
    expect(s.website_url).toBe('https://www.example.com');
    expect(s.agent_phone).toBe('5550100');
    expect(s.office_name).toBe('');
    expect(s.notify_email).toBe('');
  });

  test('parseSettings keeps only http(s) links for the URL settings', () => {
    const s = core.parseSettings([
      ['website_url', 'javascript:alert(1)'],
      ['logo_url', 'www.example.com/logo.png']
    ]);
    expect(core.URL_SETTING_KEYS).toEqual(['website_url', 'logo_url', 'qr_logo_url', 'print_logo_url']);
    expect(s.website_url).toBe('');
    expect(s.logo_url).toBe('https://www.example.com/logo.png');
  });

  test('blank image settings default to files on the guest form site', () => {
    const s = core.parseSettings([['guest_form_url', 'https://example.github.io/open-house-signin/']]);
    expect(s.logo_url).toBe('https://example.github.io/open-house-signin/assets/logo.png');
    expect(s.qr_logo_url).toBe('https://example.github.io/open-house-signin/assets/balloon.svg');
    expect(s.print_logo_url).toBe('https://example.github.io/open-house-signin/assets/logo.svg');
  });

  test('a filled-in image setting overrides the default', () => {
    const s = core.parseSettings([
      ['guest_form_url', 'https://example.github.io/oh/'],
      ['logo_url', 'https://cdn.example.com/brand.png']
    ]);
    expect(s.logo_url).toBe('https://cdn.example.com/brand.png');
    expect(s.qr_logo_url).toBe('https://example.github.io/oh/assets/balloon.svg');
  });

  test('no guest_form_url (or a non-https one) means no image defaults', () => {
    expect(core.parseSettings([]).logo_url).toBe('');
    expect(core.parseSettings([['guest_form_url', 'http://example.com/']]).qr_logo_url).toBe('');
    expect(core.parseSettings([['guest_form_url', 'javascript:alert(1)']]).print_logo_url).toBe('');
  });

  test.each([
    ['https://example.github.io/oh/', 'https://example.github.io/oh/'],
    ['https://example.github.io/oh', 'https://example.github.io/oh/'],
    ['https://example.github.io/oh/?h=abc#top', 'https://example.github.io/oh/'],
    ['https://example.github.io/oh/index.html', 'https://example.github.io/oh/'],
    ['https://www.example.com', 'https://www.example.com/'],
    ['example.github.io/oh/', 'https://example.github.io/oh/'],
    ['', ''],
    ['http://example.github.io/oh/', '']
  ])('siteBaseUrl(%p) -> %p', (input, out) => {
    expect(core.siteBaseUrl(input)).toBe(out);
  });

  test('parseSettings(null) gives defaults', () => {
    expect(core.parseSettings(null).guest_form_url).toBe('');
  });
});

describe('rows and objects', () => {
  test('rowsToObjects maps by header and skips blank rows', () => {
    const out = core.rowsToObjects([
      ['ID', 'Address'],
      ['abc', '12 Oak St'],
      ['', ''],
      ['def', '9 Elm Ave']
    ]);
    expect(out).toEqual([{ id: 'abc', address: '12 Oak St' }, { id: 'def', address: '9 Elm Ave' }]);
  });

  test('objectToRow follows the header order', () => {
    expect(core.objectToRow(['b', 'a', 'c'], { a: 1, b: 2 })).toEqual([2, 1, '']);
  });

  test('isActiveValue', () => {
    expect(core.isActiveValue(true)).toBe(true);
    expect(core.isActiveValue('')).toBe(true);
    expect(core.isActiveValue(false)).toBe(false);
    expect(core.isActiveValue('FALSE')).toBe(false);
    expect(core.isActiveValue('no')).toBe(false);
  });
});

describe('normalizeUrl', () => {
  test.each([
    ['https://www.example.com/x?y=1', 'https://www.example.com/x?y=1'],
    ['http://example.com', 'http://example.com'],
    ['example.com/listing', 'https://example.com/listing'],
    ['  www.example.com  ', 'https://www.example.com']
  ])('accepts %p', (input, out) => expect(core.normalizeUrl(input)).toBe(out));

  test.each(['', 'javascript:alert(1)', 'data:text/html,hi', 'not a url', 'https://exa mple.com', 'https://example.com/"onload=', 'ftp://example.com', 'https://localhost'])(
    'rejects %p', (input) => expect(core.normalizeUrl(input)).toBe('')
  );
});

describe('formatPrice', () => {
  test('formats plain numbers and leaves text alone', () => {
    expect(core.formatPrice(450000)).toBe('$450,000');
    expect(core.formatPrice('$1,250,000')).toBe('$1,250,000');
    expect(core.formatPrice('Call for price')).toBe('Call for price');
    expect(core.formatPrice('')).toBe('');
  });
});

describe('ensureTabs', () => {
  test('creates all three tabs with headers and default settings', () => {
    const ss = new FakeSpreadsheet();
    const report = core.ensureTabs(ss);
    expect(ss.getSheetByName('Houses').rows[0]).toEqual(core.HOUSE_HEADERS);
    expect(ss.getSheetByName('SignIns').rows[0]).toEqual(core.SIGNIN_HEADERS);
    const settings = ss.getSheetByName('Settings').rows;
    expect(settings[0]).toEqual(core.SETTINGS_HEADERS);
    expect(settings.slice(1).map((r) => r[0])).toEqual(core.SETTINGS_DEFAULTS.map((d) => d.key));
    expect(report.join(' ')).toMatch(/Created the "Houses" tab/);
  });

  test('sets the id column and SignIns text columns to plain text (whole columns)', () => {
    const ss = new FakeSpreadsheet();
    core.ensureTabs(ss);
    expect(ss.getSheetByName('Houses').columnFormats).toEqual({ A: '@' });
    const signins = ss.getSheetByName('SignIns').columnFormats;
    // timestamp (A) stays a date; B..K (house id .. comments) are text.
    expect(Object.keys(signins).sort()).toEqual(['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']);
    expect(Object.values(signins).every((f) => f === '@')).toBe(true);
    expect(ss.getSheetByName('Settings').columnFormats).toEqual({});
  });

  test('text formats follow the header names when columns were moved', () => {
    const ss = new FakeSpreadsheet({ SignIns: [['phone', 'timestamp', 'name']] });
    core.ensureTabs(ss);
    expect(ss.getSheetByName('SignIns').columnFormats).toEqual({ A: '@', C: '@' });
  });

  test('columnLetter', () => {
    expect(core.columnLetter(1)).toBe('A');
    expect(core.columnLetter(26)).toBe('Z');
    expect(core.columnLetter(27)).toBe('AA');
  });

  test('is safe to run twice and never overwrites values', () => {
    const ss = new FakeSpreadsheet();
    core.ensureTabs(ss);
    ss.getSheetByName('Settings').rows[1][1] = 'https://www.example.com';
    const report = core.ensureTabs(ss);
    expect(ss.getSheetByName('Settings').rows[1][1]).toBe('https://www.example.com');
    expect(ss.getSheetByName('Settings').rows.length).toBe(core.SETTINGS_DEFAULTS.length + 1);
    expect(report.join(' ')).toMatch(/looks good/);
  });

  test('adds new settings keys and warns about missing columns', () => {
    const ss = new FakeSpreadsheet({
      Houses: [['id', 'address']],
      Settings: [['key', 'value', 'what this is'], ['website_url', 'https://www.example.com', '']]
    });
    const report = core.ensureTabs(ss).join(' ');
    expect(report).toMatch(/WARNING: the "Houses" tab is missing/);
    expect(report).toMatch(/Added settings: guest_form_url/);
  });

  test('appends new signature keys to an existing Settings tab without touching existing rows', () => {
    const existing = [
      ['key', 'value', 'what this is'],
      ['website_url', 'https://www.example.com', 'note'],
      ['agent_name', 'Jane Doe', 'note'],
      ['agent_phone', '555-555-0123', 'note'],
      ['office_name', 'Example Realty', 'note'],
      ['old_photo_url', 'https://www.example.com/old.jpg', 'retired setting']
    ];
    const ss = new FakeSpreadsheet({ Settings: existing.map((r) => r.slice()) });
    const report = core.ensureTabs(ss).join(' ');
    const rows = ss.getSheetByName('Settings').rows;
    expect(rows.slice(0, existing.length)).toEqual(existing);
    const added = rows.slice(existing.length);
    expect(added.map((r) => r[0])).toEqual(expect.arrayContaining(['agent_title', 'agent_email', 'office_address_line1', 'office_address_line2']));
    expect(added.find((r) => r[0] === 'agent_title')[1]).toBe('Realtor');
    expect(added.find((r) => r[0] === 'agent_email')[1]).toBe('');
    expect(added.map((r) => r[0])).not.toContain('agent_name');
    expect(report).toMatch(/Added settings: .*agent_title/);
    const s = core.parseSettings(rows);
    expect(s.agent_name).toBe('Jane Doe');
    expect(s.agent_title).toBe('Realtor');
  });
});
