'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const cookieSession = require('cookie-session');
const { parse } = require('csv-parse/sync');
const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');

// Load settings from a .env file next to this script, if there is one.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env, use the environment */ }

const PORT = process.env.PORT || 3000;
const TEMPLATE_PATH = process.env.TEMPLATE_PATH || path.join(__dirname, 'PDF Slip template.pdf');
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

// Google sign-in. When GOOGLE_CLIENT_ID is set, everyone must sign in and
// sheets are read with the signed-in user's own Google access. When it is
// not set, the app is open and only publicly shared sheets can be read.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || '').trim().toLowerCase().replace(/^@/, '');
const AUTH_ENABLED = Boolean(GOOGLE_CLIENT_ID);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);

// Google endpoints (overridable so tests can point at a stand-in server).
const OAUTH_AUTH_URL = process.env.OAUTH_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = process.env.OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const OAUTH_USERINFO_URL = process.env.OAUTH_USERINFO_URL || 'https://www.googleapis.com/oauth2/v3/userinfo';
const SHEETS_API_URL = process.env.SHEETS_API_URL || 'https://sheets.googleapis.com';
const SHEETS_BASE_URL = process.env.SHEETS_BASE_URL || 'https://docs.google.com';
const OAUTH_SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/spreadsheets.readonly'];

// Where each value is written on the slip, in PDF points measured on the
// upright page (origin bottom-left, 612 x 396 for this template).
// x = start of the blank underline, y = baseline just above the underline,
// maxWidth = length of the underline (text is shrunk to fit, then truncated).
const FIELDS = {
  name:       { x: 106, y: 203.5, maxWidth: 174 },
  teacher:    { x: 158, y: 181,   maxWidth: 122 },
  assignment: { x: 215, y: 157.5, maxWidth: 305 },
};
const FONT_SIZE = 12;
const MIN_FONT_SIZE = 7;

// The bottom sentence on the scanned slip names the person slips go to.
// It is covered with a white box and redrawn so that name can change.
const SUBMIT_TO_DEFAULT = (process.env.SUBMIT_TO || 'Mrs. Maag').trim();
const FOOTNOTE_TEXT = '**If this assignment has not been cleared on FACTS and/or this form has not been '
  + 'submitted to {name} by Thursday, you will receive a detention on Friday of this week.';
const FOOTNOTE = {
  cover: { x: 66, y: 39, width: 466, height: 33 }, // white box over the scanned sentence
  x: 69.5,          // left edge of the redrawn text
  firstBaseline: 60.5,
  lineHeight: 15,
  maxWidth: 450,
  fontSize: 11.5,
  maxLines: 2,
};

// Page layouts. The slip is a landscape half-sheet (612 x 396 pt). Several
// slips can be stacked on one portrait letter page (612 x 792 pt) to be cut
// apart after printing. With three per page the empty band above "Name:" is
// trimmed (slips are kept at full size, only the blank top is removed).
const LETTER = { width: 612, height: 792 };
const LAYOUTS = {
  1: { perPage: 1, cropHeight: null },
  2: { perPage: 2, cropHeight: null },
  3: { perPage: 3, cropHeight: 246 },
};
const DEFAULT_LAYOUT = 3;

// Accepted spreadsheet header spellings for each field (compared lower-cased,
// trimmed, with punctuation/underscores removed).
const HEADER_ALIASES = {
  name:       ['name', 'student', 'studentname', 'student name'],
  teacher:    ['teacher', 'teachername', 'teacher name', 'nameofteacher', 'name of teacher'],
  assignment: ['assignment', 'assignmentname', 'assignment name', 'missingassignment',
               'missing assignment', 'nameofmissingassignment', 'name of missing assignment'],
};

// ---------------------------------------------------------------------------
// Template handling
// ---------------------------------------------------------------------------

