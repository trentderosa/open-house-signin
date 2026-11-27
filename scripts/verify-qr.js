#!/usr/bin/env node
/*
 * Decodes QR codes in PNG screenshots (for example, Playwright screenshots of
 * dev/print-preview.html) and checks the decoded text.
 *
 *   node scripts/verify-qr.js --expect "<url>" shot1.png [shot2.png ...]
 *   node scripts/verify-qr.js shot.png            # just report what decodes
 *
 * Exit code 0 only if every file decodes (and matches --expect when given).
 */
'use strict';

const fs = require('fs');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');

/** Nearest-neighbour downscale of RGBA data by an integer factor. */
function downscale(data, width, height, factor) {
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y * factor) * width + x * factor) * 4;
      const di = (y * w + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return { data: out, width: w, height: h };
}

/** Tries full size, then smaller sizes (jsQR can struggle with very large modules). */
function decodeRgba(data, width, height) {
  for (const factor of [1, 2, 3, 4]) {
    const img = factor === 1
      ? { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height }
      : downscale(data, width, height, factor);
    if (img.width < 21 || img.height < 21) break;
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    if (code) return { text: code.data, version: code.version, scale: factor };
  }
  return null;
}

function decodePngFile(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return decodeRgba(png.data, png.width, png.height);
}

function verify(files, expect) {
  return files.map((file) => {
    try {
      const res = decodePngFile(file);
      if (!res) return { file, ok: false, decoded: false, message: 'no QR code found' };
      const matches = expect === undefined ? true : res.text === expect;
      return {
        file,
        ok: matches,
        decoded: true,
        text: res.text,
        version: res.version,
        message: matches ? 'decoded' + (expect !== undefined ? ' and matches' : '') : 'decoded but text does not match'
      };
    } catch (err) {
      return { file, ok: false, decoded: false, message: 'could not read PNG: ' + err.message };
    }
  });
}

function parseArgs(argv) {
  const files = [];
  let expect;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--expect') expect = argv[++i];
    else if (argv[i].startsWith('--expect=')) expect = argv[i].slice('--expect='.length);
    else files.push(argv[i]);
  }
  return { files, expect };
}

function main() {
  const { files, expect } = parseArgs(process.argv.slice(2));
  if (!files.length) {
    console.error('Usage: node scripts/verify-qr.js [--expect "<text>"] shot1.png [shot2.png ...]');
    process.exit(2);
  }
  const results = verify(files, expect);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.file}: ${r.message}${r.decoded ? ` (v${r.version}) -> ${r.text}` : ''}`);
  }
  if (expect !== undefined) console.log(`Expected: ${expect}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `${failed} of ${results.length} failed.` : `All ${results.length} passed.`);
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main();

module.exports = { decodeRgba, decodePngFile, verify, parseArgs };
