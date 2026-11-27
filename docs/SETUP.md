# Setup guide

This guide sets up the open house sign-in system from scratch. Everything ends
up owned by **the agent's** accounts: her Google account and her GitHub account.
The person doing setup (called "you" here) borrows those accounts on their own
Mac for an afternoon, then removes every credential at the end.

All examples use obviously fake data (Jane Doe, `jane@example.com`,
555-01xx phone numbers). Placeholders look like `<github-username>` and
`<repo>`. Swap in the real values as you go, but **never commit real private
values to the repo**. The repo will be public.

---

## 0. What you are building

```
Guest's phone                         The agent's Google account
-------------                         ------------------------------------
Scans QR on the sign
   |
   v
Guest form (GitHub Pages) --fetch-->  Endpoint (Apps Script web app, "Anyone")
https://<github-username>.github.io/<repo>/?h=<house id>
                                         |-- reads/writes the private Google Sheet
                                         |-- emails the agent (MailApp)
                                         '-- emails the guest a thank-you

The agent's phone/laptop
   '-- Admin page (Apps Script web app, "Only myself", bound to the Sheet)
         add a house -> QR code -> print
```

| Piece | Where it lives | Who can open it |
|---|---|---|
| Google Sheet (Houses, SignIns, Settings tabs) | The agent's Google Drive | Only the agent |
| Admin project | Bound to the Sheet | Only the agent |
| Endpoint project | Standalone script in her Drive | Anyone can call it, but it only accepts sign-ins and returns public house info |
| Guest form | `web/` folder, served by GitHub Pages | Public |

It is all free. Nothing needs a server or a build step.

### Values that are private (never in the repo)

| Value | Where it goes |
|---|---|
| Sheet ID | Endpoint Script Properties (`SHEET_ID`) |
| Her name, phone, email, website, image links | The Sheet's **Settings** tab |
| Script IDs | Local `.clasp.json` files (gitignored) |
| clasp login token | `~/.clasprc.json` on your Mac (deleted at the end) |
| Endpoint URL | GitHub repository **variable** `ENDPOINT_URL` (step 9) |

`web/config.js` stays a placeholder in git. The Pages workflow writes the real
endpoint URL into it at deploy time from the `ENDPOINT_URL` repository
variable. (The URL isn't really secret, since every guest's browser calls it,
but keeping it out of git keeps the repo owner-neutral.)

---

## 1. Before you start

- [ ] A separate browser profile on your Mac signed into **only** the agent's
      Google account. (Apps Script web apps get confused when several Google
      accounts are signed in at once.)
- [ ] Node.js 22 installed (`node -v`).
- [ ] This repo cloned locally, and dependencies installed:

  ```sh
  npm ci
  npm run check
  ```

  `npm run check` runs the secret scan, the shared-file check, ESLint and
  Jest. It must pass before every push.

clasp (Google's Apps Script command-line tool) is a dev dependency of this
repo, so `npx clasp ...` runs the pinned version. Nothing is installed
globally.

---

## 2. Google: create the Sheet and log in clasp

1. In the agent's browser profile, go to <https://sheets.google.com> and create a
   blank spreadsheet. Name it **Open House Sign-ins**.
2. Turn on the Apps Script API for her account:
   <https://script.google.com/home/usersettings> -> **Google Apps Script API**
   -> **On**.
3. Log clasp in **as the agent**. In Terminal, from the repo folder:

   ```sh
   npx clasp login
   ```

   A browser tab opens. Make sure it is the agent's profile/account, then click
   **Allow**. This saves a login token to `~/.clasprc.json` on your Mac. You
   will delete it in step 16.

---

## 3. Admin project (bound to the Sheet)

1. In the Sheet: **Extensions -> Apps Script**. A new script project opens.
2. Rename it (top left) to **Open House Admin**.
3. Click the gear icon (**Project Settings**). Copy the **Script ID**.
4. Still in Project Settings, tick **Show "appsscript.json" manifest file in
   editor** (so you can see the scopes later).
5. In Terminal:

   ```sh
   cd apps-script/admin
   cp .clasp.json.example .clasp.json
   # edit .clasp.json and replace PASTE_SCRIPT_ID_HERE with the Script ID
   npx clasp push --force
   cd ../..
   ```

   `.clasp.json` is gitignored. Don't commit it. (`npm run check` fails if
   you try.)
