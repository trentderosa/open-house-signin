'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');
const qrcode = require('qrcode-generator');
const qr = require('../shared/qr-render.js');
const { decodeRgba, decodePngFile, verify, parseArgs } = require('../scripts/verify-qr.js');

const SAMPLE = 'https://example.github.io/open-house-signin/?h=0123456789abcdef';
const ODD_COUNTS = [];
for (let n = 21; n <= 177; n += 2) ODD_COUNTS.push(n);
const versionOf = (n) => (n - 17) / 4;

describe('pickTypeNumber', () => {
  test('rounds even versions up to the next odd one', () => {
    expect(qr.pickTypeNumber(1)).toBe(1);
    expect(qr.pickTypeNumber(8)).toBe(9);
    expect(qr.pickTypeNumber(9)).toBe(9);
    expect(qr.pickTypeNumber(39)).toBe(39);
    expect(qr.pickTypeNumber(40)).toBe(40);
  });
});

describe('computeLogoBox', () => {
  test.each(ODD_COUNTS)('module count %i: box <= 26%, odd, centered, module-aligned', (n) => {
    const g = qr.computeLogoBox(n, 600);
    expect(g.box.ratio).toBeLessThanOrEqual(0.26);
    expect(g.box.size % 2).toBe(1);
    expect(Number.isInteger(g.box.start)).toBe(true);
    expect(Number.isInteger(g.box.size)).toBe(true);
    expect(g.box.start * 2 + g.box.size).toBe(n); // centered
    // Far below what level H can recover (~30% of codewords).
    expect(g.box.ratio * g.box.ratio).toBeLessThan(0.07);
  });

  test.each(ODD_COUNTS)('module count %i: box never touches a finder pattern', (n) => {
    const { box } = qr.computeLogoBox(n, 600);
    for (let r = box.start; r < box.start + box.size; r++) {
      for (let c = box.start; c < box.start + box.size; c++) {
        expect(qr.isFinderModule(r, c, n)).toBe(false);
      }
    }
    // Also clear of the timing patterns on row/column 6.
    expect(box.start).toBeGreaterThan(6);
  });

  test.each(ODD_COUNTS)('module count %i: logo is ~20% and padded inside the box', (n) => {
    const { box, logo } = qr.computeLogoBox(n, 600);
    expect(logo.ratio).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(logo.ratio).toBeGreaterThan(0.15);
    expect(logo.start - box.start).toBeGreaterThanOrEqual(0.5);
    expect(box.start + box.size - (logo.start + logo.size)).toBeGreaterThanOrEqual(0.5 - 1e-9);
  });

  test('odd versions (what makeQr uses) land in the 23.8-26% band', () => {
    for (let v = 1; v <= 39; v += 2) {
      const n = 4 * v + 17;
      const { box } = qr.computeLogoBox(n, 600);
      expect(box.ratio).toBeGreaterThanOrEqual(0.238);
      expect(box.ratio).toBeLessThanOrEqual(0.26);
      if (v >= 3) expect(box.ratio).toBeGreaterThanOrEqual(0.24);
    }
  });

  test('pixel values line up with whole modules including the quiet zone', () => {
    const n = 53;
    const total = n + 8;
    const g = qr.computeLogoBox(n, total * 10);
    expect(g.modulePx).toBe(10);
    expect(g.px.boxX).toBe((4 + g.box.start) * 10);
    expect(g.px.boxSize).toBe(g.box.size * 10);
    expect(g.px.boxX * 2 + g.px.boxSize).toBe(total * 10); // centered in pixels too
  });

  test('rejects impossible module counts', () => {
    expect(() => qr.computeLogoBox(20, 100)).toThrow();
    expect(() => qr.computeLogoBox(10, 100)).toThrow();
  });
});

describe('makeQr', () => {
  test('uses level H and an odd version', () => {
    const code = qr.makeQr(qrcode, SAMPLE);
    const v = versionOf(code.getModuleCount());
    expect(v % 2).toBe(1);
    expect(qr.QR_ERROR_CORRECTION).toBe('H');
  });
});

describe('buildQrSvg', () => {
  const code = qr.makeQr(qrcode, SAMPLE);
  const n = code.getModuleCount();

  test('Bridge Blue on white with a 4-module quiet zone', () => {
    const svg = qr.buildQrSvg(code, {});
    expect(svg).toContain(`viewBox="0 0 ${n + 8} ${n + 8}"`);
    expect(svg).toContain('fill="#0C2749"');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).not.toContain('<image');
    const coords = [...svg.matchAll(/M(\d+) (\d+)h1/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(Math.min(...coords.flat())).toBe(4);
    expect(Math.max(...coords.flat())).toBe(n + 3);
  });

  test('with a logo: no dark modules under the white box, escaped image href', () => {
    const svg = qr.buildQrSvg(code, { logoUrl: 'https://www.example.com/logo.png?a=1&b=2' });
    const { box } = qr.computeLogoBox(n, n + 8);
    const lo = 4 + box.start;
    const hi = lo + box.size;
    for (const m of svg.matchAll(/M(\d+) (\d+)h1/g)) {
      const x = Number(m[1]);
      const y = Number(m[2]);
      expect(x >= lo && x < hi && y >= lo && y < hi).toBe(false);
    }
    expect(svg).toContain('href="https://www.example.com/logo.png?a=1&amp;b=2"');
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
  });

  test('unsafe logo URLs are ignored', () => {
    for (const bad of ['javascript:alert(1)', 'data:image/svg+xml,<svg>', '//evil.example.com/x.png', 'a" onload="x']) {
      expect(qr.buildQrSvg(code, { logoUrl: bad })).not.toContain('<image');
    }
  });
});

/* ---- Decode tests: draw the modules to pixels and read them back with jsQR ---- */

function rasterize(code, { logo, noise, scale = 4 } = {}) {
  const n = code.getModuleCount();
  const q = 4;
  const size = (n + 2 * q) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  const geo = logo ? qr.computeLogoBox(n, size, q) : null;
  const set = (px, py, dark) => {
    const i = (py * size + px) * 4;
    data[i] = dark ? 12 : 255;
    data[i + 1] = dark ? 39 : 255;
    data[i + 2] = dark ? 73 : 255;
  };
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const inBox = geo && r >= geo.box.start && r < geo.box.start + geo.box.size && c >= geo.box.start && c < geo.box.start + geo.box.size;
      if (inBox || !code.isDark(r, c)) continue;
      for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) set((c + q) * scale + x, (r + q) * scale + y, true);
    }
  }
  if (geo && noise) {
    // Worst case: a busy logo of random dark/light blocks fills the logo area.
    let seed = 7;
    const rand = () => { seed = (seed * 0x41c64e6d + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const x0 = Math.round(geo.px.logoX);
    const x1 = Math.round(geo.px.logoX + geo.px.logoSize);
    for (let y = x0; y < x1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const dark = rand() < 0.5;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) if (x + dx < x1 && y + dy < x1) set(x + dx, y + dy, dark);
      }
    }
  }
  return { data, width: size, height: size };
}

