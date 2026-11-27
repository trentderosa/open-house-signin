'use strict';

/*
 * Dev-only: writes dev/email-preview.html, the guest thank-you email built
 * with fake settings, so it can be opened in a browser and screenshotted.
 * Not deployed. Run: node dev/email-preview.js
 */
const fs = require('fs');
const path = require('path');
const { loadGas } = require('../test/helpers/load.js');

const lib = loadGas([
  'apps-script/endpoint/sheet-core.js',
  'apps-script/endpoint/signin-rules.js',
  'apps-script/endpoint/EndpointLib.js'
]);

// Fake data only (the repo is public).
const settings = lib.parseSettings([
  ['agent_name', 'Jane Doe'],
  ['agent_title', 'Realtor'],
  ['office_name', 'Example Realty'],
  ['office_address_line1', '100 Example St'],
  ['office_address_line2', 'Anytown, VA 00000'],
  ['agent_phone', '555-0123'],
  ['agent_email', 'jane@example.com'],
  ['website_url', 'https://www.example.com'],
  ['guest_form_url', 'https://example.github.io/open-house-signin/']
]);

const house = {
  address: '12 Oak St, Anytown, VA 00000',
  price: 450000,
  beds: 3,
  baths: 2.5,
  sqft: 1800,
  description: 'Sunny colonial on a quiet street.\nNew roof and updated kitchen.',
  listing_url: 'https://www.example.com/listing/12-oak'
};

const signin = { name: 'John Example', email: 'john@example.com' };

const mail = lib.buildGuestEmail(signin, house, settings, { logo: true });
const html = mail.htmlBody.replace(/cid:logo/g, '../web/assets/logo.png');

const page = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
  '<title>' + lib.escapeHtml(mail.subject) + '</title></head>' +
  '<body style="margin:0;padding:24px;background:#ffffff;">\n' + html + '\n' +
  '<pre style="margin:32px 0 0;padding:16px;border-top:1px solid #ccc;font-size:13px;white-space:pre-wrap;">' +
  lib.escapeHtml('Subject: ' + mail.subject + '\nFrom name: ' + mail.name + '\n\n' + mail.body) + '</pre>\n' +
  '</body></html>\n';

const out = path.join(__dirname, 'email-preview.html');
fs.writeFileSync(out, page);
console.log('Wrote ' + out);
