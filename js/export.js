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
  { id: 'COMMONS', label: 'Commons',   campus: 'Northgate Site' },
  { id: 'B2-210',  label: 'B2-210',    campus: 'Northgate Site' },
  { id: 'B2-204',  label: 'B2-204',    campus: 'Northgate Site' },
  { id: 'ANNEX',    label: 'Annex Lab', campus: 'Riverside Site' },
  { id: 'WORKSHOP', label: 'Workshop',  campus: 'Riverside Site' },
];

const DELIMITER = ',';
const NEWLINE   = '\r\n';
const BOM       = '\uFEFF';
const CSV_MIME  = 'text/csv;charset=utf-8';

/**
 * Every device gets exactly one of these five effective statuses:
 * `inspectionState` 'checked' collapses to its `condition`; 'unchecked'
 * and 'not-applicable' stand on their own. This is a display-only
 * collapse for the CSV column \u2014 the stored shape (state.js) always keeps
 * inspection state and condition separate.
 */
function effectiveStatus(entry) {
  const inspectionState = entry?.inspectionState || 'unchecked';
  if (inspectionState === 'checked') return entry.condition || 'unchecked';
  return inspectionState;
}

const STATUS_LABELS = {
  working: 'Working', minor: 'Minor', major: 'Major',
  unchecked: 'Not Checked', 'not-applicable': 'Not Applicable',
};

/** Row order: worst first, then untouched, then the things nobody needs
 *  to act on (working, not applicable) at the bottom. */
const STATUS_ORDER = { major: 0, minor: 1, unchecked: 2, working: 3, 'not-applicable': 4 };

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
 * Every device in the room's roster, as flat table rows — including
 * devices nobody has ever clicked. Untouched devices have no localStorage
 * entry at all (see state.js), so they join against an empty/default
 * entry and export as "Not Checked" instead of being silently absent.
 */
export function buildRoomRows(room, devices, state) {
  if (!devices.length) {
    return [[room.campus, room.label, '', 'No devices', '', '', '']];
  }

  const rows = devices.map(d => {
    const entry = state[`${room.id}_${d.id}`];
    return { deviceId: d.id, status: effectiveStatus(entry), notes: entry?.notes || '', updatedAt: entry?.updatedAt };
  });

  return rows
    .sort((a, b) => {
      const rank = (STATUS_ORDER[a.status] ?? 2) - (STATUS_ORDER[b.status] ?? 2);
      if (rank !== 0) return rank;
      return a.deviceId.localeCompare(b.deviceId, undefined, { numeric: true });
    })
    .map(e => [
      room.campus,
      room.label,
      e.deviceId,
      STATUS_LABELS[e.status] || 'Not Checked',
      e.status === 'working' ? 'Yes' : 'No',
      e.notes,
      formatTimestamp(e.updatedAt),
    ]);
}

/**
 * Fetches one room's device roster from its data file. `dataUrlFor(stem)`
 * lets each caller supply the path prefix that matches its own location
 * (room pages live under rooms/, so they fetch '../data/x.json'; the menu
 * page lives at the project root and fetches 'data/x.json') — export.js
 * itself has no idea which page called it, so it never hardcodes a depth.
 * Network/parse failures degrade to an empty roster rather than throwing,
 * matching how room.js's own cross-room lookups already tolerate a room
 * that fails to load.
 */
export async function fetchRoomDevices(room, dataUrlFor) {
  try {
    const stem = String(room.id).toLowerCase();
    const url = (dataUrlFor || (s => `data/${s}.json`))(stem);
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.devices) ? data.devices : [];
  } catch {
    return [];
  }
}

/**
 * A room's own "draft" | "final" status (see js/editor/schema.js's
 * ROOM_STATUSES) — whether its LAYOUT is still editable, a separate
 * concept from any device's inspectionState/condition. Every
 * inspection-facing consumer of ALL_ROOMS (the menu listing, cross-room
 * search, the Issues view, the campus nav, the all-rooms CSV export)
 * needs to gate on this so a still-drafted room never leaks into a view
 * meant for finished ones.
 * Fails safe: a missing/unreadable/malformed data file, or any status
 * other than the literal string "final", reads as "draft" — never as
 * "final" by accident, since that's what would leak it.
 */
export async function fetchRoomStatus(room, dataUrlFor) {
  try {
    const stem = String(room.id).toLowerCase();
    const url = (dataUrlFor || (s => `data/${s}.json`))(stem);
    const res = await fetch(url);
    if (!res.ok) return 'draft';
    const data = await res.json();
    return data?.status === 'final' ? 'final' : 'draft';
  } catch {
    return 'draft';
  }
}

/** `rooms` narrowed to only those whose data file says "final" — the one
 *  place every inspection-facing ALL_ROOMS consumer should filter through
 *  before rendering/indexing/aggregating anything. Runs every room's
 *  status fetch concurrently, same pattern fetchRoomDevices callers
 *  already use for the roster itself. */
export async function filterFinalRooms(rooms, dataUrlFor) {
  const statuses = await Promise.all(rooms.map(room => fetchRoomStatus(room, dataUrlFor)));
  return rooms.filter((room, i) => statuses[i] === 'final');
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

/* ── Public API ────────────────────────────────────────────
 * Both exports are now async: building a roster-complete report means
 * reading each room's device list, and a caller that doesn't already
 * have it in hand (e.g. "Export All Rooms" from the menu page) has to
 * fetch it. `opts.devices` lets a caller that already has the current
 * room's devices loaded (a room page) skip that fetch entirely;
 * `opts.dataUrlFor` lets any caller say where its data files live
 * relative to itself. Both are optional — omitting them just means every
 * roster is fetched with the project-root-relative default path. */

export async function exportRoom(roomId, roomLabel, opts = {}) {
  const exporter = getExporterName();
  if (exporter === null) return;

  const room = findRoom(roomId, roomLabel);
  const devices = opts.devices || await fetchRoomDevices(room, opts.dataUrlFor);
  const rows = buildRoomRows(room, devices, loadState());

  download(buildCsv(rows, exporter), `report-${roomId}-${today()}.csv`, CSV_MIME);
}

export async function exportAllRooms(opts = {}) {
  const exporter = getExporterName();
  if (exporter === null) return;

  // Draft rooms are excluded here for the same reason they're excluded from
  // the menu/campus/search/Issues surfaces: an unreviewed layout shouldn't
  // be silently vouched for in a report. exportRoom (a single room, from
  // that room's own page) isn't filtered — the only page that calls it
  // (room.js) already refuses to render at all for a draft room, so that
  // path is unreachable for one today regardless.
  const state = loadState();
  const rooms = await filterFinalRooms(ALL_ROOMS, opts.dataUrlFor);
  const rows = [];
  for (const room of rooms) {
    const devices = await fetchRoomDevices(room, opts.dataUrlFor);
    rows.push(...buildRoomRows(room, devices, state));
  }

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