describe('decoding with the center logo box', () => {
  const urls = [
    SAMPLE,
    'https://example.github.io/open-house-signin/?h=a1b2c3d4e5f6a7b8c9d0',
    'https://some-longer-username.github.io/open-house-signin-form/?h=a1b2c3d4e5f6a7b8c9d0'
  ];

  test.each(urls)('decodes %s with a blank white box', (url) => {
    const img = rasterize(qr.makeQr(qrcode, url), { logo: true });
    expect(decodeRgba(img.data, img.width, img.height).text).toBe(url);
  });

  test.each(urls)('decodes %s with a noisy logo in the box', (url) => {
    const img = rasterize(qr.makeQr(qrcode, url), { logo: true, noise: true });
    expect(decodeRgba(img.data, img.width, img.height).text).toBe(url);
  });

  test('decodes without a logo', () => {
    const img = rasterize(qr.makeQr(qrcode, SAMPLE));
    expect(decodeRgba(img.data, img.width, img.height).text).toBe(SAMPLE);
  });
});

describe('scripts/verify-qr.js', () => {
  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-qr-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writePng(name, img) {
    const png = new PNG({ width: img.width, height: img.height });
    png.data = Buffer.from(img.data.buffer);
    const file = path.join(dir, name);
    fs.writeFileSync(file, PNG.sync.write(png));
    return file;
  }

  test('decodes a PNG and checks the expected text', () => {
    const file = writePng('ok.png', rasterize(qr.makeQr(qrcode, SAMPLE), { logo: true, noise: true }));
    expect(decodePngFile(file).text).toBe(SAMPLE);
    expect(verify([file], SAMPLE)[0]).toMatchObject({ ok: true, decoded: true });
    expect(verify([file], 'https://example.com/other')[0]).toMatchObject({ ok: false, decoded: true });
  });

  test('reports blank images and unreadable files', () => {
    const blank = writePng('blank.png', { data: new Uint8ClampedArray(100 * 100 * 4).fill(255), width: 100, height: 100 });
    expect(verify([blank], SAMPLE)[0]).toMatchObject({ ok: false, decoded: false });
    const junk = path.join(dir, 'junk.png');
    fs.writeFileSync(junk, 'not a png');
    expect(verify([junk])[0].message).toMatch(/could not read PNG/);
  });

  test('parses --expect in both forms', () => {
    expect(parseArgs(['--expect', 'x', 'a.png'])).toEqual({ files: ['a.png'], expect: 'x' });
    expect(parseArgs(['--expect=y', 'a.png', 'b.png'])).toEqual({ files: ['a.png', 'b.png'], expect: 'y' });
  });
});

describe('admin page wiring', () => {
  const ROOT = path.join(__dirname, '..');
  test('CDN qrcode-generator version matches the pinned devDependency', () => {
    const html = fs.readFileSync(path.join(ROOT, 'apps-script/admin/Index.html'), 'utf8');
    const pkg = require('qrcode-generator/package.json');
    expect(html).toContain(`/qrcode-generator/${pkg.version}/qrcode.min.js`);
    expect(html).toMatch(/integrity="sha512-[A-Za-z0-9+/=]+"/);
    expect(html).toContain("include('QrRender')");
    expect(html).toContain("include('PrintStyles')");
  });

  test('print CSS forces exact colors and letter size', () => {
    const css = fs.readFileSync(path.join(ROOT, 'shared/print-sheet.css'), 'utf8');
    expect(css).toMatch(/print-color-adjust:\s*exact/);
    expect(css).toMatch(/@page\s*{\s*size:\s*letter portrait/);
  });

  test('dev harness stays out of deployed folders and uses the real artwork', () => {
    const js = fs.readFileSync(path.join(ROOT, 'dev/print-preview.js'), 'utf8');
    expect(js).toContain('../web/assets/balloon.svg');
    expect(js).toContain('../web/assets/logo.svg');
    for (const dir of ['web', 'apps-script/admin', 'apps-script/endpoint']) {
      expect(fs.readdirSync(path.join(ROOT, dir)).some((f) => /preview/i.test(f))).toBe(false);
    }
  });
});