/**
 * Load the template and flatten any /Rotate so the page is stored upright.
 * The scanned template is stored upside down with /Rotate 180; drawing onto
 * a normalized copy means the field coordinates above are plain upright
 * coordinates regardless of how the original was scanned.
 */
async function loadNormalizedTemplate() {
  const bytes = fs.readFileSync(TEMPLATE_PATH);
  const src = await PDFDocument.load(bytes);
  const [srcPage] = src.getPages();
  const rotation = ((srcPage.getRotation().angle % 360) + 360) % 360;

  if (rotation === 0) return bytes;

  const { width, height } = srcPage.getSize();
  const out = await PDFDocument.create();
  const embedded = await out.embedPage(srcPage);

  let pageW = width, pageH = height, x = 0, y = 0;
  if (rotation === 180) { x = width; y = height; }
  else if (rotation === 90) { pageW = height; pageH = width; x = height; y = 0; }
  else if (rotation === 270) { pageW = height; pageH = width; x = 0; y = width; }
  else throw new Error(`Unsupported page rotation: ${rotation}`);

  const page = out.addPage([pageW, pageH]);
  page.drawPage(embedded, { x, y, rotate: degrees(-rotation) });
  return await out.save();
}

const templateBytesPromise = loadNormalizedTemplate();

// ---------------------------------------------------------------------------
// Spreadsheet rows -> slip data
// ---------------------------------------------------------------------------

