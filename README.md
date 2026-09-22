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

Useful commands on the server: `journalctl -u missing-assignment-slips -f`
for logs, `sudo systemctl restart missing-assignment-slips` to restart.
To update, copy the new files over and re-run the script.

Note: the app has no login. Anyone who can reach the server can generate
slips, so keep it on your school network or behind a VPN unless you add
authentication.
