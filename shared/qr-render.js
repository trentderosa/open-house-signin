/*
 * QR code rendering for the printable sign page: Bridge Blue modules on white,
 * error correction H, 4-module quiet zone, optional center image (the
 * balloon mark) in a white box in the middle. One SVG, so it prints crisp.
 *
 * SOURCE OF TRUTH: shared/qr-render.js
 * `npm run sync` wraps it in <script> as apps-script/admin/QrRender.html.
 * dev/print-preview.html loads this file directly. Jest tests the geometry.
 *
 * Needs the qrcode-generator library (global `qrcode`) for makeQr().
 */

var QR_COLOR = '#0C2749';          // REMAX Bridge Blue
var QR_ERROR_CORRECTION = 'H';     // ~30% of the code can be covered and still scan
var QR_QUIET_ZONE = 4;             // modules of white border (the spec minimum)
var QR_LOGO_RATIO = 0.20;          // logo width as a share of the code width
var QR_LOGO_BOX_MAX_RATIO = 0.26;  // white box width cap as a share of the code width
var QR_FINDER_SIZE = 8;            // 7x7 finder + 1 separator, in each of 3 corners
var QR_BRAND_FALLBACK = 'RE/MAX';   // text shown only if the wordmark image fails

/**
 * Level H codes have odd module counts. An odd-sized box centers exactly on
 * whole modules. With an odd version number, the largest odd box under 26%
 * lands at about 24-25%; even versions would only fit about 22%. So round
 * the version up to the next odd one.
 */
function pickTypeNumber(autoTypeNumber) {
  var v = Math.max(1, Math.min(40, Math.floor(autoTypeNumber)));
  if (v >= 40) return 40;
  return v % 2 === 0 ? v + 1 : v;
}

/**
 * Where the logo box goes. Everything is in whole modules, measured from the
 * top-left of the code (not counting the quiet zone), plus pixel values for a
 * symbol drawn `sizePx` wide (quiet zone included).
 *
 *   box:  white square, odd number of modules, centered, <= 26% of the code width
 *   logo: square area for the logo inside the box, about 20% of the code width,
 *         with at least half a module of white padding on every side
 */
function computeLogoBox(moduleCount, sizePx, quietZone) {
  var n = Math.floor(moduleCount);
  if (!(n >= 21) || n % 2 !== 1) throw new Error('moduleCount must be an odd number >= 21');
  var q = quietZone === undefined ? QR_QUIET_ZONE : quietZone;
  var total = n + 2 * q;
  var modulePx = (sizePx || total) / total;

  var boxSize = Math.floor(n * QR_LOGO_BOX_MAX_RATIO);
  if (boxSize % 2 === 0) boxSize -= 1;
  var boxStart = (n - boxSize) / 2;

  var logoSize = Math.min(n * QR_LOGO_RATIO, boxSize - 1);
  var logoStart = boxStart + (boxSize - logoSize) / 2;

  return {
    moduleCount: n,
    quietZone: q,
    totalModules: total,
    modulePx: modulePx,
    box: { start: boxStart, size: boxSize, ratio: boxSize / n },
    logo: { start: logoStart, size: logoSize, ratio: logoSize / n },
    px: {
      boxX: (q + boxStart) * modulePx,
      boxSize: boxSize * modulePx,
      logoX: (q + logoStart) * modulePx,
      logoSize: logoSize * modulePx
    }
  };
}

/** True if module (row, col) is inside one of the three finder patterns (with separator). */
function isFinderModule(row, col, moduleCount) {
  var f = QR_FINDER_SIZE;
  var n = moduleCount;
  return (row < f && col < f) || (row < f && col >= n - f) || (row >= n - f && col < f);
}

/** Builds a level-H QR code object with an odd version. `factory` is qrcode-generator's `qrcode`. */
function makeQr(factory, text) {
  var probe = factory(0, QR_ERROR_CORRECTION);
  probe.addData(text);
  probe.make();
  var auto = (probe.getModuleCount() - 17) / 4;
  var v = pickTypeNumber(auto);
  if (v === auto) return probe;
  var qr = factory(v, QR_ERROR_CORRECTION);
  qr.addData(text);
  qr.make();
  return qr;
}

