# Open House Sign-In

Free open house sign-in system: Google Apps Script + Google Sheets, with a
static guest form on GitHub Pages.

- Guests scan a QR code on the sign, fill in a short form on their phone, and
  get a thank-you email with the house details.
- The agent gets a sign-in alert email for every sign-in, and every sign-in
  is saved to her private Google Sheet.
- The agent adds houses and prints QR signs from a private admin page.

Setup: [docs/SETUP.md](docs/SETUP.md). Day-to-day use: [docs/HANDOFF.md](docs/HANDOFF.md).

```sh
npm ci
npm run check   # secret scan + lint + tests
```
