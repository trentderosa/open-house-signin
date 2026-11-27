/*
 * Pure helpers for the public endpoint: HTML escaping, email bodies, the
 * message, the public house filter, redirects, and rate-limit keys.
 * No Apps Script services are used here, so Jest can test it directly.
 */
/* global escapeFormula, formatPrice, normalizeUrl, objectToRow, SIGNIN_HEADERS */

var PUBLIC_HOUSE_FIELDS = ['address', 'price', 'beds', 'baths', 'sqft', 'description', 'listing_url'];

var RATE_LIMIT_MAX = 30;
var RATE_LIMIT_WINDOW_SECONDS = 600;
var OWNER_SUBJECT_PREFIX = 'Open House Sign-in:';

var BRAND = {
  blue: '#0C2749',
  red: '#AA1120',
  cream: '#f7f5ee',
  charcoal: '#232323',
  orange: '#D9875F'
};

function escapeHtml(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escaped text with line breaks kept. */
function escapeMultiline(v) {
  return escapeHtml(v).replace(/\r?\n/g, '<br>');
}

/** For email subjects and sender names: one line, no control characters. */
function oneLine(v, max) {
  var s = String(v === undefined || v === null ? '' : v)
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return max && s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

/** Only the fields a guest is allowed to see. Never ids, flags, or sign-ins. */
function toPublicHouse(house) {
  var h = house || {};
  return {
    address: str(h.address),
    price: formatPrice(h.price),
    beds: str(h.beds),
    baths: str(h.baths),
    sqft: str(h.sqft),
    description: str(h.description),
    listing_url: normalizeUrl(h.listing_url)
  };
}

/** Where to send the guest after signing in: website_url if it is a real URL, else ''. */
function resolveRedirect(settings) {
  return normalizeUrl(settings && settings.website_url);
}

function isValidEmailAddress(s) {
  return /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/.test(s);
}

/** notify_email (comma-separated allowed) if every address is valid; else the fallback. */
function resolveNotifyEmail(settings, fallback) {
  var raw = str(settings && settings.notify_email);
  if (raw) {
    var list = raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (list.length && list.every(isValidEmailAddress)) return list.join(',');
  }
  return fallback || '';
}

/**
 * Splits a typed name into clean name words. A word is kept only if it is made
 * of letters, apostrophes, hyphens and periods, and doesn't look like a web
 * address (".com", "www.x"). So digits (phone numbers), "@" (emails) and URLs
 * never reach the email greeting.
 */
function nameWords(name) {
  return str(name)
    .split(/\s+/)
    .filter(function (p) {
      return /^[\p{L}\p{M}'\u2019.-]+$/u.test(p) && /\p{L}/u.test(p) && !/\.\p{L}{2,}/u.test(p);
    });
}

/**
 * First name for "Hi <name>," in the guest email: letters, apostrophes and
 * hyphens only, max 30 characters, else "there".
 */
function greetingName(name) {
  var words = nameWords(name);
  var first = words.length ? words[0].replace(/\./g, '').slice(0, 30) : '';
  return /\p{L}/u.test(first) ? first : 'there';
}

var CACHE_KEY_MAX = 250;          // CacheService key limit
var SUBMISSION_TTL_SECONDS = 3600; // remember submission ids for an hour
var MAIL_QUOTA_RESERVE = 20;       // keep this many daily emails for agent alerts
var GUEST_MAIL_PER_HOUSE_PER_HOUR = 10;

/** 32-bit FNV-1a as 8 hex chars (for shortening long cache keys). */
function fnv1a_(s, seed) {
  var h = seed >>> 0;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

/** Keeps cache keys under the 250-character limit: long keys become prefix + hash. */
function safeCacheKey(key) {
  var k = String(key);
  if (k.length <= CACHE_KEY_MAX) return k;
  return k.slice(0, 200) + '#' + fnv1a_(k, 0x811c9dc5) + fnv1a_(k, 16777619) + ':' + k.length;
}

function rateLimitKey(houseId, nowMs) {
  return safeCacheKey('rl:' + houseId + ':' + Math.floor(nowMs / (RATE_LIMIT_WINDOW_SECONDS * 1000)));
}

/** Cache key so one guest address gets at most one thank-you per house per window. */
function guestMailKey(houseId, email) {
  return safeCacheKey('gm:' + houseId + ':' + String(email).toLowerCase());
}

/** Counter key for thank-you emails per house per clock hour. */
function guestHourKey(houseId, nowMs) {
  return safeCacheKey('gh:' + houseId + ':' + Math.floor(nowMs / 3600000));
}

/** Key that remembers a submission id, so a retried submit isn't saved twice. */
function submissionKey(sid) {
  return safeCacheKey('sid:' + sid);
}

/**
 * Should the guest get a thank-you email? Protects the agent's own alerts
 * (daily quota reserve) and limits abuse (one per guest, 10 per house/hour).
 * Returns { send: true } or { send: false, reason }.
 */
function guestMailDecision(o) {
  if (o.alreadySent) return { send: false, reason: 'already sent to this guest recently' };
  if (!(o.remainingQuota >= MAIL_QUOTA_RESERVE)) {
    return { send: false, reason: 'only ' + o.remainingQuota + ' emails left today; keeping them for the agent\u2019s alerts' };
  }
  if (o.sentThisHour >= GUEST_MAIL_PER_HOUSE_PER_HOUR) {
    return { send: false, reason: 'hourly limit of ' + GUEST_MAIL_PER_HOUSE_PER_HOUR + ' thank-you emails for this house reached' };
  }
  return { send: true };
}

/** Accepts a full Google Sheets URL or a bare Sheet ID. */
function extractSheetId(input) {
  var s = str(input);
  if (!s) return '';
  var m = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : '';
}

/** One SignIns row, lined up with the sheet's header row, formula-escaped. */
function buildSignInRow(headers, signin, house, now) {
  var obj = {
    timestamp: now,
    house_id: signin.houseId,
    house_address: str(house && house.address),
    name: signin.name,
    phone: signin.phone,
    email: signin.email,
    agent: signin.agent,
    timeline: signin.timeline,
    preapproved: signin.preapproved,
    heard_from: signin.heard_from,
    comments: signin.comments
  };
  return objectToRow(headers || SIGNIN_HEADERS, obj).map(escapeFormula);
}

function emailRow(label, valueHtml) {
  return '<tr>' +
    '<td style="padding:6px 12px 6px 0;color:#555;vertical-align:top;white-space:nowrap;">' + escapeHtml(label) + '</td>' +
    '<td style="padding:6px 0;color:' + BRAND.charcoal + ';vertical-align:top;">' + valueHtml + '</td>' +
    '</tr>';
}

function houseFactsLine(pub) {
  var bits = [];
  if (pub.beds) bits.push(pub.beds + ' bd');
  if (pub.baths) bits.push(pub.baths + ' ba');
  if (pub.sqft) bits.push(pub.sqft + ' sq ft');
  return bits.join(' \u00b7 ');
}

/**
 * The email to the agent. Every guest and house value is escaped.
 * Returns { subject, htmlBody, body }.
 */
function buildOwnerEmail(signin, house, when) {
  var pub = toPublicHouse(house);
  var dash = function (v) { return v ? escapeHtml(v) : '<span style="color:#888;">\u2014</span>'; };
  var digits = str(signin.phone).replace(/[^\d+]/g, '');

  var subject = oneLine(OWNER_SUBJECT_PREFIX + ' ' + signin.name + ' \u2014 ' + pub.address, 250);

  var rows = [
    emailRow('Name', escapeHtml(signin.name)),
    emailRow('Phone', '<a href="tel:' + escapeHtml(digits) + '" style="color:' + BRAND.blue + ';">' + escapeHtml(signin.phone) + '</a>'),
    emailRow('Email', '<a href="mailto:' + escapeHtml(signin.email) + '" style="color:' + BRAND.blue + ';">' + escapeHtml(signin.email) + '</a>'),
    emailRow('Working with an agent?', dash(signin.agent)),
    emailRow('Buying timeline', dash(signin.timeline)),
    emailRow('Pre-approved?', dash(signin.preapproved)),
    emailRow('Heard about it from', dash(signin.heard_from)),
    emailRow('Comments', signin.comments ? escapeMultiline(signin.comments) : dash('')),
    emailRow('House', escapeHtml(pub.address)),
    emailRow('Signed in', escapeHtml(when))
  ].join('');

  var htmlBody =
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif;font-size:15px;line-height:1.45;color:' + BRAND.charcoal + ';max-width:560px;">' +
    '<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:' + BRAND.red + ';">New open house sign-in</p>' +
    '<h2 style="margin:0 0 16px;font-size:20px;color:' + BRAND.blue + ';">' + escapeHtml(signin.name) + ' at ' + escapeHtml(pub.address) + '</h2>' +
    '<table role="presentation" style="border-collapse:collapse;">' + rows + '</table>' +
    '<p style="margin:16px 0 0;font-size:13px;color:#555;">Reply to this email to write back to the guest. Every sign-in is also saved in your Google Sheet.</p>' +
    '</div>';

  var body = [
    'New open house sign-in',
    '',
    'Name: ' + signin.name,
    'Phone: ' + signin.phone,
    'Email: ' + signin.email,
    'Working with an agent?: ' + (signin.agent || '-'),
    'Buying timeline: ' + (signin.timeline || '-'),
    'Pre-approved?: ' + (signin.preapproved || '-'),
    'Heard about it from: ' + (signin.heard_from || '-'),
    'Comments: ' + (signin.comments || '-'),
    'House: ' + pub.address,
    'Signed in: ' + when
  ].join('\n');

  return { subject: subject, htmlBody: htmlBody, body: body };
}

/* ---------- Inline email image (logo) ---------- */

var EMAIL_IMAGE_CIDS = { logo: 'logo' };
var EMAIL_IMAGE_MAX_BYTES = 500 * 1024;
var EMAIL_IMAGE_CACHE_MAX_CHARS = 100000; // CacheService values must stay under 100 KB
var EMAIL_IMAGE_CACHE_SECONDS = 21600;    // 6 hours (CacheService maximum)
var EMAIL_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif'];

/**
 * Which images the thank-you email should try to embed: https only, from
 * logo_url. Returns [{ key, cid, url }].
 */
function planEmailImages(settings) {
  var s = settings || {};
  var plan = [];
  [['logo', s.logo_url]].forEach(function (pair) {
    var url = normalizeUrl(pair[1]);
    if (url && /^https:\/\//i.test(url) && !/\.svgz?([?#]|$)/i.test(url)) {
      plan.push({ key: pair[0], cid: EMAIL_IMAGE_CIDS[pair[0]], url: url });
    }
  });
  return plan;
}

/** Case-insensitive header lookup (UrlFetchApp keeps the server's casing). */
function headerValue(headers, name) {
  var want = String(name).toLowerCase();
  var keys = Object.keys(headers || {});
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === want) {
      var v = headers[keys[i]];
      return Array.isArray(v) ? String(v[0]) : String(v);
    }
  }
  return '';
}

/** Detects PNG / JPEG / GIF from the first bytes (Apps Script bytes are signed). */
function sniffImageType(bytes) {
  if (!bytes || bytes.length < 4) return '';
  var b = [];
  for (var i = 0; i < 4; i++) b.push(bytes[i] & 0xff);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  return '';
}

/**
 * Decides whether a fetched image can be embedded. SVG and anything else
 * many email clients can't show are rejected (not converted).
 * Returns { ok: true, mime } or { ok: false, reason }.
 */
function checkImageResponse(statusCode, contentType, bytes) {
  if (statusCode !== 200) return { ok: false, reason: 'HTTP ' + statusCode };
  var mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (mime === 'image/jpg') mime = 'image/jpeg';
  if (mime === 'image/svg+xml') return { ok: false, reason: 'SVG images are not supported in email; use PNG or JPG' };
  if (EMAIL_IMAGE_TYPES.indexOf(mime) === -1) return { ok: false, reason: 'not a PNG, JPG or GIF (' + (mime || 'no content type') + ')' };
  var size = bytes ? bytes.length : 0;
  if (!size) return { ok: false, reason: 'empty file' };
  if (size > EMAIL_IMAGE_MAX_BYTES) return { ok: false, reason: 'too large (' + Math.round(size / 1024) + ' KB, max 500 KB)' };
  var sniffed = sniffImageType(bytes);
  if (sniffed !== mime) return { ok: false, reason: 'file contents are not a real ' + mime };
  return { ok: true, mime: mime };
}

/** Cache key for an image URL (hashed if long). */
function imageCacheKey(url) {
  return safeCacheKey('img:' + url);
}

/** Only small images are cached (base64 must fit in one CacheService value). */
function shouldCacheImage(base64Length) {
  return base64Length > 0 && base64Length < EMAIL_IMAGE_CACHE_MAX_CHARS;
}

var EMAIL_FONT = 'font-family:Helvetica,Arial,sans-serif;';
var EMAIL_SERIF = 'font-family:Georgia,\'Times New Roman\',serif;';

/**
 * The agent's email signature lines, in order, with blank settings skipped.
 * Each value is one line and length-capped; agent_email is dropped unless it
 * is a valid address. Returns { name, titleLine, address1, address2, phone,
 * phoneDigits, email }, all plain text ('' when blank).
 */
function signatureParts(settings) {
  var s = settings || {};
  var title = oneLine(s.agent_title, 100);
  var office = oneLine(s.office_name, 100);
  var phone = oneLine(s.agent_phone, 50);
  var email = oneLine(s.agent_email, 254);
  return {
    name: oneLine(s.agent_name, 100),
    titleLine: [title, office].filter(Boolean).join(' | '),
    address1: oneLine(s.office_address_line1, 150),
    address2: oneLine(s.office_address_line2, 150),
    phone: phone,
    phoneDigits: phone.replace(/[^\d+]/g, ''),
    email: isValidEmailAddress(email) ? email : ''
  };
}

/** The signature as an HTML table (inline styles only). `withLogo` adds the cid:logo image. */
function signatureHtml(sig, withLogo, logoAlt) {
  var text = EMAIL_FONT + 'font-size:15px;line-height:1.5;color:' + BRAND.charcoal + ';';
  var row = function (inner, extra) {
    return '<tr><td style="' + text + (extra || '') + 'padding:0;">' + inner + '</td></tr>';
  };
  var label = function (l) {
    return '<strong style="color:' + BRAND.orange + ';font-weight:bold;">' + l + '</strong> ';
  };
  var link = 'color:' + BRAND.charcoal + ';text-decoration:none;';
  var rows = [];
  if (sig.name) {
    rows.push(row('<strong style="' + EMAIL_SERIF + 'font-size:17px;font-weight:bold;color:' + BRAND.charcoal + ';">' + escapeHtml(sig.name) + '</strong>'));
  }
  if (sig.titleLine) rows.push(row(escapeHtml(sig.titleLine)));
  if (sig.address1) rows.push(row(escapeHtml(sig.address1)));
  if (sig.address2) rows.push(row(escapeHtml(sig.address2)));
  if (sig.phone) {
    var phoneHtml = sig.phoneDigits
      ? '<a href="tel:' + escapeHtml(sig.phoneDigits) + '" style="' + link + '">' + escapeHtml(sig.phone) + '</a>'
      : escapeHtml(sig.phone);
    rows.push(row(label('P:') + phoneHtml));
  }
  if (sig.email) {
    rows.push(row(label('E:') + '<a href="mailto:' + escapeHtml(sig.email) + '" style="' + link + '">' + escapeHtml(sig.email) + '</a>'));
  }
  if (withLogo) {
    rows.push('<tr><td bgcolor="#ffffff" style="background:#ffffff;background-color:#ffffff;padding:12px 0 0;">' +
      '<img src="cid:' + EMAIL_IMAGE_CIDS.logo + '" width="160" alt="' + escapeHtml(logoAlt || 'Logo') + '"' +
      ' style="display:block;width:160px;max-width:160px;height:auto;border:0;outline:none;text-decoration:none;"></td></tr>');
  }
  if (!rows.length) return '';
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;border-collapse:collapse;">' +
    rows.join('') + '</table>';
}

/** The same signature as plain-text lines. */
function signatureText(sig) {
  var lines = [];
  if (sig.name) lines.push(sig.name);
  if (sig.titleLine) lines.push(sig.titleLine);
  if (sig.address1) lines.push(sig.address1);
  if (sig.address2) lines.push(sig.address2);
  if (sig.phone) lines.push('P: ' + sig.phone);
  if (sig.email) lines.push('E: ' + sig.email);
  return lines;
}

/**
 * The thank-you email to the guest. Returns { subject, htmlBody, body, name }.
 * `name` is the sender display name (agent_name, else office_name).
 * `images` says which inline images were fetched OK, e.g. { logo: true }.
 * Only those are referenced (as cid:), others are left out.
 */
function buildGuestEmail(signin, house, settings, images) {
  var s = settings || {};
  var pub = toPublicHouse(house);
  var agentName = oneLine(s.agent_name, 100);
  var agentPhone = oneLine(s.agent_phone, 50);
  var office = oneLine(s.office_name, 100);
  var websiteUrl = normalizeUrl(s.website_url);
  var first = greetingName(signin.name);
  var facts = houseFactsLine(pub);
  var senderName = agentName || office || 'Open House';
  var sig = signatureParts(s);

  var subject = oneLine('Thanks for visiting ' + (pub.address || 'the open house'), 250);

  var detailRows = [];
  if (pub.address) detailRows.push(emailRow('Address', escapeHtml(pub.address)));
  if (pub.price) detailRows.push(emailRow('Price', escapeHtml(pub.price)));
  if (pub.beds) detailRows.push(emailRow('Beds', escapeHtml(pub.beds)));
  if (pub.baths) detailRows.push(emailRow('Baths', escapeHtml(pub.baths)));
  if (pub.sqft) detailRows.push(emailRow('Square feet', escapeHtml(pub.sqft)));

  var inline = images || {};
  // Table layout + inline styles only, so Gmail, Apple Mail and Outlook agree.
  // The logo is embedded (cid:) rather than hotlinked; see planEmailImages().
  var signature = signatureHtml(sig, !!inline.logo, office || agentName || 'Logo');

  var callLine = agentPhone
    ? 'If you have questions or would like a private showing, just reply to this email or call ' + escapeHtml(agentPhone) + '.'
    : 'If you have questions or would like a private showing, just reply to this email.';

  var htmlBody =
    '<div style="' + EMAIL_FONT + 'font-size:15px;line-height:1.5;color:' + BRAND.charcoal + ';max-width:560px;">' +
    '<p style="margin:0 0 12px;color:' + BRAND.charcoal + ';">Hi ' + escapeHtml(first) + ',</p>' +
    '<p style="margin:0 0 12px;color:' + BRAND.charcoal + ';">Thank you for stopping by my open house!</p>' +
    '<p style="margin:0 0 16px;color:' + BRAND.charcoal + ';">Here are the details so you have them handy.</p>' +
    '<div style="border-left:3px solid ' + BRAND.red + ';padding:4px 0 4px 14px;margin:0 0 16px;">' +
    '<table role="presentation" style="border-collapse:collapse;">' + detailRows.join('') + '</table>' +
    (pub.description ? '<p style="margin:10px 0 0;">' + escapeMultiline(pub.description) + '</p>' : '') +
    (pub.listing_url ? '<p style="margin:10px 0 0;"><a href="' + escapeHtml(pub.listing_url) + '" style="color:' + BRAND.blue + ';font-weight:600;">View the full listing</a></p>' : '') +
    '</div>' +
    '<p style="margin:0;color:' + BRAND.charcoal + ';">' + callLine + '</p>' +
    signature +
    (websiteUrl ? '<p style="margin:16px 0 0;"><a href="' + escapeHtml(websiteUrl) + '" style="display:inline-block;padding:10px 18px;background:' + BRAND.blue + ';color:#ffffff;text-decoration:none;font-weight:600;border-radius:4px;">Learn more about me</a></p>' : '') +
    '</div>';

  var text = [
    'Hi ' + first + ',',
    '',
    'Thank you for stopping by my open house!',
    '',
    'Here are the details so you have them handy.',
    ''
  ];
  if (pub.address) text.push('Address: ' + pub.address);
  if (pub.price) text.push('Price: ' + pub.price);
  if (facts) text.push(facts);
  if (pub.description) text.push('', pub.description);
  if (pub.listing_url) text.push('', 'Full listing: ' + pub.listing_url);
  text.push('', agentPhone
    ? 'If you have questions or would like a private showing, just reply to this email or call ' + agentPhone + '.'
    : 'If you have questions or would like a private showing, just reply to this email.');
  var sigLines = signatureText(sig);
  if (sigLines.length) text.push('');
  text.push.apply(text, sigLines);
  if (websiteUrl) text.push('', 'Learn more about me: ' + websiteUrl);

  return { subject: subject, htmlBody: htmlBody, body: text.join('\n'), name: senderName };
}

if (typeof module !== 'undefined') {
  module.exports = {
    PUBLIC_HOUSE_FIELDS: PUBLIC_HOUSE_FIELDS,
    RATE_LIMIT_MAX: RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_SECONDS: RATE_LIMIT_WINDOW_SECONDS,
    OWNER_SUBJECT_PREFIX: OWNER_SUBJECT_PREFIX,
    escapeHtml: escapeHtml,
    escapeMultiline: escapeMultiline,
    oneLine: oneLine,
    toPublicHouse: toPublicHouse,
    resolveRedirect: resolveRedirect,
    resolveNotifyEmail: resolveNotifyEmail,
    isValidEmailAddress: isValidEmailAddress,
    nameWords: nameWords,
    greetingName: greetingName,
    safeCacheKey: safeCacheKey,
    guestHourKey: guestHourKey,
    submissionKey: submissionKey,
    guestMailDecision: guestMailDecision,
    MAIL_QUOTA_RESERVE: MAIL_QUOTA_RESERVE,
    GUEST_MAIL_PER_HOUSE_PER_HOUR: GUEST_MAIL_PER_HOUSE_PER_HOUR,
    SUBMISSION_TTL_SECONDS: SUBMISSION_TTL_SECONDS,
    rateLimitKey: rateLimitKey,
    guestMailKey: guestMailKey,
    extractSheetId: extractSheetId,
    buildSignInRow: buildSignInRow,
    buildOwnerEmail: buildOwnerEmail,
    buildGuestEmail: buildGuestEmail,
    signatureParts: signatureParts,
    EMAIL_IMAGE_CIDS: EMAIL_IMAGE_CIDS,
    EMAIL_IMAGE_MAX_BYTES: EMAIL_IMAGE_MAX_BYTES,
    EMAIL_IMAGE_CACHE_SECONDS: EMAIL_IMAGE_CACHE_SECONDS,
    planEmailImages: planEmailImages,
    headerValue: headerValue,
    sniffImageType: sniffImageType,
    checkImageResponse: checkImageResponse,
    imageCacheKey: imageCacheKey,
    shouldCacheImage: shouldCacheImage
  };
}
