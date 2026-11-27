/*
 * Pure helpers for the admin page: house form validation, random ids, guest
 * links, and list sorting. No Apps Script services, so Jest can test it.
 */
/* global normalizeUrl, isActiveValue, formatPrice */

var HOUSE_LIMITS = {
  address: 200,
  price: 50,
  beds: 20,
  baths: 20,
  sqft: 20,
  description: 1000,
  listing_url: 500
};

/**
 * Makes an unguessable house id: 20 hex characters (about 80 random bits)
 * taken from a v4 UUID, skipping the fixed version and variant characters.
 * The first character is always a letter a-f, so Sheets can never read an
 * id as a number (e.g. "1234e5" as scientific notation).
 */
function makeHouseId(uuid) {
  var hex = String(uuid).replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('makeHouseId needs a UUID');
  var id = hex.slice(0, 12) + hex.slice(13, 16) + hex.slice(17, 22);
  var first = id.charAt(0);
  if (/[0-9]/.test(first)) first = 'abcdef'.charAt(parseInt(first, 10) % 6);
  return first + id.slice(1);
}

/** Checks the admin "add a house" form. Returns { ok, value } or { ok:false, error }. */
function validateHouseInput(input) {
  var src = input || {};
  var value = {};
  var keys = Object.keys(HOUSE_LIMITS);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var raw = src[k];
    var v = raw === undefined || raw === null ? '' : String(raw);
    v = k === 'description' ? v.replace(/\r\n?/g, '\n').trim() : v.replace(/\s+/g, ' ').trim();
    if (v.length > HOUSE_LIMITS[k]) {
      return { ok: false, error: 'The ' + k.replace('_', ' ') + ' is too long (' + HOUSE_LIMITS[k] + ' characters max).' };
    }
    value[k] = v;
  }
  if (!value.address) return { ok: false, error: 'Please enter the address.' };
  if (value.listing_url) {
    var url = normalizeUrl(value.listing_url);
    if (!url) return { ok: false, error: 'The listing link should be a web address, like https://www.example.com/listing.' };
    value.listing_url = url;
  }
  return { ok: true, value: value };
}

/**
 * Builds the link the QR code points to: <guest_form_url>?h=<id>.
 * Returns { ok: true, url } or { ok: false, error } when the setting is unusable.
 */
function buildGuestUrl(guestFormUrl, houseId) {
  var raw = String(guestFormUrl === undefined || guestFormUrl === null ? '' : guestFormUrl).trim();
  if (!raw) {
    return { ok: false, error: 'The guest_form_url setting is blank. Open the Settings tab in your Sheet and paste the guest sign-in page address there.' };
  }
  var base = normalizeUrl(raw);
  if (!base || !/^https:\/\//i.test(base)) {
    return { ok: false, error: 'The guest_form_url setting doesn\u2019t look like a secure web address. It should start with https://' };
  }
  base = base.replace(/#.*$/, '');
  var sep = base.indexOf('?') === -1 ? '?' : '&';
  return { ok: true, url: base + sep + 'h=' + encodeURIComponent(houseId) };
}

function toIso_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString();
  var d = new Date(v);
  return v && !isNaN(d.getTime()) ? d.toISOString() : '';
}

/**
 * Turns Houses rows into what the admin page shows, newest first.
 * Dates become ISO strings because google.script.run can't send Date objects.
 */
function housesForAdmin(houses, guestFormUrl) {
  var list = (houses || []).map(function (h, index) {
    var link = buildGuestUrl(guestFormUrl, String(h.id || ''));
    return {
      id: String(h.id || ''),
      createdAt: toIso_(h.created_at),
      active: isActiveValue(h.active),
      address: String(h.address || ''),
      price: formatPrice(h.price),
      beds: String(h.beds === undefined ? '' : h.beds),
      baths: String(h.baths === undefined ? '' : h.baths),
      sqft: String(h.sqft === undefined ? '' : h.sqft),
      guestUrl: link.ok ? link.url : '',
      order: index
    };
  }).filter(function (h) { return h.id; });
  list.sort(function (a, b) {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return b.order - a.order;
  });
  return list;
}

if (typeof module !== 'undefined') {
  module.exports = {
    HOUSE_LIMITS: HOUSE_LIMITS,
    makeHouseId: makeHouseId,
    validateHouseInput: validateHouseInput,
    buildGuestUrl: buildGuestUrl,
    housesForAdmin: housesForAdmin
  };
}
