/*
 * Spreadsheet layout, Settings parsing, and small helpers shared by both Apps
 * Script projects (admin + endpoint).
 *
 * SOURCE OF TRUTH: shared/sheet-core.js
 * Copies live in apps-script/admin/ and apps-script/endpoint/. Edit the
 * shared/ file, then run `npm run sync`. A test fails if the copies drift.
 *
 * Plain script (no import/export) so it runs in Apps Script's V8 runtime and
 * under Jest.
 */

var TAB_HOUSES = 'Houses';
var TAB_SIGNINS = 'SignIns';
var TAB_SETTINGS = 'Settings';

var HOUSE_HEADERS = [
  'id', 'created_at', 'active', 'address', 'price', 'beds', 'baths', 'sqft',
  'description', 'listing_url'
];

var SIGNIN_HEADERS = [
  'timestamp', 'house_id', 'house_address', 'name', 'phone', 'email', 'agent',
  'timeline', 'preapproved', 'heard_from', 'comments'
];

var SETTINGS_HEADERS = ['key', 'value', 'what this is'];

/**
 * Columns stored as plain text ("@" number format) so Sheets never turns a
 * phone number into a number, an id into scientific notation, or an answer
 * like "3-6 months" into a date. Set on the whole column, so rows added later
 * by appendRow stay text too.
 */
var TEXT_COLUMNS = {
  Houses: ['id'],
  SignIns: ['house_id', 'house_address', 'name', 'phone', 'email', 'agent', 'timeline', 'preapproved', 'heard_from', 'comments']
};

/** Settings that are links guests see or are sent to. parseSettings keeps only http(s). */
var URL_SETTING_KEYS = ['website_url', 'logo_url', 'headshot_url', 'qr_logo_url', 'print_logo_url'];

/**
 * Image settings that, when blank, default to a file in web/assets/ on the
 * guest form site (guest_form_url). So setup only needs that one URL.
 */
var ASSET_DEFAULTS = {
  logo_url: 'assets/logo.png',        // email signature (PNG: email apps don't show SVG)
  headshot_url: 'assets/headshot.jpg',// email signature photo
  qr_logo_url: 'assets/balloon.svg',  // center of the printed QR code
  print_logo_url: 'assets/logo.svg'   // under the printed QR code
};

/** Every setting, its starting value, and a plain-English note for the Sheet. */
var SETTINGS_DEFAULTS = [
  {
    key: 'website_url',
    value: '',
    note: 'Your website. After a guest signs in, their phone goes here. Leave blank to show a simple thank-you screen instead.'
  },
  {
    key: 'guest_form_url',
    value: '',
    note: 'The address of the guest sign-in page (the GitHub Pages link). The QR codes point here. Must start with https://'
  },
  {
    key: 'agent_name',
    value: '',
    note: 'Your name, as guests should see it in the thank-you email.'
  },
  {
    key: 'agent_phone',
    value: '',
    note: 'Your phone number for the thank-you email signature.'
  },
  {
    key: 'office_name',
    value: '',
    note: 'Your office name, shown in the thank-you email signature.'
  },
  {
    key: 'logo_url',
    value: '',
    note: 'Logo for the thank-you email (must be a PNG or JPG). Leave blank to use logo.png from the guest sign-in site.'
  },
  {
    key: 'headshot_url',
    value: '',
    note: 'Web address of your headshot photo (a square JPG or PNG). Shown as a small circle in the thank-you email. Leave blank to use headshot.jpg from the guest sign-in site.'
  },
  {
    key: 'qr_logo_url',
    value: '',
    note: 'Image in the center of printed QR codes. Leave blank to use balloon.svg from the guest sign-in site.'
  },
  {
    key: 'print_logo_url',
    value: '',
    note: 'Logo printed under the QR code. Leave blank to use logo.svg from the guest sign-in site.'
  },
  {
    key: 'notify_email',
    value: '',
    note: 'Where sign-in emails go. Leave blank to use this Google account\u2019s Gmail. Separate several addresses with commas.'
  }
];

