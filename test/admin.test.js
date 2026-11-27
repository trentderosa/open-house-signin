'use strict';

const { loadGas } = require('./helpers/load.js');
const { FakeSpreadsheet, installGasMocks } = require('./helpers/fakes.js');

const gas = loadGas([
  'apps-script/admin/sheet-core.js',
  'apps-script/admin/AdminLib.js',
  'apps-script/admin/Code.js'
]);

describe('makeHouseId', () => {
  test('makes 20 lowercase hex chars from a UUID, skipping fixed version/variant chars', () => {
    const id = gas.makeHouseId('123E4567-E89B-42D3-A456-426614174000');
    expect(id).toMatch(/^[0-9a-f]{20}$/);
    expect(id).toBe('b23e4567e89b2d345642'); // leading digit 1 -> letter
  });

  test('always starts with a letter a-f so Sheets never reads it as a number', () => {
    const { randomUUID } = require('crypto');
    for (let d = 0; d < 16; d++) {
      const hex = d.toString(16);
      const id = gas.makeHouseId(hex + '23e4567-e89b-42d3-a456-426614174000');
      expect(id).toMatch(/^[a-f][0-9a-f]{19}$/);
    }
    for (let i = 0; i < 500; i++) expect(gas.makeHouseId(randomUUID())).toMatch(/^[a-f]/);
  });

  test('ids from random UUIDs are unique and pass the endpoint id check', () => {
    const { randomUUID } = require('crypto');
    const { isValidHouseId } = require('../shared/signin-rules.js');
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const id = gas.makeHouseId(randomUUID());
      expect(isValidHouseId(id)).toBe(true);
      seen.add(id);
    }
    expect(seen.size).toBe(2000);
  });

  test('refuses non-UUID input', () => {
    expect(() => gas.makeHouseId('1')).toThrow();
  });
});

describe('validateHouseInput', () => {
  test('requires an address', () => {
    expect(gas.validateHouseInput({ address: '  ' }).ok).toBe(false);
  });
  test('normalises the listing link and rejects junk', () => {
    expect(gas.validateHouseInput({ address: '12 Oak St', listing_url: 'example.com/x' }).value.listing_url).toBe('https://example.com/x');
    expect(gas.validateHouseInput({ address: '12 Oak St', listing_url: 'javascript:alert(1)' }).ok).toBe(false);
  });
  test('enforces length caps', () => {
    expect(gas.validateHouseInput({ address: 'x'.repeat(201) }).ok).toBe(false);
    expect(gas.validateHouseInput({ address: '12 Oak St', description: 'x'.repeat(1001) }).ok).toBe(false);
  });
});

describe('buildGuestUrl', () => {
  test('appends ?h=<id>', () => {
    expect(gas.buildGuestUrl('https://example.github.io/open-house/', 'abc')).toEqual({ ok: true, url: 'https://example.github.io/open-house/?h=abc' });
    expect(gas.buildGuestUrl('https://www.example.com/?src=qr', 'abc').url).toBe('https://www.example.com/?src=qr&h=abc');
  });
  test('blank or insecure setting gives a clear message instead of a broken QR', () => {
    expect(gas.buildGuestUrl('', 'abc')).toEqual({ ok: false, error: expect.stringMatching(/guest_form_url setting is blank/) });
    expect(gas.buildGuestUrl('http://example.com', 'abc').ok).toBe(false);
    expect(gas.buildGuestUrl('javascript:alert(1)', 'abc').ok).toBe(false);
  });
});

describe('housesForAdmin', () => {
  test('newest first, ISO dates, guest links', () => {
    const list = gas.housesForAdmin([
      { id: 'aaa', created_at: new Date('2026-01-01'), active: true, address: 'Old' },
      { id: 'bbb', created_at: new Date('2026-06-01'), active: 'FALSE', address: 'New', price: 300000 }
    ], 'https://example.github.io/oh/');
    expect(list.map((h) => h.address)).toEqual(['New', 'Old']);
    expect(list[0].createdAt).toBe('2026-06-01T00:00:00.000Z');
    expect(list[0].active).toBe(false);
    expect(list[0].price).toBe('$300,000');
    expect(list[0].guestUrl).toBe('https://example.github.io/oh/?h=bbb');
  });
  test('no guest links when the setting is blank', () => {
    expect(gas.housesForAdmin([{ id: 'aaa', address: 'x' }], '')[0].guestUrl).toBe('');
  });
});

describe('admin server functions', () => {
  test('addHouse saves an escaped row with a random id and a checkbox', () => {
    const ss = new FakeSpreadsheet();
    installGasMocks(ss);
    gas.setup();
    ss.getSheetByName('Settings').rows.find((r) => r[0] === 'guest_form_url')[1] = 'https://example.github.io/oh/';
    const res = gas.addHouse({ address: '=12 Oak St', price: '450000', beds: '3' });
    const rows = ss.getSheetByName('Houses').rows;
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toMatch(/^[0-9a-f]{20}$/);
    expect(rows[1][2]).toBe(true);
    expect(rows[1][3]).toBe("'=12 Oak St");
    expect(ss.getSheetByName('Houses').checkboxes).toEqual([[2, 3]]);
    expect(res.house.guestUrl).toBe('https://example.github.io/oh/?h=' + rows[1][0]);
    expect(res.settings.guestFormReady).toBe(true);
  });

  test('addHouse rejects missing address', () => {
    installGasMocks(new FakeSpreadsheet());
    expect(() => gas.addHouse({ address: '' })).toThrow(/address/);
  });

  test('getAdminData flags a blank guest_form_url', () => {
    installGasMocks(new FakeSpreadsheet());
    const data = gas.getAdminData();
    expect(data.settings.guestFormReady).toBe(false);
    expect(data.settings.guestFormError).toMatch(/guest_form_url/);
    expect(data.houses).toEqual([]);
  });
});
