/*
 * Public endpoint (standalone Apps Script web app, "Anyone" access).
 *
 *   GET  ?h=<houseId>  -> public house info (JSON). Never returns sign-ins.
 *   POST (JSON body sent as text/plain) -> validates and saves a sign-in,
 *        then emails the agent and emails the guest a thank-you.
 *
 * Saving always happens first; email failures are logged, never fatal.
 *
 * Apps Script can't send the response and keep working afterwards (that
 * would need time-based triggers and another OAuth scope), so emails go out
 * before the response. To keep that short, email images are cached for 6
 * hours and uncached ones download in parallel (fetchAll).
 *
 * UrlFetchApp is used ONLY by loadInlineImages_ (email logo).
 */
/* global TAB_HOUSES, TAB_SIGNINS, SIGNIN_HEADERS, rowsToObjects, readSettings, isActiveValue,
   isValidHouseId, isHoneypotFilled, validateSignIn,
   toPublicHouse, resolveRedirect, resolveNotifyEmail,
   buildSignInRow, buildOwnerEmail, buildGuestEmail, rateLimitKey, guestMailKey,
   RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS,
   planEmailImages, headerValue, checkImageResponse, imageCacheKey, shouldCacheImage,
   EMAIL_IMAGE_CACHE_SECONDS, guestHourKey, submissionKey, guestMailDecision, SUBMISSION_TTL_SECONDS */

var MAX_BODY_CHARS = 20000;
var GUEST_MAIL_DEDUPE_SECONDS = 21600; // 6 hours

var MSG_NOT_FOUND = 'This sign-in link isn\u2019t valid. Please ask the agent for help.';
var MSG_GENERIC = 'Something went wrong on our end. Please try again, or let the agent know.';
var MSG_BUSY = 'Lots of people are signing in right now. Please wait a moment and try again.';
var MSG_RATE = 'Too many sign-ins in the last few minutes. Please wait a few minutes and try again.';

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function openSheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID script property is not set. Run setup() first.');
  return SpreadsheetApp.openById(id);
}

function findHouse_(ss, houseId) {
  var sheet = ss.getSheetByName(TAB_HOUSES);
  if (!sheet) return null;
  var houses = rowsToObjects(sheet.getDataRange().getValues());
  for (var i = 0; i < houses.length; i++) {
    if (String(houses[i].id).trim() === houseId) return houses[i];
  }
  return null;
}

function findActiveHouse_(ss, houseId) {
  if (!isValidHouseId(houseId)) return null;
  var house = findHouse_(ss, houseId);
  return house && isActiveValue(house.active) ? house : null;
}

function doGet(e) {
  try {
    var houseId = e && e.parameter && typeof e.parameter.h === 'string' ? e.parameter.h.trim() : '';
    if (!isValidHouseId(houseId)) return json_({ ok: false, status: 404, error: MSG_NOT_FOUND });
    var ss = openSheet_();
    var house = findActiveHouse_(ss, houseId);
    if (!house) return json_({ ok: false, status: 404, error: MSG_NOT_FOUND });
    var settings = readSettings(ss);
    return json_({
      ok: true,
      house: toPublicHouse(house),
      branding: { agent_name: settings.agent_name || '', office_name: settings.office_name || '' }
    });
  } catch (err) {
    console.error('doGet failed: ' + (err && err.stack || err));
    return json_({ ok: false, status: 500, error: MSG_GENERIC });
  }
}

function doPost(e) {
  var body;
  try {
    var raw = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
    if (!raw || raw.length > MAX_BODY_CHARS) {
      return json_({ ok: false, error: 'That sign-in couldn\u2019t be read. Please try again.' });
    }
    body = JSON.parse(raw);
  } catch {
    return json_({ ok: false, error: 'That sign-in couldn\u2019t be read. Please try again.' });
  }

  try {
    var ss = openSheet_();
    var settings = readSettings(ss);
    var redirect = resolveRedirect(settings);

    // Bots fill in the hidden field. Pretend it worked; save and send nothing.
    if (isHoneypotFilled(body)) {
      console.log('Honeypot filled; ignoring submission.');
      return json_({ ok: true, redirect: redirect });
    }

    var check = validateSignIn(body);
    if (!check.ok) return json_({ ok: false, error: check.error, fields: check.fields });
    var signin = check.value;

    var house = findActiveHouse_(ss, signin.houseId);
    if (!house) return json_({ ok: false, error: MSG_NOT_FOUND, fields: { h: MSG_NOT_FOUND } });

    var cache = CacheService.getScriptCache();
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) return json_({ ok: false, error: MSG_BUSY });
    var duplicate = false;
    try {
      // Same form fill retried (e.g. the response was lost)? Already saved.
      var sidKey = signin.sid ? submissionKey(signin.sid) : '';
      if (sidKey && cache.get(sidKey)) {
        duplicate = true;
        return json_({ ok: true, redirect: redirect });
      }
      var now = new Date();
      var key = rateLimitKey(signin.houseId, now.getTime());
      var count = Number(cache.get(key)) || 0;
      if (count >= RATE_LIMIT_MAX) return json_({ ok: false, error: MSG_RATE });

      var sheet = ss.getSheetByName(TAB_SIGNINS);
      if (!sheet) throw new Error('The SignIns tab is missing. Run setup().');
      var headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
      var hasHeaders = headers.some(function (h) { return String(h).trim() !== ''; });
      sheet.appendRow(buildSignInRow(hasHeaders ? headers : SIGNIN_HEADERS, signin, house, now));
      // The row is saved. Bookkeeping below must never turn this into an error.
      [
        function () { if (sidKey) cache.put(sidKey, '1', SUBMISSION_TTL_SECONDS); },
        function () { cache.put(key, String(count + 1), RATE_LIMIT_WINDOW_SECONDS); },
        function () { SpreadsheetApp.flush(); }
      ].forEach(function (step) {
        try {
          step();
        } catch (err) {
          console.error('Post-save bookkeeping failed: ' + (err && err.stack || err));
        }
      });
    } finally {
      lock.releaseLock();
      if (duplicate) console.log('Duplicate submission id; already saved.');
    }

    // Saved. Everything below is best-effort and can never turn this into an error.
    try {
      notifyAll_(signin, house, settings, cache);
    } catch (err) {
      console.error('Notifications failed: ' + (err && err.stack || err));
    }
    return json_({ ok: true, redirect: redirect });
  } catch (err) {
    console.error('doPost failed: ' + (err && err.stack || err));
    return json_({ ok: false, error: MSG_GENERIC });
  }
}

