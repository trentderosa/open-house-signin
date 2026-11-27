/*
 * Admin web app (bound to the Sheet, "Only myself" access).
 * Add a house, get its QR code, and reprint past QR codes.
 */
/* global TAB_HOUSES, HOUSE_HEADERS, ensureTabs, readSettings, rowsToObjects, objectToRow,
   escapeFormula, makeHouseId, validateHouseInput, buildGuestUrl, housesForAdmin */

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Open House Admin')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Used by Index.html to pull in Styles.html and Client.html. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Run once from the editor: creates the Houses, SignIns and Settings tabs. */
function setup() {
  ensureTabs(SpreadsheetApp.getActiveSpreadsheet()).forEach(function (line) { console.log(line); });
}

function adminSettings_(settings) {
  var link = buildGuestUrl(settings.guest_form_url, 'test');
  return {
    guestFormReady: link.ok,
    guestFormError: link.ok ? '' : link.error,
    // Blank settings already default to files on the guest form site (parseSettings).
    qrLogoUrl: settings.qr_logo_url || '',
    printLogoUrl: settings.print_logo_url || ''
  };
}

/** Everything the admin page needs on load. */
function getAdminData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_HOUSES);
  if (!sheet) {
    ensureTabs(ss);
    sheet = ss.getSheetByName(TAB_HOUSES);
  }
  var settings = readSettings(ss);
  return {
    settings: adminSettings_(settings),
    houses: housesForAdmin(rowsToObjects(sheet.getDataRange().getValues()), settings.guest_form_url)
  };
}

/** Saves a new house and returns it (with its guest link) for the QR code. */
function addHouse(input) {
  var check = validateHouseInput(input);
  if (!check.ok) throw new Error(check.error);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_HOUSES);
  if (!sheet) {
    ensureTabs(ss);
    sheet = ss.getSheetByName(TAB_HOUSES);
  }
  var headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
  if (!headers.some(function (h) { return String(h).trim() !== ''; })) headers = HOUSE_HEADERS;

  var v = check.value;
  var record = {
    id: makeHouseId(Utilities.getUuid()),
    created_at: new Date(),
    active: true,
    address: v.address,
    price: v.price,
    beds: v.beds,
    baths: v.baths,
    sqft: v.sqft,
    description: v.description,
    listing_url: v.listing_url
  };
  sheet.appendRow(objectToRow(headers, record).map(escapeFormula));

  var activeCol = headers.map(function (h) { return String(h).trim().toLowerCase(); }).indexOf('active') + 1;
  if (activeCol > 0) {
    sheet.getRange(sheet.getLastRow(), activeCol).insertCheckboxes().setValue(true);
  }

  var settings = readSettings(ss);
  return {
    settings: adminSettings_(settings),
    house: housesForAdmin([record], settings.guest_form_url)[0]
  };
}

if (typeof module !== 'undefined') {
  module.exports = { doGet: doGet, include: include, setup: setup, getAdminData: getAdminData, addHouse: addHouse };
}
