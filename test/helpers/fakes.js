'use strict';

/* Small in-memory stand-ins for the Apps Script services the code uses. */

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.rows[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    values.forEach((line, r) => {
      const idx = this.row - 1 + r;
      while (this.sheet.rows.length <= idx) this.sheet.rows.push([]);
      line.forEach((v, c) => { this.sheet.rows[idx][this.col - 1 + c] = v; });
    });
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setFontWeight() { return this; }
  insertCheckboxes() { this.sheet.checkboxes.push([this.row, this.col]); return this; }
}

class FakeColumnRange {
  constructor(sheet, letter) { Object.assign(this, { sheet, letter }); }
  setNumberFormat(fmt) { this.sheet.columnFormats[this.letter] = fmt; return this; }
}

class FakeSheet {
  constructor(name, rows) {
    this.name = name;
    this.rows = rows || [];
    this.checkboxes = [];
    this.columnFormats = {};
    this.frozen = 0;
  }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (typeof row === 'string') {
      // Whole-column A1 notation like "C:C".
      const m = row.match(/^([A-Z]+):\1$/);
      if (!m) throw new Error('FakeSheet only supports whole-column A1 ranges, got ' + row);
      return new FakeColumnRange(this, m[1]);
    }
    return new FakeRange(this, row, col, numRows, numCols);
  }
  getDataRange() {
    return new FakeRange(this, 1, 1, Math.max(this.rows.length, 1), Math.max(this.getLastColumn(), 1));
  }
  appendRow(row) { this.rows.push(row.slice()); return this; }
  setFrozenRows(n) { this.frozen = n; }
}

class FakeSpreadsheet {
  constructor(sheets) {
    this.sheets = {};
    Object.entries(sheets || {}).forEach(([name, rows]) => { this.sheets[name] = new FakeSheet(name, rows); });
  }
  getName() { return 'Fake Sheet'; }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) { this.sheets[name] = new FakeSheet(name, []); return this.sheets[name]; }
}

/* Enforces the real CacheService limits: keys <= 250 chars, values <= 100 KB. */
function fakeCache() {
  const store = new Map();
  const checkKey = (k) => {
    if (String(k).length > 250) throw new Error('Cache key too long (' + String(k).length + ' > 250)');
  };
  return {
    store,
    get: (k) => { checkKey(k); return store.has(k) ? store.get(k) : null; },
    put: (k, v) => {
      checkKey(k);
      if (String(v).length > 100 * 1024) throw new Error('Argument too large: value');
      store.set(k, String(v));
    }
  };
}

/** Installs mocks on global and returns handles for assertions. */
function installGasMocks(ss, opts = {}) {
  const cache = fakeCache();
  const sent = [];
  const fetches = [];
  const props = { SHEET_ID: 'fake-sheet-id', ...(opts.props || {}) };
  global.SpreadsheetApp = {
    openById: () => ss,
    getActiveSpreadsheet: () => ss,
    flush: () => {}
  };
  global.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = v; }
    })
  };
  global.CacheService = { getScriptCache: () => cache };
  // opts.lockOk = false makes tryLock fail (as when another sign-in holds the lock).
  global.LockService = { getScriptLock: () => ({ tryLock: () => opts.lockOk !== false, releaseLock: () => {} }) };
  global.MailApp = {
    sendEmail: (arg) => {
      if (opts.mailThrows) throw new Error('Mail quota exceeded');
      sent.push(arg);
    },
    getRemainingDailyQuota: () => (opts.mailQuota === undefined ? 100 : opts.mailQuota)
  };
  const respond = (url) => {
    const r = (opts.responses && opts.responses[url]) || { code: 200, headers: {}, bytes: [] };
    return {
      getResponseCode: () => r.code,
      getHeaders: () => r.headers,
      getContent: () => r.bytes
    };
  };
  // Only fetchAll: the email-image loader is the sole UrlFetchApp user.
  global.UrlFetchApp = {
    fetchAll: (requests) => {
      if (opts.fetchThrows) throw new Error('DNS error');
      return requests.map((req) => {
        fetches.push({ url: req.url, params: req });
        return respond(req.url);
      });
    }
  };
  global.Session = {
    getEffectiveUser: () => ({ getEmail: () => 'agent@example.com' }),
    getScriptTimeZone: () => 'America/New_York'
  };
  global.Utilities = {
    formatDate: () => {
      if (opts.formatDateThrows) throw new Error('bad time zone');
      return 'Sat, Nov 28, 2026 at 1:00 PM';
    },
    getUuid: () => '123e4567-e89b-42d3-a456-426614174000',
    base64Encode: (bytes) => Buffer.from(bytes.map((b) => b & 0xff)).toString('base64'),
    base64Decode: (s) => [...Buffer.from(s, 'base64')].map((b) => (b > 127 ? b - 256 : b)),
    newBlob: (bytes, mime, name) => ({ bytes, mime, name })
  };
  global.ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (text) => ({ text, setMimeType() { return this; } })
  };
  global.console.error = jest.fn();
  global.console.log = jest.fn();
  return { cache, sent, fetches, props };
}

module.exports = { FakeSheet, FakeSpreadsheet, installGasMocks };
