'use strict';

const js = require('@eslint/js');
const globals = require('globals');

// Apps Script services used by this project (globals in the V8 runtime).
const appsScriptGlobals = {
  CacheService: 'readonly',
  ContentService: 'readonly',
  HtmlService: 'readonly',
  LockService: 'readonly',
  Logger: 'readonly',
  MailApp: 'readonly',
  PropertiesService: 'readonly',
  Session: 'readonly',
  SpreadsheetApp: 'readonly',
  UrlFetchApp: 'readonly',
  Utilities: 'readonly',
  console: 'readonly',
  module: 'readonly'
};

// Top-level functions in Apps Script/browser scripts are entry points or are
// shared across files, so only check unused *local* variables there.
const scriptRules = {
  'no-unused-vars': ['error', { vars: 'local', args: 'after-used' }]
};

module.exports = [
  { ignores: ['node_modules/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['apps-script/**/*.js', 'shared/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: appsScriptGlobals
    },
    rules: scriptRules
  },
  {
    // Browser-side code kept in shared/ (wrapped into the admin page by sync).
    files: ['shared/qr-render.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: { ...globals.browser, module: 'readonly', qrcode: 'readonly' }
    },
    rules: scriptRules
  },
  {
    files: ['web/**/*.js', 'dev/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: { ...globals.browser, module: 'readonly' }
    },
    rules: scriptRules
  },
  {
    files: ['test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.jest }
    }
  },
  {
    // Node-only dev script (writes a local email preview).
    files: ['dev/email-preview.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node
    }
  }
];
