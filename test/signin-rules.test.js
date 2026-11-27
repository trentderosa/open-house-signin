'use strict';

const {
  CHOICES, FIELD_LIMITS, validateSignIn, isHoneypotFilled, isValidHouseId
} = require('../shared/signin-rules.js');

const HOUSE = 'a1b2c3d4e5f6a7b8c9d0';

function good(overrides) {
  return {
    h: HOUSE,
    name: 'Jane Doe',
    phone: '(555) 555-0123',
    email: 'jane@example.com',
    agent: 'No',
    timeline: CHOICES.timeline[0],
    preapproved: 'Yes',
    heard_from: 'Signs',
    comments: 'Loved the kitchen.',
    ...overrides
  };
}

describe('validateSignIn', () => {
  test('accepts a complete, valid sign-in and trims values', () => {
    const r = validateSignIn(good({ name: '  Jane   Doe ' }));
    expect(r.ok).toBe(true);
    expect(r.value.name).toBe('Jane Doe');
    expect(r.value.houseId).toBe(HOUSE);
  });

  test('only name, phone and email are required', () => {
    const r = validateSignIn({ h: HOUSE, name: 'Jane Doe', phone: '555-555-0100', email: 'jane@example.com' });
    expect(r.ok).toBe(true);
    expect(r.value.agent).toBe('');
    expect(r.value.comments).toBe('');
  });

  test.each(['name', 'phone', 'email'])('rejects missing %s', (field) => {
    const r = validateSignIn(good({ [field]: '   ' }));
    expect(r.ok).toBe(false);
    expect(r.fields[field]).toMatch(/please enter/i);
  });

  test.each(['jane', 'jane@', '@example.com', 'jane@example', 'jane doe@example.com', 'jane@exa mple.com', '<a>@example.com'])(
    'rejects bad email %p', (email) => {
      const r = validateSignIn(good({ email }));
      expect(r.ok).toBe(false);
      expect(r.fields.email).toBeDefined();
    }
  );

  test.each(['555-0123', '12345', 'call me', '555 555 012'])('rejects phone with fewer than 10 digits %p', (phone) => {
    const r = validateSignIn(good({ phone }));
    expect(r.ok).toBe(false);
    expect(r.fields.phone).toMatch(/full phone number/i);
  });

  test('accepts phone with 10+ digits in any format', () => {
    expect(validateSignIn(good({ phone: '555.555.0199' })).ok).toBe(true);
    expect(validateSignIn(good({ phone: '+1 555 555 0199' })).ok).toBe(true);
  });

  test.each(['agent', 'timeline', 'preapproved', 'heard_from'])('rejects a %s value that is not an allowed choice', (field) => {
    const r = validateSignIn(good({ [field]: 'Maybe; DROP TABLE' }));
    expect(r.ok).toBe(false);
    expect(r.fields[field]).toMatch(/pick one/i);
  });

  test('accepts every allowed choice', () => {
    for (const [field, list] of Object.entries(CHOICES)) {
      for (const v of list) expect(validateSignIn(good({ [field]: v })).ok).toBe(true);
    }
  });

  test('enforces length caps: comments 1000, others 200', () => {
    expect(FIELD_LIMITS.comments).toBe(1000);
    expect(validateSignIn(good({ comments: 'x'.repeat(1000) })).ok).toBe(true);
    expect(validateSignIn(good({ comments: 'x'.repeat(1001) })).fields.comments).toMatch(/too long/);
    expect(validateSignIn(good({ name: 'x'.repeat(201) })).fields.name).toMatch(/too long/);
    expect(validateSignIn(good({ phone: '5'.repeat(201) })).fields.phone).toMatch(/too long/);
    expect(validateSignIn(good({ email: 'a'.repeat(190) + '@example.com' })).fields.email).toMatch(/too long/);
    for (const k of ['name', 'phone', 'email', 'agent', 'timeline', 'preapproved', 'heard_from']) {
      expect(FIELD_LIMITS[k]).toBe(200);
    }
  });

  test('rejects non-string field types', () => {
    expect(validateSignIn(good({ name: { first: 'Jane' } })).ok).toBe(false);
    expect(validateSignIn(good({ comments: ['a'] })).ok).toBe(false);
  });

  test('rejects missing or malformed house id', () => {
    expect(validateSignIn(good({ h: '' })).fields.h).toBeDefined();
    expect(validateSignIn(good({ h: '1' })).fields.h).toBeDefined();
    expect(validateSignIn(good({ h: '../../etc' })).fields.h).toBeDefined();
  });

  test('rejects non-object bodies', () => {
    expect(validateSignIn(null).ok).toBe(false);
    expect(validateSignIn('hello').ok).toBe(false);
    expect(validateSignIn([1, 2]).ok).toBe(false);
  });
});

describe('submission id', () => {
  test('a valid hex sid is kept, anything else is dropped', () => {
    expect(validateSignIn(good({ sid: 'ab12'.repeat(8) })).value.sid).toBe('ab12'.repeat(8));
    expect(validateSignIn(good({ sid: 'not-hex!' })).value.sid).toBe('');
    expect(validateSignIn(good({})).value.sid).toBe('');
  });
});

describe('honeypot', () => {
  test('the field is named hp_contact_ref', () => {
    expect(require('../shared/signin-rules.js').HONEYPOT_FIELD).toBe('hp_contact_ref');
  });

  test('empty or missing honeypot is not spam', () => {
    expect(isHoneypotFilled({})).toBe(false);
    expect(isHoneypotFilled({ hp_contact_ref: '' })).toBe(false);
    expect(isHoneypotFilled({ hp_contact_ref: '   ' })).toBe(false);
  });
  test('filled honeypot is spam', () => {
    expect(isHoneypotFilled({ hp_contact_ref: 'http://spam.example.com' })).toBe(true);
  });
});

describe('isValidHouseId', () => {
  test('accepts random hex ids and rejects others', () => {
    expect(isValidHouseId(HOUSE)).toBe(true);
    expect(isValidHouseId('ABCDEF0123456789')).toBe(false);
    expect(isValidHouseId('123')).toBe(false);
    expect(isValidHouseId(42)).toBe(false);
  });
});