/**
 * Stops spreadsheet formula injection: a cell starting with = + - @ (or a tab
 * or carriage return) would be treated as a formula, so prefix it with an
 * apostrophe, which Sheets hides and stores as plain text.
 */
function escapeFormula(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

/** Turns [[header...], [row...], ...] into [{header: value}, ...]. */
function rowsToObjects(values) {
  if (!values || values.length < 1) return [];
  var headers = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var empty = true;
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      var cell = row[c] === undefined ? '' : row[c];
      if (cell !== '' && cell !== null) empty = false;
      obj[headers[c]] = cell;
    }
    if (!empty) out.push(obj);
  }
  return out;
}

/** Lines an object up with a header row, for appendRow. Missing keys are ''. */
function objectToRow(headers, obj) {
  return headers.map(function (h) {
    var key = String(h).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : '';
  });
}

/** Reads the Settings tab rows into { key: 'value' }, with defaults filled in. */
function parseSettings(values) {
  var settings = {};
  SETTINGS_DEFAULTS.forEach(function (d) { settings[d.key] = d.value; });
  if (!values) return settings;
  for (var r = 0; r < values.length; r++) {
    var key = String(values[r][0] === undefined || values[r][0] === null ? '' : values[r][0]).trim().toLowerCase();
    if (!key || key === 'key') continue;
    var raw = values[r][1];
    settings[key] = raw === undefined || raw === null ? '' : String(raw).trim();
  }
  // Links shown to guests: only http(s). Anything else (javascript:, typos) becomes ''.
  URL_SETTING_KEYS.forEach(function (k) { settings[k] = normalizeUrl(settings[k]); });
  return applyAssetDefaults(settings);
}

/**
 * The folder of the guest form site, with a trailing slash, or '' if
 * guest_form_url isn't a usable https URL.
 *   https://x.github.io/repo            -> https://x.github.io/repo/
 *   https://x.github.io/repo/?a=1#b     -> https://x.github.io/repo/
 *   https://x.github.io/repo/index.html -> https://x.github.io/repo/
 */
