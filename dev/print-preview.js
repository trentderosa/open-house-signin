/* Dev-only driver for print-preview.html. */
/* global renderPrintSheet */
(function () {
  'use strict';
  var SAMPLE_URL = 'https://example.github.io/open-house-signin/?h=0123456789abcdef';
  var params = new URLSearchParams(window.location.search);
  var url = params.get('url') || SAMPLE_URL;
  // Real artwork from the guest form site folder. ?logo=0 / ?brand=0 turn them off.
  var logoParam = params.get('logo');
  var brandParam = params.get('brand');
  var centerLogoUrl = logoParam === '0' ? '' : (logoParam || '../web/assets/balloon.svg');
  var brandLogoUrl = brandParam === '0' ? '' : (brandParam || '../web/assets/logo.svg');

  document.getElementById('encoded').textContent = url;
  renderPrintSheet(document.getElementById('print-sheet'), {
    url: url,
    centerLogoUrl: centerLogoUrl,
    brandLogoUrl: brandLogoUrl
  }).then(function (result) {
    document.body.dataset.centerLogo = String(result.centerLogo);
    document.body.dataset.brandLogo = String(result.brandLogo);
    document.body.dataset.ready = 'true';
  }, function (err) {
    document.body.dataset.ready = 'error';
    document.body.dataset.error = err.message;
  });
})();
