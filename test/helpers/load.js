'use strict';

/*
 * Apps Script puts every file's top-level functions in one shared global
 * scope. To mimic that, require each file and copy its exports onto Jest's
 * global object, in the order given.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function loadGas(relPaths) {
  const merged = {};
  for (const rel of relPaths) {
    const mod = require(path.join(ROOT, rel));
    Object.assign(global, mod);
    Object.assign(merged, mod);
  }
  return merged;
}

module.exports = { loadGas, ROOT };
