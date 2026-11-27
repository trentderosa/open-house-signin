# Open house sign-in

Free open house sign-in system for a RE/MAX agent. Google Apps Script + a
private Google Sheet for storage, and a static guest form on GitHub Pages.
After launch nobody should need code: every changeable value lives in the
Sheet's **Settings** tab.

## Layout

- `apps-script/admin/`: Sheet-bound Apps Script web app ("Only myself"). Add a
  house, show and print its QR code. Scope: `spreadsheets.currentonly` only.
- `apps-script/endpoint/`: standalone Apps Script web app ("Anyone"). `doGet`
  returns public house info, and `doPost` validates and saves a sign-in, then
  sends the agent's alert email and the guest's thank-you (MailApp). The
  Sheet ID is in Script Properties (`SHEET_ID`). UrlFetchApp is used only to
  download the logo/headshot for embedding in emails.
- `web/`: the guest form, served as-is by GitHub Pages (no build step).
  `web/config.js` stays a placeholder in git. `.github/workflows/pages.yml`
  writes it at deploy time from the `ENDPOINT_URL` repository variable, after
  CI passes on main. Brand images are in `web/assets/`.
- `shared/`: the single source for code used in more than one place.
  `npm run sync` copies it into `web/` and `apps-script/*` (browser code for
  the admin page is wrapped into `.html` includes). Never edit the copies.
- `dev/`: print-preview harness for the QR page (not deployed).
- `scripts/`: `sync-shared.js`, `check-secrets.js`, `verify-qr.js`.
- `test/`: Jest. Apps Script files are loaded into one global scope like the
  real runtime (`test/helpers/load.js`) with fakes in `test/helpers/fakes.js`.
- `docs/SETUP.md`: full setup. `docs/HANDOFF.md`: the agent's how-to.

Pure logic stays in plain `.js` files with no `import`/`export` that end with
`if (typeof module !== 'undefined') module.exports = {...}`, so the same file
runs in Apps Script V8, the browser and Jest.

## Commands

- `npm run check`: secret scan, shared-copy check, ESLint, and Jest. CI runs
  this. It must pass before any commit.
- `npm test`, `npm run lint`, `npm run sync`
- `npm run push:admin` / `npm run push:endpoint`: `clasp push` (needs a
  local `.clasp.json`)

## Rules

- **All accounts are the agent's own** (Google, GitHub). Never add other
  editors or collaborators to the Sheet, the scripts, or the repo.
- **The repo is public.** Never commit credentials, `.clasp.json`,
  `.clasprc.json`, Sheet/Script/deployment IDs, emails, phone numbers,
  or personal account names. Private values go in the Settings tab
  or Script Properties. Examples use fake data only (Jane Doe, example.com,
  555-01xx). `scripts/check-secrets.js` enforces this.
- Keep OAuth scopes minimal. `test/repo.test.js` pins them, so a scope change
  needs a deliberate test change and a SETUP.md update.
- Saving a sign-in comes first. Email and image failures must never lose
  or fail a sign-in.