function normalizeHeader(h) {
  return String(h || '')
    .replace(/^﻿/, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapHeaders(headers) {
  const map = {};
  for (const field of Object.keys(HEADER_ALIASES)) {
    const idx = headers.findIndex((h) => {
      const n = normalizeHeader(h);
      return HEADER_ALIASES[field].some((a) => a.replace(/\s+/g, '') === n.replace(/\s+/g, ''));
    });
    if (idx === -1) return { error: `The spreadsheet is missing a "${field}" column. Found columns: ${headers.join(', ') || '(none)'}` };
    map[field] = headers[idx];
  }
  return { map };
}

/** records: array of objects keyed by header text. */
function rowsFromRecords(records) {
  if (records.length === 0) return { error: 'The spreadsheet has no data rows.' };

  const headers = Object.keys(records[0]);
  const { map, error } = mapHeaders(headers);
  if (error) return { error };

  const rows = [];
  const skipped = [];
  records.forEach((r, i) => {
    const row = {
      name: String(r[map.name] ?? '').trim(),
      teacher: String(r[map.teacher] ?? '').trim(),
      assignment: String(r[map.assignment] ?? '').trim(),
    };
    if (!row.name && !row.teacher && !row.assignment) return; // blank line
    if (!row.name) { skipped.push(i + 2); return; }           // +2: header + 1-based
    rows.push(row);
  });
  if (rows.length === 0) return { error: 'No usable rows: every row is missing a name.' };
  return { rows, skipped };
}

function parseCsv(buffer) {
  let records;
  try {
    records = parse(buffer, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } catch (err) {
    return { error: `Could not read the CSV: ${err.message}` };
  }
  return rowsFromRecords(records);
}

/** values: array of arrays from the Sheets API (first row = headers). */
function parseSheetValues(values) {
  if (!Array.isArray(values) || values.length === 0) return { error: 'The sheet is empty.' };
  const headers = values[0].map((h) => String(h ?? '').trim());
  const records = values.slice(1).map((cells) => {
    const rec = {};
    headers.forEach((h, i) => { if (h) rec[h] = cells[i] ?? ''; });
    return rec;
  });
  // Keep header order even when the first data row is sparse.
  if (records.length === 0) return { error: 'The sheet has no data rows.' };
  const first = {};
  headers.forEach((h) => { if (h) first[h] = records[0][h] ?? ''; });
  records[0] = first;
  return rowsFromRecords(records);
}

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

const SHEET_FETCH_TIMEOUT_MS = 20000;
const SHEET_MAX_BYTES = 5 * 1024 * 1024;

/** Pull the spreadsheet id, tab gid, and link type out of a Google Sheets link. */
function parseSheetLink(link) {
  let url;
  try { url = new URL(String(link).trim()); } catch { return null; }
  if (!/(^|\.)docs\.google\.com$/.test(url.hostname)) return null;

  const gid = url.searchParams.get('gid') || (url.hash.match(/gid=(\d+)/) || [])[1] || null;
  const published = url.pathname.match(/^\/spreadsheets\/d\/e\/([\w-]+)/);
  if (published) return { id: published[1], gid, published: true };
  const normal = url.pathname.match(/^\/spreadsheets\/d\/([\w-]+)/);
  if (normal) return { id: normal[1], gid, published: false };
  return null;
}

const NOT_A_SHEET = 'That does not look like a Google Sheets link. Copy the address from your browser while the sheet is open.';
const SHARE_HELP = 'Google would not let us read this sheet. In Google Sheets click Share, set '
  + '"General access" to "Anyone with the link" (Viewer), then try again.';

/** Public export (no sign-in): the sheet must be shared with anyone with the link. */
async function fetchSheetPublic(ref) {
  const gid = ref.gid || '0';
  const csvUrl = ref.published
    ? `${SHEETS_BASE_URL}/spreadsheets/d/e/${ref.id}/pub?output=csv&gid=${gid}`
    : `${SHEETS_BASE_URL}/spreadsheets/d/${ref.id}/export?format=csv&gid=${gid}`;

  let res;
  try {
    res = await fetch(csvUrl, { redirect: 'follow', signal: AbortSignal.timeout(SHEET_FETCH_TIMEOUT_MS) });
  } catch (err) {
    return { error: `Could not reach Google Sheets (${err.name === 'TimeoutError' ? 'timed out' : err.message}).` };
  }
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (res.status === 404) return { error: 'Google Sheets reports that this sheet does not exist. Check the link.' };
  if (!res.ok || !type.includes('text/csv')) return { error: SHARE_HELP };
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > SHEET_MAX_BYTES) return { error: 'This sheet is too large (over 5 MB).' };
  return parseCsv(buffer);
}

/** Sheets API with the signed-in user's access token: works for any sheet they can open. */
async function fetchSheetAsUser(ref, accessToken, email) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const get = async (url) => {
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(SHEET_FETCH_TIMEOUT_MS) });
    } catch (err) {
      return { error: `Could not reach Google Sheets (${err.name === 'TimeoutError' ? 'timed out' : err.message}).` };
    }
    if (res.status === 401) return { error: 'Your Google sign-in has expired. Please sign in again.', status: 401, tokenRejected: true };
    if (res.status === 403) return { error: `${email} does not have access to this sheet. Ask the owner to share it with you, or open it in Google Sheets to confirm you can see it.` };
    if (res.status === 404) return { error: 'Google Sheets reports that this sheet does not exist. Check the link.' };
    if (!res.ok) return { error: `Google Sheets returned an error (${res.status}).` };
    return { data: await res.json() };
  };

  const base = `${SHEETS_API_URL}/v4/spreadsheets/${encodeURIComponent(ref.id)}`;
  const meta = await get(`${base}?fields=sheets.properties(sheetId,title)`);
  if (meta.error) return meta;
  const sheets = (meta.data.sheets || []).map((s) => s.properties);
  if (sheets.length === 0) return { error: 'The spreadsheet has no tabs.' };
  const tab = (ref.gid && sheets.find((s) => String(s.sheetId) === String(ref.gid))) || sheets[0];

  const range = encodeURIComponent(`'${tab.title.replace(/'/g, "''")}'`);
  const values = await get(`${base}/values/${range}?majorDimension=ROWS`);
  if (values.error) return values;
  return parseSheetValues(values.data.values);
}

