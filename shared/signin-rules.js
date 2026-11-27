/*
 * Guest sign-in rules: the allowed answers, field length limits, and the
 * validator. Used by BOTH the guest form (web/) and the Apps Script endpoint,
 * so the two can never disagree.
 *
 * SOURCE OF TRUTH: shared/signin-rules.js
 * Copies live in web/ and apps-script/endpoint/. Edit the shared/ file, then
 * run `npm run sync`. A test fails if the copies drift.
 *
 * Plain script (no import/export) so it runs in the browser, in Apps Script's
 * V8 runtime, and under Jest.
 */

var CHOICES = Object.freeze({
  agent: Object.freeze(['Yes', 'No']),
  timeline: Object.freeze([
    '0\u20133 months',
    '3\u20136 months',
    '6\u201312 months',
    '12+ months'
  ]),
  preapproved: Object.freeze(['Yes', 'No', 'Cash']),
  heard_from: Object.freeze([
    'Signs',
    'Zillow',
    'Realtor.com',
    'Social media',
    'Friends or family',
    'Other'
  ])
});

var FIELD_LIMITS = Object.freeze({
  name: 200,
  phone: 200,
  email: 200,
  agent: 200,
  timeline: 200,
  preapproved: 200,
  heard_from: 200,
  comments: 1000
});

/** Name of the hidden anti-spam field. Real people never fill it in. */
var HONEYPOT_FIELD = 'hp_contact_ref';

var MIN_PHONE_DIGITS = 10;

var EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/** House ids are random hex strings made by the admin page. */
function isValidHouseId(id) {
  return typeof id === 'string' && /^[0-9a-f]{16,64}$/.test(id);
}

function isHoneypotFilled(body) {
  if (!body || typeof body !== 'object') return false;
  var v = body[HONEYPOT_FIELD];
  return v !== undefined && v !== null && String(v).trim() !== '';
}

function countDigits(s) {
  return String(s).replace(/\D/g, '').length;
}

/**
 * Checks a guest sign-in. Returns
 *   { ok: true, value: { houseId, name, phone, email, agent, timeline,
 *                        preapproved, heard_from, comments } }
 * or
 *   { ok: false, error: '<first friendly message>', fields: { field: msg } }
 */
function validateSignIn(body) {
  var fields = {};
  var value = {};

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Something went wrong. Please try again.', fields: {} };
  }

  var houseId = typeof body.h === 'string' ? body.h.trim() : '';
  if (!isValidHouseId(houseId)) {
    fields.h = 'This sign-in link isn\u2019t valid. Please ask the agent for help.';
  }
  value.houseId = houseId;

  // Optional random submission id from the form, so retries aren't saved twice.
  value.sid = typeof body.sid === 'string' && /^[0-9a-f]{16,64}$/.test(body.sid) ? body.sid : '';

  var labels = {
    name: 'Name',
    phone: 'Phone',
    email: 'Email',
    agent: 'Working with an agent',
    timeline: 'Buying timeline',
    preapproved: 'Pre-approved',
    heard_from: 'How you heard about this open house',
    comments: 'Comments'
  };

  Object.keys(FIELD_LIMITS).forEach(function (key) {
    var raw = body[key];
    if (raw === undefined || raw === null) raw = '';
    if (typeof raw === 'number') raw = String(raw);
    if (typeof raw !== 'string') {
      fields[key] = labels[key] + ' doesn\u2019t look right.';
      value[key] = '';
      return;
    }
    var v = key === 'comments'
      ? raw.replace(/\r\n?/g, '\n').trim()
      : raw.replace(/\s+/g, ' ').trim();
    if (v.length > FIELD_LIMITS[key]) {
      fields[key] = labels[key] + ' is too long (' + FIELD_LIMITS[key] + ' characters max).';
    }
    value[key] = v;
  });

  if (!fields.name && !value.name) fields.name = 'Please enter your name.';

  if (!fields.phone) {
    if (!value.phone) fields.phone = 'Please enter your phone number.';
    else if (countDigits(value.phone) < MIN_PHONE_DIGITS) {
      fields.phone = 'Please enter a full phone number, including area code.';
    }
  }

  if (!fields.email) {
    if (!value.email) fields.email = 'Please enter your email address.';
    else if (!EMAIL_PATTERN.test(value.email)) {
      fields.email = 'Please check your email address (for example, name@example.com).';
    }
  }

  Object.keys(CHOICES).forEach(function (key) {
    if (fields[key]) return;
    if (value[key] !== '' && CHOICES[key].indexOf(value[key]) === -1) {
      fields[key] = 'Please pick one of the listed answers for \u201c' + labels[key] + '\u201d.';
    }
  });

  var order = ['h', 'name', 'phone', 'email', 'agent', 'timeline', 'preapproved', 'heard_from', 'comments'];
  for (var i = 0; i < order.length; i++) {
    if (fields[order[i]]) return { ok: false, error: fields[order[i]], fields: fields };
  }
  return { ok: true, value: value };
}

if (typeof module !== 'undefined') {
  module.exports = {
    CHOICES: CHOICES,
    FIELD_LIMITS: FIELD_LIMITS,
    HONEYPOT_FIELD: HONEYPOT_FIELD,
    MIN_PHONE_DIGITS: MIN_PHONE_DIGITS,
    EMAIL_PATTERN: EMAIL_PATTERN,
    isValidHouseId: isValidHouseId,
    isHoneypotFilled: isHoneypotFilled,
    countDigits: countDigits,
    validateSignIn: validateSignIn
  };
}