function escapeAttr_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** https/http URLs, or a plain relative path (dev harness). Nothing else. */
function isSafeImageUrl(url) {
  var s = String(url || '');
  if (!s || /[\s"'<>`\\]/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  return /^[A-Za-z0-9._\-/]+$/.test(s) && s.indexOf('//') === -1;
}

/**
 * The whole symbol as one SVG string, drawn in module units (viewBox), so it
 * scales crisply. If options.logoUrl is set, dark modules under the white box
 * are left out and the logo is drawn as an SVG <image>.
 */
function buildQrSvg(qr, options) {
  var opts = options || {};
  var n = qr.getModuleCount();
  var q = QR_QUIET_ZONE;
  var total = n + 2 * q;
  var color = opts.color || QR_COLOR;
  var logoUrl = isSafeImageUrl(opts.logoUrl) ? opts.logoUrl : '';
  var geo = logoUrl ? computeLogoBox(n, total, q) : null;
  var b0 = geo ? geo.box.start : -1;
  var b1 = geo ? geo.box.start + geo.box.size : -1;

  var d = '';
  for (var r = 0; r < n; r++) {
    for (var c = 0; c < n; c++) {
      if (geo && r >= b0 && r < b1 && c >= b0 && c < b1) continue;
      if (qr.isDark(r, c)) d += 'M' + (c + q) + ' ' + (r + q) + 'h1v1h-1z';
    }
  }

  var svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"' +
    ' viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges"' +
    ' role="img" aria-label="' + escapeAttr_(opts.label || 'QR code') + '">' +
    '<rect width="' + total + '" height="' + total + '" fill="#ffffff"/>' +
    '<path d="' + d + '" fill="' + escapeAttr_(color) + '"/>';
  if (geo) {
    svg += '<rect x="' + (q + geo.box.start) + '" y="' + (q + geo.box.start) + '" width="' + geo.box.size +
      '" height="' + geo.box.size + '" fill="#ffffff"/>' +
      '<image class="qr-logo" href="' + escapeAttr_(logoUrl) + '" xlink:href="' + escapeAttr_(logoUrl) + '"' +
      ' x="' + (q + geo.logo.start) + '" y="' + (q + geo.logo.start) + '" width="' + geo.logo.size +
      '" height="' + geo.logo.size + '" preserveAspectRatio="xMidYMid meet"/>';
  }
  return svg + '</svg>';
}

/**
 * Fills `container` with the print layout. Nothing else goes on the page:
 *   - the QR code, with options.centerLogoUrl (the balloon) in the middle
 *   - options.brandLogoUrl (the wordmark) centered below, about 3.75 in wide
 * An image that fails to load is left out (the wordmark falls back to text).
 * Resolves once every image has loaded or failed, so print() can follow.
 */
function renderPrintSheet(container, options) {
  var opts = options || {};
  var doc = container.ownerDocument;
  var win = doc.defaultView;
  var factory = opts.qrcode || (typeof qrcode === 'function' ? qrcode : null);
  if (!factory) return Promise.reject(new Error('The QR code library did not load. Check your internet connection and reload.'));
  var qr = makeQr(factory, opts.url);
  var timeoutMs = opts.timeoutMs || 8000;

  // Waits for an element's load/error event (or a timeout). Resolves true if loaded.
  function whenLoaded(el, alreadyLoaded) {
    return new Promise(function (resolve) {
      if (alreadyLoaded) return resolve(true);
      var done = false;
      var finish = function (ok) { if (!done) { done = true; resolve(ok); } };
      el.addEventListener('load', function () { finish(true); });
      el.addEventListener('error', function () { finish(false); });
      win.setTimeout(function () { finish(false); }, timeoutMs);
    });
  }

  function preload(url) {
    if (!isSafeImageUrl(url)) return Promise.resolve(false);
    var img = new win.Image();
    var p = whenLoaded(img, false);
    img.src = url;
    return p;
  }

  container.textContent = '';
  var qrBox = doc.createElement('div');
  qrBox.className = 'print-qr';
  container.appendChild(qrBox);
  var brandBox = doc.createElement('div');
  brandBox.className = 'print-brand';
  container.appendChild(brandBox);

  function drawBrandText() {
    brandBox.textContent = '';
    var text = doc.createElement('div');
    text.className = 'print-brand-text';
    text.textContent = QR_BRAND_FALLBACK;
    brandBox.appendChild(text);
  }

  var center = preload(opts.centerLogoUrl).then(function (ok) {
    qrBox.innerHTML = buildQrSvg(qr, { logoUrl: ok ? opts.centerLogoUrl : '' });
    var image = qrBox.querySelector('image');
    if (!image) return false;
    // Preloaded, so the SVG <image> comes from cache; give it a moment either way.
    return Promise.race([
      whenLoaded(image, false),
      new Promise(function (resolve) { win.setTimeout(function () { resolve(true); }, 300); })
    ]);
  });

  var brand = preload(opts.brandLogoUrl).then(function (ok) {
    if (!ok) { drawBrandText(); return false; }
    var img = doc.createElement('img');
    img.className = 'print-brand-logo';
    img.alt = QR_BRAND_FALLBACK;
    var p = whenLoaded(img, false);
    img.src = opts.brandLogoUrl;
    brandBox.appendChild(img);
    return p.then(function (loaded) { if (!loaded) drawBrandText(); return loaded; });
  });

  return Promise.all([center, brand]).then(function (r) {
    return { centerLogo: r[0], brandLogo: r[1] };
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    QR_COLOR: QR_COLOR,
    QR_ERROR_CORRECTION: QR_ERROR_CORRECTION,
    QR_QUIET_ZONE: QR_QUIET_ZONE,
    QR_LOGO_RATIO: QR_LOGO_RATIO,
    QR_LOGO_BOX_MAX_RATIO: QR_LOGO_BOX_MAX_RATIO,
    QR_FINDER_SIZE: QR_FINDER_SIZE,
    pickTypeNumber: pickTypeNumber,
    computeLogoBox: computeLogoBox,
    isFinderModule: isFinderModule,
    makeQr: makeQr,
    isSafeImageUrl: isSafeImageUrl,
    buildQrSvg: buildQrSvg,
    renderPrintSheet: renderPrintSheet
  };
}