async function fetchSheet(link, session) {
  const ref = parseSheetLink(link);
  if (!ref) return { error: NOT_A_SHEET };
  // Published ("publish to the web") ids are not spreadsheet ids; they are
  // public by definition, so always use the public export for them.
  if (session && session.user && !ref.published) {
    let token = await getAccessToken(session);
    if (token.error) return token;
    let result = await fetchSheetAsUser(ref, token.accessToken, session.user.email);
    if (result.tokenRejected) {
      // Google no longer accepts the access token (revoked or expired early):
      // get a fresh one with the refresh token and try once more.
      token = await getAccessToken(session, true);
      if (token.error) return token;
      result = await fetchSheetAsUser(ref, token.accessToken, session.user.email);
    }
    return result;
  }
  return fetchSheetPublic(ref);
}

// ---------------------------------------------------------------------------
// Google sign-in (OAuth 2.0 authorization code flow with PKCE)
// ---------------------------------------------------------------------------

const REDIRECT_URI = `${BASE_URL}/auth/google/callback`;

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function tokenRequest(params) {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, ...params }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `token endpoint returned ${res.status}`);
  }
  return data;
}

const EXPIRED = { error: 'Your Google sign-in has expired. Please sign in again.', status: 401 };

/** Returns a valid access token for the session, refreshing it if needed (or if forced). */
async function getAccessToken(session, force = false) {
  const auth = session.auth || {};
  if (!force && auth.accessToken && Date.now() < (auth.expiresAt || 0) - 60000) return { accessToken: auth.accessToken };
  if (!auth.refreshToken) return { ...EXPIRED };
  try {
    const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refreshToken });
    session.auth = {
      ...auth,
      accessToken: data.access_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    };
    return { accessToken: data.access_token };
  } catch (err) {
    console.error('Token refresh failed:', err.message);
    return { ...EXPIRED };
  }
}

function emailDomain(email) {
  return String(email || '').toLowerCase().split('@')[1] || '';
}

function signedIn(req) {
  return Boolean(req.session && req.session.user);
}

/** For API routes: 401 JSON when sign-in is required and missing. */
function requireAuth(req, res, next) {
  if (!AUTH_ENABLED || signedIn(req)) return next();
  res.status(401).json({ error: 'Please sign in to continue.', signIn: true });
}

// ---------------------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------------------

function fitText(font, text, maxWidth, size) {
  let s = size;
  while (s > MIN_FONT_SIZE && font.widthOfTextAtSize(text, s) > maxWidth) s -= 0.5;
  if (font.widthOfTextAtSize(text, s) <= maxWidth) return { text, size: s };
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(t + '…', s) > maxWidth) t = t.slice(0, -1);
  return { text: t + '…', size: s };
}

// WinAnsi-encodable characters only (standard Helvetica can't draw others).
function sanitize(text) {
  return text.replace(/[^\x20-\x7E\xA0-\xFF‘’“”–—…]/g, '?');
}

function wrapText(font, text, maxWidth, size) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) line = candidate;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

function drawFootnote(page, font, submitTo) {
  const { cover } = FOOTNOTE;
  page.drawRectangle({ x: cover.x, y: cover.y, width: cover.width, height: cover.height, color: rgb(1, 1, 1) });

  const text = FOOTNOTE_TEXT.replace('{name}', sanitize(submitTo));
  let size = FOOTNOTE.fontSize;
  let lines = wrapText(font, text, FOOTNOTE.maxWidth, size);
  while (lines.length > FOOTNOTE.maxLines && size > MIN_FONT_SIZE) {
    size -= 0.5;
    lines = wrapText(font, text, FOOTNOTE.maxWidth, size);
  }
  const lineHeight = FOOTNOTE.lineHeight * (size / FOOTNOTE.fontSize);
  lines.forEach((line, i) => {
    page.drawText(line, {
      x: FOOTNOTE.x,
      y: FOOTNOTE.firstBaseline - i * lineHeight,
      size, font, color: rgb(0, 0, 0),
    });
  });
}

