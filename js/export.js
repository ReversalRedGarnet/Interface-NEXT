/**
 * export.js — CSV status reports, plus JSON backup/restore of the raw
 * localStorage state (the practical workaround for state being per-device —
 * see the note in state.js).
 *
 * CSV format decisions (these are what make it open cleanly in Excel):
 *
 *   1. The file starts with a UTF-8 BOM. Without it, Excel on Windows opens
 *      .csv as ANSI/1252, so any non-ASCII character in a note ("café",
 *      "don't", an em dash) shows up as mojibake ("cafÃ©", "donâ€™t").
 *   2. One flat table: a single header row, then one row per device. The old
 *      layout stacked several mini-tables with repeated headers and blank
 *      separator rows — Excel can't detect columns from that, and it can't be
 *      sorted, filtered, or pivoted. The Working/Not Working split is now a
 *      "Working" Yes/No column plus row ordering (worst first).
 *   3. Every row has exactly HEADERS.length fields, so nothing shifts left.
 *   4. Only ASCII in generated text. User-typed notes are passed through
 *      (the BOM covers them), but embedded newlines and tabs are flattened to
 *      spaces so a multi-line note can't look like a broken row.
 *   5. Timestamps are YYYY-MM-DD HH:MM — sorts correctly as text, and Excel
 *      won't re-read it as a different date the way it does with locale
 *      formats like 03/04/2026.
 *   6. CRLF line endings, per RFC 4180.
 *
 * If Excel still dumps every row into column A, that's a Windows regional
 * setting: your "list separator" is a semicolon, not a comma. Change
 * DELIMITER below to ';' and it'll open correctly.
 */
import { loadState, saveState } from './state.js';
import { formatTimestamp, today } from './format.js';

export const ALL_ROOMS = [
  { id: 'LIBRARY', label: 'Library',  campus: 'King George Campus' },
  { id: 'S28-107', label: 'S28-107',  campus: 'King George Campus' },
  { id: 'S28-104', label: 'S28-104',  campus: 'King George Campus' },
  { id: 'GPL',     label: 'GPL',      campus: 'Lawson Tama Campus' },
  { id: 'MTL',     label: 'MTL',      campus: 'Lawson Tama Campus' },
];

const DELIMITER = ',';
const NEWLINE   = '\r\n';
const BOM       = '\uFEFF';
const CSV_MIME  = 'text/csv;charset=utf-8';

const STATUS_LABELS = { working: 'Working', minor: 'Minor', major: 'Major', unknown: 'Unknown' };

/** Row order: worst first, so the things that need attention are at the top. */
const STATUS_ORDER = { major: 0, minor: 1, unknown: 2, working: 3 };

const HEADERS = ['Campus', 'Room', 'Device ID', 'Status', 'Working', 'Notes', 'Last Updated'];

/* ── CSV primitives ─────────────────────────────────────── */

/**
 * Flattens anything that would break a row: newlines, tabs, and control
 * characters all become single spaces. Quoted newlines are legal CSV, but
 * they render as broken rows in plenty of viewers, so we don't emit them.
 */
function flatten(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim();
}

/** Quotes a field if it contains the delimiter, a quote, or leading/trailing space. */
function csvEscape(value) {
  const str = flatten(value);
  if (str.includes(DELIMITER) || str.includes('"')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/** Builds one CSV line, padded/truncated to exactly HEADERS.length columns. */
function csvRow(cells) {
  const padded = HEADERS.map((_, i) => cells[i] ?? '');
  return padded.map(csvEscape).join(DELIMITER);
}

/* ── Row building ───────────────────────────────────────── */

/**
 * All tracked devices for one room, as flat table rows.
 * Note: only devices that have been clicked at least once have a
 * localStorage entry, so untouched devices don't appear — same as before.
 */
function buildRoomRows(room, state) {
  const prefix = room.id + '_';

  const entries = Object.entries(state)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => ({ deviceId: key.slice(prefix.length), ...value }));

  if (!entries.length) {
    return [[room.campus, room.label, '', 'Not checked', '', '', '']];
  }

  return entries
    .sort((a, b) => {
      const rank = (STATUS_ORDER[a.status] ?? 2) - (STATUS_ORDER[b.status] ?? 2);
      if (rank !== 0) return rank;
      return a.deviceId.localeCompare(b.deviceId, undefined, { numeric: true });
    })
    .map(e => [
      room.campus,
      room.label,
      e.deviceId,
      STATUS_LABELS[e.status] || 'Unknown',
      e.status === 'working' ? 'Yes' : 'No',
      e.notes || '',
      formatTimestamp(e.updatedAt),
    ]);
}

/**
 * Assembles the final file: header row, data rows, then a blank line and two
 * provenance rows at the *bottom*. Keeping them off the top means row 1 is
 * the real header, so Ctrl+T / auto-filter / sort all work on open.
 */
function buildCsv(rows, exporter) {
  const lines = [csvRow(HEADERS), ...rows.map(csvRow)];
  lines.push('');
  lines.push(csvRow(['Generated', formatTimestamp(new Date().toISOString())]));
  lines.push(csvRow(['Exported By', exporter]));
  return BOM + lines.join(NEWLINE) + NEWLINE;
}

/* ── Download plumbing ──────────────────────────────────── */

function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Prompts for the exporter's name. Returns the trimmed name (or "Unknown"
 * if left blank), or null if the prompt was cancelled — callers should
 * abort the export in that case.
 */
function getExporterName() {
  const name = window.prompt('Who is generating this export report? (name)', '');
  if (name === null) return null;
  return flatten(name) || 'Unknown';
}

function findRoom(roomId, roomLabel) {
  return (
    ALL_ROOMS.find(r => r.id === roomId) ||
    { id: roomId, label: roomLabel || roomId, campus: '' }
  );
}

/* ── Public API (unchanged signatures) ──────────────────── */

export function exportRoom(roomId, roomLabel) {
  const exporter = getExporterName();
  if (exporter === null) return;

  const room = findRoom(roomId, roomLabel);
  const rows = buildRoomRows(room, loadState());

  download(buildCsv(rows, exporter), `report-${roomId}-${today()}.csv`, CSV_MIME);
}

export function exportAllRooms() {
  const exporter = getExporterName();
  if (exporter === null) return;

  const state = loadState();
  const rows = ALL_ROOMS.flatMap(room => buildRoomRows(room, state));

  download(buildCsv(rows, exporter), `report-ALL-${today()}.csv`, CSV_MIME);
}

/** Full raw-state backup, for manually transferring data between devices/browsers. */
export function exportStateJSON() {
  const state = loadState();
  download(
    JSON.stringify(state, null, 2),
    `state-backup-${today()}.json`,
    'application/json;charset=utf-8',
  );
}

/** Restores a raw-state backup produced by exportStateJSON. Overwrites current state. */
export async function importStateJSON(file) {
  const text = await file.text();
  const incoming = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
    throw new Error('That file doesn\'t look like a state backup.');
  }
  saveState(incoming);
  return incoming;
}
