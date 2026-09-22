'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');

const PORT = process.env.PORT || 3000;
const TEMPLATE_PATH = process.env.TEMPLATE_PATH || path.join(__dirname, 'PDF Slip template.pdf');

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

// Accepted CSV header spellings for each field (compared lower-cased, trimmed,
// with punctuation/underscores removed).
const HEADER_ALIASES = {
  name:       ['name', 'student', 'studentname', 'student name'],
  teacher:    ['teacher', 'teachername', 'teacher name', 'nameofteacher', 'name of teacher'],
  assignment: ['assignment', 'assignmentname', 'assignment name', 'missingassignment',
               'missing assignment', 'nameofmissingassignment', 'name of missing assignment'],
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
  // Rotating by the page's own /Rotate value, in the same direction that
  // PDF viewers apply it (clockwise), makes the drawn content appear upright.
  page.drawPage(embedded, { x, y, rotate: degrees(-rotation) });
  return await out.save();
}

let templateBytesPromise = loadNormalizedTemplate();

// ---------------------------------------------------------------------------
// CSV handling
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
    if (idx === -1) return { error: `CSV is missing a "${field}" column. Found columns: ${headers.join(', ') || '(none)'}` };
    map[field] = headers[idx];
  }
  return { map };
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
  if (records.length === 0) return { error: 'The CSV has no data rows.' };

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

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

const SHEETS_BASE_URL = process.env.SHEETS_BASE_URL || 'https://docs.google.com';
const SHEET_FETCH_TIMEOUT_MS = 20000;
const SHEET_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Turn a Google Sheets link into a CSV export URL. Supports normal links
 * (/spreadsheets/d/<id>/edit#gid=<gid>) and "publish to the web" links
 * (/spreadsheets/d/e/<id>/pubhtml). Returns null if the link isn't a sheet.
 */
function sheetCsvUrl(link) {
  let url;
  try { url = new URL(String(link).trim()); } catch { return null; }
  if (!/(^|\.)docs\.google\.com$/.test(url.hostname)) return null;

  const gid = url.searchParams.get('gid') || (url.hash.match(/gid=(\d+)/) || [])[1] || '0';
  const published = url.pathname.match(/^\/spreadsheets\/d\/e\/([\w-]+)/);
  if (published) return `${SHEETS_BASE_URL}/spreadsheets/d/e/${published[1]}/pub?output=csv&gid=${gid}`;
  const normal = url.pathname.match(/^\/spreadsheets\/d\/([\w-]+)/);
  if (normal) return `${SHEETS_BASE_URL}/spreadsheets/d/${normal[1]}/export?format=csv&gid=${gid}`;
  return null;
}

const SHARE_HELP = 'Google would not let us read this sheet. In Google Sheets click Share, set '
  + '"General access" to "Anyone with the link" (Viewer), then try again.';

async function fetchSheetCsv(link) {
  const csvUrl = sheetCsvUrl(link);
  if (!csvUrl) return { error: 'That does not look like a Google Sheets link. Copy the address from your browser while the sheet is open.' };

  let res;
  try {
    res = await fetch(csvUrl, { redirect: 'follow', signal: AbortSignal.timeout(SHEET_FETCH_TIMEOUT_MS) });
  } catch (err) {
    return { error: `Could not reach Google Sheets (${err.name === 'TimeoutError' ? 'timed out' : err.message}).` };
  }

  // A sheet that isn't shared redirects to a Google sign-in page (HTML, 200)
  // or answers 401/403; a wrong id answers 404.
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (res.status === 404) return { error: 'Google Sheets reports that this sheet does not exist. Check the link.' };
  if (!res.ok || !type.includes('text/csv')) return { error: SHARE_HELP };

  const length = Number(res.headers.get('content-length') || 0);
  if (length > SHEET_MAX_BYTES) return { error: 'This sheet is too large (over 5 MB).' };
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > SHEET_MAX_BYTES) return { error: 'This sheet is too large (over 5 MB).' };
  return { buffer };
}

// ---------------------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------------------

function fitText(font, text, maxWidth, size) {
  let s = size;
  while (s > MIN_FONT_SIZE && font.widthOfTextAtSize(text, s) > maxWidth) s -= 0.5;
  if (font.widthOfTextAtSize(text, s) <= maxWidth) return { text, size: s };
  // Still too long at the minimum size: truncate with an ellipsis.
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(t + '…', s) > maxWidth) t = t.slice(0, -1);
  return { text: t + '…', size: s };
}

// WinAnsi-encodable characters only (standard Helvetica can't draw others).
function sanitize(text) {
  return text.replace(/[^\x20-\x7E\xA0-\xFF‘’“”–—…]/g, '?');
}

// Greedy word wrap; returns an array of lines.
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
  // Pages must belong to `out` before they can be embedded as form XObjects,
  // so copy them across (copied pages are not added to the document).
  const indices = slipsDoc.getPageIndices();
  const slipPages = await out.copyPages(slipsDoc, indices);

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
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

app.get('/sample.csv', (req, res) => {
  res.type('text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="sample.csv"');
  res.send(fs.readFileSync(path.join(__dirname, 'sample.csv')));
});

app.get('/config', (req, res) => {
  res.json({ submitTo: SUBMIT_TO_DEFAULT, layout: DEFAULT_LAYOUT });
});

app.post('/generate', (req, res) => {
  upload.single('csv')(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.message });

      let buffer;
      const sheetUrl = String((req.body && req.body.sheetUrl) || '').trim();
      if (req.file) {
        buffer = req.file.buffer;
      } else if (sheetUrl) {
        const fetched = await fetchSheetCsv(sheetUrl);
        if (fetched.error) return res.status(400).json({ error: fetched.error });
        buffer = fetched.buffer;
      } else {
        return res.status(400).json({ error: 'Choose a CSV file or paste a Google Sheets link.' });
      }

      const { rows, skipped, error } = parseCsv(buffer);
      if (error) return res.status(400).json({ error });

      const submitTo = String((req.body && req.body.submitTo) || '').trim().slice(0, 60) || SUBMIT_TO_DEFAULT;
      const layoutKey = Number((req.body && req.body.layout) || DEFAULT_LAYOUT);
      const pdf = await buildPdf(rows, submitTo, layoutKey);
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="missing-assignment-slips-${stamp}.pdf"`);
      res.setHeader('X-Slip-Count', String(rows.length));
      res.setHeader('X-Skipped-Rows', skipped.join(','));
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
      console.log(`Missing Assignment Slips running at http://localhost:${PORT}`);
      console.log(`Template: ${TEMPLATE_PATH}`);
    });
  })
  .catch((e) => {
    console.error(`Could not load template at ${TEMPLATE_PATH}:`, e.message);
    process.exit(1);
  });