// One slip per page, at the template's own size.
async function buildSlipPages(rows, submitTo) {
  const templateBytes = await templateBytesPromise;
  const template = await PDFDocument.load(templateBytes);
  const out = await PDFDocument.create();
  out.setTitle('Missing Assignment Slips');
  const font = await out.embedFont(StandardFonts.Helvetica);

  for (const row of rows) {
    const [page] = await out.copyPages(template, [0]);
    out.addPage(page);
    for (const [field, spec] of Object.entries(FIELDS)) {
      const value = sanitize(row[field] || '');
      if (!value) continue;
      const { text, size } = fitText(font, value, spec.maxWidth, FONT_SIZE);
      page.drawText(text, { x: spec.x, y: spec.y, size, font, color: rgb(0, 0, 0) });
    }
    drawFootnote(page, font, submitTo);
  }
  return out;
}

// Stack `perPage` slips on each portrait letter page with dashed cut lines.
async function imposeSlips(slipsDoc, layout) {
  const { perPage, cropHeight } = layout;
  const out = await PDFDocument.create();
  out.setTitle('Missing Assignment Slips');
  const slipPages = await out.copyPages(slipsDoc, slipsDoc.getPageIndices());

  const { width: slipW, height: fullH } = slipPages[0].getSize();
  const slipH = cropHeight || fullH;
  const box = cropHeight ? { left: 0, bottom: 0, right: slipW, top: cropHeight } : undefined;
  const gap = (LETTER.height - perPage * slipH) / (perPage + 1);
  const x = (LETTER.width - slipW) / 2;

  for (let i = 0; i < slipPages.length; i += perPage) {
    const page = out.addPage([LETTER.width, LETTER.height]);
    const group = slipPages.slice(i, i + perPage);
    for (let j = 0; j < group.length; j++) {
      const embedded = await out.embedPage(group[j], box);
      const y = LETTER.height - gap - (j + 1) * slipH - j * gap;
      page.drawPage(embedded, { x, y, width: slipW, height: slipH });
      if (j > 0) {
        const cutY = y + slipH + gap / 2;
        page.drawLine({
          start: { x: 0, y: cutY }, end: { x: LETTER.width, y: cutY },
          thickness: 0.5, color: rgb(0.6, 0.6, 0.6), dashArray: [6, 4],
        });
      }
    }
  }
  return out;
}

async function buildPdf(rows, submitTo, layoutKey) {
  const layout = LAYOUTS[layoutKey] || LAYOUTS[DEFAULT_LAYOUT];
  const slipsDoc = await buildSlipPages(rows, submitTo);
  const doc = layout.perPage === 1 ? slipsDoc : await imposeSlips(slipsDoc, layout);
  return await doc.save();
}

// ---------------------------------------------------------------------------
// Web server
// ---------------------------------------------------------------------------

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(cookieSession({
  name: 'slips.session',
  keys: [SESSION_SECRET],
  maxAge: SESSION_HOURS * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: BASE_URL.startsWith('https://'),
}));

const PUBLIC_DIR = path.join(__dirname, 'public');