6. Back in the Apps Script editor, reload the page. You should see `Code.gs`,
   `AdminLib.gs`, `sheet-core.gs`, `Index.html`, `Styles.html`, `Client.html`,
   `QrRender.html`, `PrintStyles.html`.
7. Pick the `setup` function in the toolbar dropdown and click **Run**.
8. Approve the permissions (see "The unverified app screen" below).
9. Check the Execution log. It should say it created the **Houses**,
   **SignIns** and **Settings** tabs. Look at the Sheet: the three tabs are there.

**Permissions the admin project asks for:**

| Google's wording | Scope | Why |
|---|---|---|
| View and manage spreadsheets that this application has been installed in | `spreadsheets.currentonly` | Read and add houses in **this one Sheet only**. It can't see any other file. |

It does not ask for Gmail, Drive or anything else.

### The unverified app screen

The first time you run a function, Google shows **"Google hasn't verified this
app"**. That is expected: this is the agent's own private script, not an app
published to the public, so Google never reviewed it. To continue:

1. Click **Advanced** (small link, bottom left).
2. Click **Go to Open House Admin (unsafe)** (or the endpoint's name).
3. Review the list of permissions and click **Allow**.

It's safe because the agent is both the developer and the only user. If the
screen lists permissions that don't match the tables in this guide, stop and
check the code.

---

## 4. Endpoint project (standalone)

1. Go to <https://script.google.com> -> **New project**.
2. Rename it to **Open House Endpoint**.
3. **Project Settings** (gear) -> copy the **Script ID**. Also tick **Show
   "appsscript.json" manifest file in editor**.
4. In Terminal:

   ```sh
   cd apps-script/endpoint
   cp .clasp.json.example .clasp.json
   # edit .clasp.json and paste the endpoint Script ID
   npx clasp push --force
   cd ../..
   ```

5. Tell the endpoint which Sheet to use. Copy the Sheet's URL from the browser
   address bar. In the endpoint editor: **Project Settings -> Script Properties
   -> Add script property**. Property `SHEET_ID`, value is the Sheet URL or just
   the ID (the long part between `/d/` and `/edit`). Click **Save**.
6. Reload the editor, choose `setup` in the function dropdown, click **Run**,
   and approve the permissions (same unverified screen as above).
7. The log should say `Connected to Sheet: Open House Sign-ins` and that each
   tab "looks good".

**Permissions the endpoint asks for:**

| Google's wording | Scope | Why |
|---|---|---|
| See, edit, create and delete all your Google Sheets spreadsheets | `spreadsheets` | A standalone script has no "this one Sheet only" option, so this is the narrowest scope that can open the Sheet by its ID. The code only ever opens the one Sheet saved in `SHEET_ID`. |
| Send email as you | `script.send_mail` | Sends the sign-in email to the agent and the thank-you to the guest, from her Gmail. It uses MailApp, which can only *send*. It can't read her inbox (Gmail scopes can). |
| Connect to an external service | `script.external_request` | Downloads the agent's logo and headshot from the GitHub Pages site to embed them in thank-you emails (`logo_url` / `headshot_url`). It's used for nothing else. |
| See your primary Google Account email address | `userinfo.email` | Finds the agent's address so sign-in emails reach her when `notify_email` is blank, and so guests' replies go to her. |

---

## 5. Deploy both web apps

Do this in each project's editor: **Deploy -> New deployment -> gear icon ->
Web app**.

| Project | Description | Execute as | Who has access |
|---|---|---|---|
| Open House Admin | `v1` | **Me** | **Only myself** |
| Open House Endpoint | `v1` | **Me** | **Anyone** |

Click **Deploy** and copy the **Web app URL** (ends in `/exec`).

- **Admin URL:** The agent bookmarks this on her phone and laptop. It only
  works when she is signed in to her Google account.
- **Endpoint URL:** goes into the `ENDPOINT_URL` repository variable on
  GitHub (step 9). Don't put it in `web/config.js`.

> **Updating later without changing the URL:** after pushing new code, use
> **Deploy -> Manage deployments -> pencil icon -> Version: New version ->
> Deploy**. Do **not** click "New deployment" again, because that makes a new URL
> and the guest form would keep calling the old one.

---

## 6. Build the GitHub repo

The repo is built under whichever GitHub account is doing setup, as a
**private** repo, then transferred to the agent before it goes public (step 8).

1. Create an empty **private** repo on GitHub (no README, no .gitignore).
2. Run the checks and push. Leave `web/config.js` as the placeholder: the
   endpoint URL goes into a repository variable later (step 9).

   ```sh
   npm run check
   git status   # no .clasp.json, no .env
   git remote add origin https://github.com/<github-username>/<repo>.git
   git push -u origin main
   ```

CI (`.github/workflows/ci.yml`) runs on every push and pull request. It works
fine on a private repo on the free plan (private repos get free Actions
minutes, and this check takes about a minute). The Pages workflow skips
itself while the repo is private.

---

## 7. Before making the repo public

Run through this checklist **before** step 8 and again before step 9:

- [ ] `npm run check` passes. It includes `scripts/check-secrets.js`, which scans
      every file git would publish for real emails, real phone numbers, Sheet
      and Script IDs, tokens, private keys, account names, and `.clasp.json` /
      `.clasprc.json`.
- [ ] Review the full history, not just the latest files, because a value removed in a
      later commit is still public in the history:

  ```sh
  git log -p | less
  ```

  Look for anything private: emails, phone numbers, Sheet links,
  Script IDs, tokens. If you find one, **don't** make the repo public. Rewrite
  the history first (or start a fresh repo from a clean copy).
- [ ] `git ls-files | grep -i clasp` shows only `.clasp.json.example` and
      `.claspignore` files.
- [ ] No GitHub Actions secrets are set (Settings -> Secrets and variables ->
      Actions). None are needed.

---

## 8. Transfer the repo to the agent

1. Repo **Settings -> General -> Danger Zone -> Transfer**. Enter the agent's
   GitHub username. She gets an email and must **accept** the transfer.
2. (After the checklist in step 7.) Make the repo public: **Settings -> Danger
   Zone -> Change visibility -> Public**. Then turn on Pages (step 9).
3. On your Mac, point the local clone at the new home:

   ```sh
   git remote set-url origin https://github.com/<her-username>/<repo>.git
   ```

4. If the previous owner shows up under **Settings -> Collaborators**, remove
   them. The agent should be the only person with access.
5. Heads-up: Actions secrets don't carry over in a transfer. This project has
   none, so nothing to redo.

---

## 9. Turn on GitHub Pages (public repo)

1. Repo **Settings -> Pages -> Build and deployment -> Source: GitHub
   Actions**.
2. Repo **Settings -> Secrets and variables -> Actions -> Variables** tab ->
   **New repository variable**:
   - Name: `ENDPOINT_URL`
   - Value: the endpoint's Web app URL from step 5,
     `https://script.google.com/macros/s/<deployment-id>/exec`

   Use **Variables**, not Secrets. The deploy stops with a clear message if
   it's missing or doesn't look like that.
3. **Actions** tab -> **Deploy guest form to GitHub Pages** -> **Run
   workflow** (branch `main`). After this, every change merged to `main`
   deploys automatically once CI passes.
4. When it finishes, the guest form is live at:

   ```
   https://<her-username>.github.io/<repo>/
   ```

   Opening that address with no `?h=` shows "This sign-in link isn't valid".
   That is correct.

The workflow writes `web/config.js` from the variable, then uploads the `web/`
folder as-is. There's no build step. Security
rules (Content Security Policy, no-referrer) are `<meta>` tags in
`web/index.html`, because GitHub Pages can't send custom headers.

---

## 10. Fill in the Settings tab

Open the Sheet -> **Settings** tab. Fill in column B. Column C explains each
row in plain English.

| key | Example (fake) | Notes |
|---|---|---|
| `website_url` | `https://www.example.com` | Where guests go after signing in. Blank shows a thank-you screen instead. |
| `guest_form_url` | `https://<her-username>.github.io/<repo>/` | **Required for QR codes.** The admin page refuses to make QR codes until this is set. |
| `agent_name` | `Jane Doe` | Shown in the thank-you email and as the email sender name. |
| `agent_phone` | `555-555-0100` | Thank-you email signature. |
| `office_name` | `Example Realty` | Office name for the email signature. |
| `logo_url` | blank | Email signature logo. Blank = `assets/logo.png` on the guest form site. See step 11. |
| `headshot_url` | blank | Round photo in the email signature. Blank = `assets/headshot.jpg` on the guest form site. |
| `qr_logo_url` | blank | Image in the center of printed QR codes. Blank = `assets/balloon.svg` on the guest form site. |
| `print_logo_url` | blank | Logo printed under the QR code. Blank = `assets/logo.svg` on the guest form site. |
| `notify_email` | blank | Blank means "send to the Google account's Gmail". Separate several addresses with commas. |

Changes take effect immediately. No redeploy is needed.

---

## 11. Logo and headshot images

The brand images live in `web/assets/` and GitHub Pages serves them with the
guest form. **Once `guest_form_url` is set, the four image settings fill
themselves in.** Leave them blank and the system uses these files on the
guest form site, e.g. `https://<her-username>.github.io/<repo>/assets/logo.png`:

| File | Used for | Setting that overrides it |
|---|---|---|
| `web/assets/logo.svg` | Guest form header; printed under the QR code (about 3.75 in wide) | `print_logo_url` |
| `web/assets/balloon.svg` | Center of the printed QR code | `qr_logo_url` |
| `web/assets/logo.png` | Thank-you email signature | `logo_url` |
| `web/assets/headshot.jpg` | Round photo in the thank-you email signature (square image) | `headshot_url` |

To change an image, replace the file with one of the **same name and type**,
commit, and push to `main`. Or upload it somewhere else and put its
`https://` link in the matching setting. A filled-in setting always wins.

**About email images.** Outlook and some other mail apps hide images linked
from the web until the reader clicks "show images". So the endpoint downloads
the logo and headshot and **embeds** them in the thank-you email. Rules:

- PNG, JPG or GIF only, under **500 KB**. **SVG is skipped** because many email
  apps can't show it. That's why the email uses `logo.png`, not `logo.svg`.
- Images under about 75 KB are cached for 6 hours, so most sign-ins don't
  download them again. Bigger images are downloaded for each email, which is
  fine but slightly slower.
- If an image can't be downloaded or isn't allowed, the email goes out without
  it. A sign-in never fails because of an image.
- Outlook on Windows shows the round headshot as a square. That's normal.

**Printed QR code.** The balloon sits in a small white box in the middle of
the QR code (about 20% of its width). QR codes use the highest error
correction level (H), so they scan fine with it there. The REMAX logo prints
underneath. Nothing else is on the page.

## 12. Sign-in alert emails

Every sign-in sends the agent an email with the subject
**`Open House Sign-in: <guest name> — <address>`** and all of the guest's
answers. It goes to the Google account's Gmail, or to `notify_email` if that
is set. Reply to it to write straight back to the guest.

To check it works: in the endpoint editor, choose `sendTestEmail` and click
**Run**. A test email arrives within a minute.

There is nothing to turn on. To send the alerts somewhere else, change
`notify_email` in the Settings tab.

### Optional tip: a label and phone notifications

1. In Gmail (the agent's account), search: `subject:"Open House Sign-in:"`
2. Click the filter icon in the search bar -> **Create filter** -> tick:
   - **Apply the label** -> New label -> `Open House`
   - **Never send it to Spam**
   - **Always mark it as important**
3. **Create filter**.
4. Phone notifications:
   - **Android Gmail app:** Settings -> her account -> **Manage labels** ->
     `Open House` -> **Label notifications** on, **Notify for every message**.
   - **iPhone Gmail app:** Settings -> her account -> **Notifications** -> **High
     priority only** works because the filter marks these important. Choose
     **All new mail** if she prefers.

### Email quota

A consumer Gmail account can send to about **100 recipients per day** from
Apps Script. Each sign-in uses up to **2** (the alert to the agent and the
thank-you to the guest), so about 50 sign-ins a day. To protect the agent's
alerts:

- A guest who signs in twice at the same house within 6 hours gets one thank-you.
- At most 10 thank-you emails per house per hour.
- When fewer than 20 emails are left for the day, thank-you emails stop and
  only the agent's alerts are sent.

If the quota runs out completely, sign-ins are **still saved** in the Sheet.
Only the emails are skipped until the next day.

---

## 13. End-to-end test (fake house, fake guest)

1. Open the **admin URL**. Add a house:
   - Address: `123 Test Lane`
   - Price: `450000`, Beds `3`, Baths `2`, Sq ft `1800`
   - Description: `Test listing, please ignore.`
   - Listing link: `https://www.example.com`
2. A QR code appears. Click **Print QR**. The preview should show only a large
   dark-blue QR code on letter paper with the balloon in its center, and the
   REMAX logo underneath.
   Print it or save it as a PDF. In the print dialog, turn off "Headers and
   footers".
3. Scan the QR with a phone. The guest form opens and shows "123 Test Lane" with
   3 bd / 2 ba / 1800 sq ft.
4. Sign in as:
   - Name `Jane Doe`, Phone `555-555-0123`, Email: an inbox you can check
     (for the test only, use the agent's own address with `+test` added, for example
     `name+test@` her domain).
   - Pick a few answers, type a comment.
5. Check:
   - [ ] The phone shows "Thanks, Jane." and then goes to `website_url` (if set).
   - [ ] A new row in the **SignIns** tab.
   - [ ] The agent gets "Open House Sign-in: Jane Doe — 123 Test Lane".
   - [ ] The guest inbox gets the thank-you with the house details, the
         signature (headshot and logo show without clicking "show images"),
         and a "Learn more about me" button if `website_url` is set.
6. Try the error paths:
   - [ ] Submit with no phone, then with a phone of `555-0123`. You should see friendly inline errors.
   - [ ] Open the guest URL with `?h=abc`. You should see "This sign-in link isn't valid".
7. Clean up: delete the test rows from **SignIns** and **Houses** (or untick
   the house's `active` checkbox so its QR stops working).

---

## 14. Updating the code later

```sh
# edit files; if you changed anything in shared/, copy it into place:
npm run sync
npm run check
npm run push:admin      # or: npm run push:endpoint
```

Then in that project's editor: **Deploy -> Manage deployments -> edit -> New
version** (keeps the same URL). Guest form changes deploy automatically when
pushed to `main`.

This needs clasp logged in as the agent again (`npx clasp login`). Remove the
credentials afterwards (step 16).

---

## 15. Developer tools for the QR code (optional)

`dev/print-preview.html` renders the printable QR page with the same code
the admin page uses, a sample guest link, and the real artwork from
`web/assets/`. It is not deployed. After `npm ci`, open it in a browser (add `?logo=0` for the
plain QR code, `?brand=0` to hide the logo underneath, or `?url=...` to
encode something else). To check that
screenshots of it scan:

```sh
node scripts/verify-qr.js --expect "https://example.github.io/open-house-signin/?h=0123456789abcdef" shot.png
```

## 16. Remove credentials from your Mac

When setup is done, nothing of the agent's should stay on your computer.

1. **clasp login token:**

   ```sh
   rm -f ~/.clasprc.json
   rm -f apps-script/admin/.clasp.json apps-script/endpoint/.clasp.json
   ```

2. **Revoke clasp's Google access:** in the agent's browser go to
   <https://myaccount.google.com/connections> -> **clasp - The Apps Script CLI**
   -> **Delete all connections**. (Her own Apps Script projects keep
   working. They have their own approvals.)
3. **GitHub CLI**, if you signed in as her:

   ```sh
   gh auth status
   gh auth logout --hostname github.com --user <her-username>
   ```

4. **Git credentials in the macOS Keychain:** open **Keychain Access**,
   search `github.com`, and delete any entry for her account.
5. **Browsers:** sign her out of Google and GitHub in every browser and profile
   you used, then delete the browser profile you made in step 1.
6. Confirm the repo's **Settings -> Collaborators** lists only the agent.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Admin page says "Sorry, unable to open the file" | Several Google accounts are signed in. Open the admin URL in a profile/incognito window signed into only the agent's account. |
| Admin page says QR codes are turned off | Fill in `guest_form_url` in the Settings tab (must start with `https://`). |
| Guest form says "Sign-in isn't set up yet" | The deployed `config.js` still has the placeholder. Check the `ENDPOINT_URL` repository variable, then re-run the Pages workflow. |
| Pages workflow fails at "Write web/config.js" | The `ENDPOINT_URL` variable is missing or isn't a `https://script.google.com/macros/s/.../exec` URL. |
| Guest form says "We couldn't load this open house" | Endpoint deployment access isn't **Anyone**, or the endpoint URL is wrong, or `SHEET_ID` isn't set (run `setup` in the endpoint). Check the endpoint's **Executions** page for errors. |
| A QR code stopped working | That house's `active` box is unticked in the **Houses** tab. |
| No emails | Check the endpoint **Executions** log. The daily quota may be used up. |
| Logo or headshot missing from the email | The Executions log says why ("Skipping logo image ..."). Usually it's SVG, over 500 KB, or a wrong URL. |
| Pushed code but nothing changed | You need **Manage deployments -> New version** after `clasp push`. |