function ownerEmail_() {
  try {
    return Session.getEffectiveUser().getEmail() || '';
  } catch (err) {
    console.error('Could not read owner email: ' + err);
    return '';
  }
}

function notifyAll_(signin, house, settings, cache) {
  try {
    var owner = ownerEmail_();
    var when = '';
    try {
      when = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "EEE, MMM d, yyyy 'at' h:mm a");
    } catch {
      when = new Date().toString();
    }

    // 1. Sign-in alert email to the agent (always first).
    try {
      var to = resolveNotifyEmail(settings, owner);
      if (to) {
        var mail = buildOwnerEmail(signin, house, when);
        MailApp.sendEmail({
          to: to,
          subject: mail.subject,
          body: mail.body,
          htmlBody: mail.htmlBody,
          replyTo: signin.email
        });
      }
    } catch (err) {
      console.error('Agent email failed: ' + err);
    }

    // 2. Thank-you email to the guest, if quota and limits allow.
    try {
      sendGuestEmail_(signin, house, settings, cache, owner);
    } catch (err) {
      console.error('Guest thank-you email failed: ' + err);
    }
  } catch (err) {
    console.error('notifyAll_ failed: ' + (err && err.stack || err));
  }
}

function sendGuestEmail_(signin, house, settings, cache, owner) {
  var dedupeKey = guestMailKey(signin.houseId, signin.email);
  var hourKey = guestHourKey(signin.houseId, Date.now());
  var decision = guestMailDecision({
    alreadySent: !!cache.get(dedupeKey),
    remainingQuota: MailApp.getRemainingDailyQuota(),
    sentThisHour: Number(cache.get(hourKey)) || 0
  });
  if (!decision.send) {
    console.log('Skipping guest thank-you email: ' + decision.reason);
    return;
  }
  var images = loadInlineImages_(settings, cache);
  var guest = buildGuestEmail(signin, house, settings, images.present);
  var options = {
    to: signin.email,
    subject: guest.subject,
    body: guest.body,
    htmlBody: guest.htmlBody,
    name: guest.name
  };
  if (images.count) options.inlineImages = images.blobs;
  if (owner) options.replyTo = owner;
  MailApp.sendEmail(options);
  cache.put(dedupeKey, '1', GUEST_MAIL_DEDUPE_SECONDS);
  cache.put(hourKey, String((Number(cache.get(hourKey)) || 0) + 1), 3600);
}

/**
 * Gets the logo for embedding in the thank-you email (cid:).
 * Cached images come from CacheService; the rest download in parallel.
 * Any failure just leaves that image out; it never blocks the email.
 * Returns { blobs: { cid: Blob }, present: { key: true }, count }.
 */
function loadInlineImages_(settings, cache) {
  var out = { blobs: {}, present: {}, count: 0 };
  var add = function (item, bytes, mime) {
    out.blobs[item.cid] = Utilities.newBlob(bytes, mime, item.cid);
    out.present[item.key] = true;
    out.count++;
  };
  var toFetch = [];
  planEmailImages(settings).forEach(function (item) {
    try {
      var cached = cache.get(imageCacheKey(item.url));
      if (cached) {
        var sep = cached.indexOf('|');
        add(item, Utilities.base64Decode(cached.slice(sep + 1)), cached.slice(0, sep));
      } else {
        toFetch.push(item);
      }
    } catch {
      toFetch.push(item);
    }
  });
  if (!toFetch.length) return out;

  var responses;
  try {
    responses = UrlFetchApp.fetchAll(toFetch.map(function (item) {
      return { url: item.url, muteHttpExceptions: true, followRedirects: true };
    }));
  } catch (err) {
    console.error('Skipping email images: ' + err);
    return out;
  }
  toFetch.forEach(function (item, i) {
    try {
      var res = responses[i];
      var bytes = res.getContent();
      var check = checkImageResponse(res.getResponseCode(), headerValue(res.getHeaders(), 'Content-Type'), bytes);
      if (!check.ok) {
        console.error('Skipping ' + item.key + ' image in email: ' + check.reason);
        return;
      }
      var b64 = Utilities.base64Encode(bytes);
      if (shouldCacheImage(b64.length)) {
        try {
          cache.put(imageCacheKey(item.url), check.mime + '|' + b64, EMAIL_IMAGE_CACHE_SECONDS);
        } catch (err) {
          console.error('Could not cache ' + item.key + ' image: ' + err);
        }
      }
      add(item, bytes, check.mime);
    } catch (err) {
      console.error('Skipping ' + item.key + ' image in email: ' + err);
    }
  });
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { doGet: doGet, doPost: doPost };
}
