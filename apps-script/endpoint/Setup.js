/*
 * One-time setup for the endpoint. Run from the Apps Script editor.
 *
 * Tell this script which Google Sheet to use, in ONE of two ways:
 *   A) Project Settings (gear icon) -> Script Properties -> add property
 *      SHEET_ID with the Sheet's ID (or full URL), then run setup().
 *   B) In the online editor ONLY, paste the Sheet URL between the quotes
 *      below, run setup(), then delete it again. Never commit it to git.
 * Running setup() again later is safe.
 */
/* global ensureTabs, extractSheetId, readSettings, resolveNotifyEmail */

var SHEET_ID_FOR_SETUP = '';

function setup() {
  var props = PropertiesService.getScriptProperties();
  var id = extractSheetId(SHEET_ID_FOR_SETUP) || extractSheetId(props.getProperty('SHEET_ID'));
  if (!id) {
    throw new Error('No Sheet ID yet. Add a Script Property named SHEET_ID (Project Settings, gear icon) with the Sheet\u2019s ID or URL, then run setup() again.');
  }
  var ss = SpreadsheetApp.openById(id);
  props.setProperty('SHEET_ID', id);
  console.log('Connected to Sheet: ' + ss.getName());
  ensureTabs(ss).forEach(function (line) { console.log(line); });
  console.log('Emails left today: ' + MailApp.getRemainingDailyQuota());
  console.log('Setup finished. Next: Deploy -> New deployment -> Web app.');
}

/** Sends one test sign-in alert email to the agent. Saves nothing. */
function sendTestEmail() {
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID'));
  var settings = readSettings(ss);
  var to = resolveNotifyEmail(settings, Session.getEffectiveUser().getEmail());
  MailApp.sendEmail(to, 'Open House Sign-in: TEST \u2014 alerts are working', 'This is a test from your open house sign-in system. Nothing was saved.');
  console.log('Test email sent to ' + to + '.');
}