// The main page requires sign-in when auth is enabled.
app.get('/', (req, res) => {
  if (AUTH_ENABLED && !signedIn(req)) return res.redirect('/login');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/login', (req, res) => {
  if (!AUTH_ENABLED || signedIn(req)) return res.redirect('/');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.use(express.static(PUBLIC_DIR, { index: false }));

app.get('/auth/google', (req, res) => {
  if (!AUTH_ENABLED) return res.redirect('/');
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  req.session.oauth = { state, verifier };

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: OAUTH_SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });
  if (ALLOWED_DOMAIN) params.set('hd', ALLOWED_DOMAIN);
  res.redirect(`${OAUTH_AUTH_URL}?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  if (!AUTH_ENABLED) return res.redirect('/');
  const pending = (req.session && req.session.oauth) || {};
  req.session.oauth = null;

  if (req.query.error) return res.redirect('/login?error=denied');
  if (!req.query.code || !req.query.state || req.query.state !== pending.state || !pending.verifier) {
    return res.redirect('/login?error=state');
  }

  try {
    const tokens = await tokenRequest({
      grant_type: 'authorization_code',
      code: String(req.query.code),
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.verifier,
    });

    const infoRes = await fetch(OAUTH_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!infoRes.ok) throw new Error(`userinfo returned ${infoRes.status}`);
    const info = await infoRes.json();
    if (!info.email || info.email_verified === false) throw new Error('Google did not return a verified email');

    if (ALLOWED_DOMAIN && emailDomain(info.email) !== ALLOWED_DOMAIN && String(info.hd || '').toLowerCase() !== ALLOWED_DOMAIN) {
      req.session = null;
      return res.redirect('/login?error=domain');
    }

    req.session.user = { email: info.email, name: info.name || info.email, picture: info.picture || '' };
    req.session.auth = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
    };
    res.redirect('/');
  } catch (err) {
    console.error('Google sign-in failed:', err.message);
    res.redirect('/login?error=failed');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session = null;
  res.redirect(AUTH_ENABLED ? '/login' : '/');
});

app.get('/config', (req, res) => {
  res.json({
    submitTo: SUBMIT_TO_DEFAULT,
    layout: DEFAULT_LAYOUT,
    authEnabled: AUTH_ENABLED,
    allowedDomain: ALLOWED_DOMAIN || null,
    user: signedIn(req) ? { email: req.session.user.email, name: req.session.user.name } : null,
  });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

app.get('/sample.csv', (req, res) => {
  res.type('text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="sample.csv"');
  res.send(fs.readFileSync(path.join(__dirname, 'sample.csv')));
});

app.post('/generate', requireAuth, (req, res) => {
  upload.single('csv')(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.message });

      let parsed;
      const sheetUrl = String((req.body && req.body.sheetUrl) || '').trim();
      if (req.file) {
        parsed = parseCsv(req.file.buffer);
      } else if (sheetUrl) {
        parsed = await fetchSheet(sheetUrl, req.session);
      } else {
        return res.status(400).json({ error: 'Choose a CSV file or paste a Google Sheets link.' });
      }
      if (parsed.error) {
        // Sign-in no longer usable: end the session so the login page shows.
        if (parsed.status === 401) req.session = null;
        return res.status(parsed.status || 400).json({ error: parsed.error, signIn: parsed.status === 401 });
      }

      const submitTo = String((req.body && req.body.submitTo) || '').trim().slice(0, 60) || SUBMIT_TO_DEFAULT;
      const layoutKey = Number((req.body && req.body.layout) || DEFAULT_LAYOUT);
      const pdf = await buildPdf(parsed.rows, submitTo, layoutKey);
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="missing-assignment-slips-${stamp}.pdf"`);
      res.setHeader('X-Slip-Count', String(parsed.rows.length));
      res.setHeader('X-Skipped-Rows', parsed.skipped.join(','));
      res.send(Buffer.from(pdf));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Something went wrong while building the PDF.' });
    }
  });
});

templateBytesPromise
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Missing Assignment Slips running at ${BASE_URL} (port ${PORT})`);
      console.log(`Template: ${TEMPLATE_PATH}`);
      if (AUTH_ENABLED) {
        console.log(`Google sign-in: ON (redirect URI ${REDIRECT_URI})`);
        if (ALLOWED_DOMAIN) console.log(`Allowed accounts: @${ALLOWED_DOMAIN}`);
        else console.warn('WARNING: ALLOWED_DOMAIN is not set; any Google account can sign in.');
        if (!process.env.SESSION_SECRET) console.warn('WARNING: SESSION_SECRET is not set; everyone is signed out when the server restarts.');
      } else {
        console.log('Google sign-in: OFF (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable)');
      }
    });
  })
  .catch((e) => {
    console.error(`Could not load template at ${TEMPLATE_PATH}:`, e.message);
    process.exit(1);
  });