function siteBaseUrl(guestFormUrl) {
  var url = normalizeUrl(guestFormUrl);
  if (!/^https:\/\//i.test(url)) return '';
  url = url.replace(/[?#].*$/, '');
  var m = url.match(/^(https:\/\/[^/]+)(\/.*)?$/i);
  if (!m) return '';
  var path = m[2] || '/';
  if (!/\/$/.test(path)) {
    var last = path.slice(path.lastIndexOf('/') + 1);
    path = last.indexOf('.') !== -1 ? path.slice(0, path.lastIndexOf('/') + 1) : path + '/';
  }
  return m[1] + path;
}

/** Fills blank image settings with the matching file on the guest form site. */
function applyAssetDefaults(settings) {
  var base = siteBaseUrl(settings.guest_form_url);
  Object.keys(ASSET_DEFAULTS).forEach(function (k) {
    if (!settings[k]) settings[k] = base ? base + ASSET_DEFAULTS[k] : '';
  });
  return settings;
}

function readSettings(ss) {
  var sheet = ss.getSheetByName(TAB_SETTINGS);
  if (!sheet) return parseSettings(null);
  return parseSettings(sheet.getDataRange().getValues());
}

/** A cell counts as "active" unless it clearly says no. Blank = active. */
function isActiveValue(v) {
  if (v === false) return false;
  var s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  return !(s === 'false' || s === 'no' || s === 'n' || s === '0' || s === 'inactive');
}

/**
 * Returns a safe http(s) URL or ''. Adds https:// to bare domains like
 * "example.com/listing". Rejects javascript:, data:, spaces, quotes, etc.
 */
function normalizeUrl(v) {
  var s = String(v === undefined || v === null ? '' : v).trim();
  if (!s || /[\s"'<>`\\]/.test(s)) return '';
  if (/^https?:\/\/[^/?#]+\.[^/?#]+/i.test(s)) return s;
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(?::\d+)?([/?#].*)?$/i.test(s)) {
    return 'https://' + s;
  }
  return '';
}

/** "450000" or 450000 -> "$450,000". Anything else is returned as typed. */
function formatPrice(v) {
  if (v === undefined || v === null) return '';
  var s = String(v).trim();
  if (!s) return '';
  var plain = s.replace(/[$,\s]/g, '');
  if (/^\d+(\.\d{1,2})?$/.test(plain)) {
    var n = Math.round(Number(plain));
    return '$' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  return s;
}

/** 1 -> "A", 27 -> "AA". */
function columnLetter(n) {
  var s = '';
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Creates any missing tabs (with header rows) and any missing Settings keys,
 * and sets the text-only columns to plain text. Never overwrites values. Returns a list of plain-English notes.
 */
function ensureTabs(ss) {
  var report = [];

  function ensureSheet(name, headers) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sheet.setFrozenRows(1);
      report.push('Created the "' + name + '" tab.');
      return sheet;
    }
    var width = Math.max(sheet.getLastColumn(), 1);
    var existing = sheet.getRange(1, 1, 1, width).getValues()[0]
      .map(function (h) { return String(h).trim().toLowerCase(); });
    var isBlank = existing.every(function (h) { return h === ''; });
    if (isBlank) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sheet.setFrozenRows(1);
      report.push('Added column headers to the "' + name + '" tab.');
      return sheet;
    }
    var missing = headers.filter(function (h) { return existing.indexOf(h) === -1; });
    if (missing.length) {
      report.push('WARNING: the "' + name + '" tab is missing these column headers in row 1: ' + missing.join(', ') + '.');
    } else {
      report.push('The "' + name + '" tab looks good.');
    }
    return sheet;
  }

  function setTextColumns(sheet, names) {
    var width = Math.max(sheet.getLastColumn(), 1);
    var headers = sheet.getRange(1, 1, 1, width).getValues()[0]
      .map(function (h) { return String(h).trim().toLowerCase(); });
    names.forEach(function (name) {
      var col = headers.indexOf(name) + 1;
      if (col > 0) {
        var letter = columnLetter(col);
        sheet.getRange(letter + ':' + letter).setNumberFormat('@');
      }
    });
  }

  setTextColumns(ensureSheet(TAB_HOUSES, HOUSE_HEADERS), TEXT_COLUMNS.Houses);
  setTextColumns(ensureSheet(TAB_SIGNINS, SIGNIN_HEADERS), TEXT_COLUMNS.SignIns);
  var settingsSheet = ensureSheet(TAB_SETTINGS, SETTINGS_HEADERS);

  var current = settingsSheet.getDataRange().getValues();
  var have = current.map(function (row) { return String(row[0]).trim().toLowerCase(); });
  var added = [];
  SETTINGS_DEFAULTS.forEach(function (d) {
    if (have.indexOf(d.key) === -1) {
      settingsSheet.appendRow([d.key, d.value, d.note]);
      added.push(d.key);
    }
  });
  if (added.length) report.push('Added settings: ' + added.join(', ') + '.');
  return report;
}

if (typeof module !== 'undefined') {
  module.exports = {
    TAB_HOUSES: TAB_HOUSES,
    TAB_SIGNINS: TAB_SIGNINS,
    TAB_SETTINGS: TAB_SETTINGS,
    HOUSE_HEADERS: HOUSE_HEADERS,
    SIGNIN_HEADERS: SIGNIN_HEADERS,
    SETTINGS_HEADERS: SETTINGS_HEADERS,
    SETTINGS_DEFAULTS: SETTINGS_DEFAULTS,
    TEXT_COLUMNS: TEXT_COLUMNS,
    columnLetter: columnLetter,
    URL_SETTING_KEYS: URL_SETTING_KEYS,
    ASSET_DEFAULTS: ASSET_DEFAULTS,
    siteBaseUrl: siteBaseUrl,
    applyAssetDefaults: applyAssetDefaults,
    escapeFormula: escapeFormula,
    rowsToObjects: rowsToObjects,
    objectToRow: objectToRow,
    parseSettings: parseSettings,
    readSettings: readSettings,
    isActiveValue: isActiveValue,
    normalizeUrl: normalizeUrl,
    formatPrice: formatPrice,
    ensureTabs: ensureTabs
  };
}
