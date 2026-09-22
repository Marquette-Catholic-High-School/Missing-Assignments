# Missing Assignment Slips

A small web app: upload a CSV with student name, teacher, and assignment,
and download one printable PDF with a filled-in slip per row. The slip is
`PDF Slip template.pdf`; only the Name, Name of Teacher, and Name of Missing
Assignment lines are filled. Everything else is left blank.

## Run it

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Then open http://localhost:3000, drop in your CSV, and click
**Create PDF slips**. The PDF downloads automatically.

## CSV format

```csv
name,teacher,assignment
Jane Doe,Mr. Smith,Chapter 4 Vocabulary Worksheet
```

- Column names are matched loosely: `Student Name`, `Name of Teacher`,
  `Missing Assignment`, etc. all work. Order and capitalization don't matter.
- Extra columns are ignored.
- Rows with no name are skipped (the page tells you which ones).
- Long values are shrunk to fit the line, then cut with an ellipsis if still too long.

`sample.csv` in this folder is a working example.

## Google Sheets

Instead of a CSV you can paste a Google Sheets link. The sheet needs the
same three columns. A link that points at a specific tab (`#gid=...`) uses
that tab; otherwise the first tab is used.

- **With Google sign-in on** (see below), any sheet the signed-in person can
  open in Google Sheets works. Nothing needs to be shared publicly.
- **With sign-in off**, the sheet must be shared with **Anyone with the
  link** (Viewer), because the server reads it without signing in. A sheet
  shared this way is readable by anyone with the link.

## Google sign-in

With sign-in on, staff must sign in with their school Google account before
they can use the tool, and their own Google access is used to read sheets.
Setup takes about ten minutes in Google Cloud Console:

1. Go to https://console.cloud.google.com/ signed in as a school Workspace
   admin (or any school account that is allowed to create projects) and
   create a project, for example "Missing Assignment Slips".
2. **APIs & Services -> Library**: search for **Google Sheets API** and
   enable it.
3. **APIs & Services -> OAuth consent screen**: choose **Internal** (only
   accounts in the school's Workspace can sign in), enter the app name and
   a support email, and save.
4. **APIs & Services -> Credentials -> Create credentials -> OAuth client
   ID**: application type **Web application**. Under *Authorized redirect
   URIs* add `https://YOUR-ADDRESS/auth/google/callback` (for local testing
   also `http://localhost:3000/auth/google/callback`). Save and copy the
   client ID and client secret.
5. Copy `.env.example` to `.env` next to `server.js` and fill in
   `BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_DOMAIN`
   (the school email domain) and a random `SESSION_SECRET`.
6. Restart the app.

If the consent screen is set to **External** instead of Internal, Google
shows an "unverified app" warning until the app is verified; keep
`ALLOWED_DOMAIN` set so outside accounts are still rejected.

Sign-in uses the standard Google OAuth flow. The app only asks for the
person's email and name and read-only access to Google Sheets. Sessions
last 12 hours (`SESSION_HOURS`) and are stored in a signed cookie.

To run without sign-in, leave `GOOGLE_CLIENT_ID` blank.

## Page layout

Choose on the upload page how slips are arranged for printing:

- **Three per page** (default): portrait letter paper, three full-size slips
  stacked with dashed cut lines. The empty band above "Name:" on the
  original slip is trimmed so three fit; nothing printed is removed.
- **Two per page**: letter paper, two untrimmed half-sheet slips, cut once.
- **One per page**: half-sheet pages exactly like the template.

Print at 100% (not "fit to page") so the slips come out the right size.

## The "submitted to" name

The bottom of the slip says who the form must be handed in to. That name
is typed on the upload page (it defaults to "Mrs. Maag" and remembers the
last value you used in your browser). To change the default for everyone,
set the `SUBMIT_TO` environment variable, for example
`SUBMIT_TO="Mr. Jones" npm start`. The rest of the sentence lives in
`server.js` as `FOOTNOTE_TEXT` if the wording ever needs to change.

## Adjusting where text lands

The positions are in `server.js` under `FIELDS`, in PDF points measured on the
upright page (612 x 396 for this template, origin at the bottom-left). Change
`x`, `y`, or `maxWidth` there and restart the server.

To use a different template, replace `PDF Slip template.pdf` or set the
`TEMPLATE_PATH` environment variable, then update `FIELDS` to match.

## Options

- `PORT` – port to listen on (default 3000).
- `TEMPLATE_PATH` – path to the slip PDF (default: the template in this folder).
- `SUBMIT_TO` – default name in the bottom sentence (default: Mrs. Maag).
- `BASE_URL` – public address of the app, used for the Google redirect.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` – turn on Google sign-in.
- `ALLOWED_DOMAIN` – only accounts on this email domain may sign in.
- `SESSION_SECRET` – random string that signs session cookies.
- `SESSION_HOURS` – how long a sign-in lasts (default 12).

All of these can go in a `.env` file next to `server.js` (see
`.env.example`).

## Deploy to an Ubuntu server

`install.sh` sets up a fresh Ubuntu 22.04 or 24.04 server: Node.js 22,
the app as a systemd service, and nginx in front on port 80.

1. Copy this folder to the server (from your Mac):

   ```bash
   rsync -av --exclude node_modules "/Users/jonpodner/Downloads/Missing Assignment/" user@SERVER_IP:~/missing-assignment/
   ```

2. On the server:

   ```bash
   cd ~/missing-assignment && sudo bash install.sh
   ```

3. Open `http://SERVER_IP` in a browser.

For HTTPS, point a domain at the server first, then run
`sudo DOMAIN=slips.example.org EMAIL=you@example.org bash install.sh`.

If a `.env` file is in the folder when you run the script, it is installed
with the app (readable only by the service user). For Google sign-in the
`BASE_URL` in it must match the address people use, e.g.
`https://slips.example.org`. To change settings later, edit
`/opt/missing-assignment-slips/.env` and run
`sudo systemctl restart missing-assignment-slips`.

Useful commands on the server: `journalctl -u missing-assignment-slips -f`
for logs, `sudo systemctl restart missing-assignment-slips` to restart.
To update, copy the new files over and re-run the script.

Note: without Google sign-in configured the app has no login, and anyone
who can reach the server can generate slips. Set up sign-in (above) before
exposing it to the internet.
