/**
 * room-scaffold.js — the three non-JSON touch points a brand-new room
 * needs, plus the id-collision check that must pass before any of the
 * four files (this trio + data/{id}.json from schema.js) gets written:
 *
 *   1. rooms/{id}.html — full page shell, window.ROOM_META block
 *   2. index.html       — a new <a class="room-link"> in the right site
 *                          (or a whole new site card)
 *   3. js/export.js     — a new entry in ALL_ROOMS, so "Export All Rooms"
 *                          and the CSV site lookup don't silently skip it
 *
 * Pure string-in/string-out — no DOM — so this is testable directly under
 * Node and safe to call from editor.js before any file is written.
 */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function jsStringLiteral(v) {
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Filename conventions used by every existing room: id is the display
 *  id (e.g. "B2-210"), files are its lowercase form. */
export function roomFileStem(id) {
  return String(id).toLowerCase();
}

export function dataUrlForId(id) {
  return `../data/${roomFileStem(id)}.json`;
}

/* ── 1. rooms/{id}.html ──────────────────────────────────────────── */

/** Matches the shell every existing rooms/*.html uses (see rooms/b2-210.html) — only
 *  the title and ROOM_META block vary between rooms. */
export function generateRoomHtml({ id, label, campus, dataUrl }) {
  const url = dataUrl || dataUrlForId(id);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(label)} — Gridkeep</title>
  <link rel="stylesheet" href="../tokens.css">
  <link rel="stylesheet" href="../base.css">
  <link rel="stylesheet" href="../layout.css">
  <link rel="stylesheet" href="../controls.css">
  <link rel="stylesheet" href="../navigation.css">
  <link rel="stylesheet" href="../floor-plan.css">
  <link rel="stylesheet" href="../status.css">
  <link rel="stylesheet" href="../workstation.css">
  <link rel="stylesheet" href="../overlays.css">
  <link rel="stylesheet" href="../responsive.css">
</head>
<body>

  <script>
    window.ROOM_META = {
      id:      ${jsStringLiteral(id)},
      label:   ${jsStringLiteral(label)},
      campus:  ${jsStringLiteral(campus)},
      back:    '../index.html',
      dataUrl: ${jsStringLiteral(url)},
    };
  </script>

  <div class="site-header">
    <div class="site-header-inner">
      <span class="site-tool">Gridkeep</span>
    </div>
  </div>

  <div id="room-root"></div>
  <script type="module" src="../js/main.js"></script>

  <footer class="site-footer">
    <p><a href="https://github.com/ReversalRedGarnet">ReversalRedGarnet</a></p>
  </footer>

</body>
</html>
`;
}

/* ── Shared: balanced-tag / balanced-bracket scanning ───────────────
   The markup and source here are our own generated/authored files, not
   arbitrary input, so a plain depth counter (aware of quoted strings, for
   the JS bracket case) is enough — no need for a full parser. */

function findMatchingTagClose(html, openTagStartIndex, tagName) {
  const openRe = new RegExp(`<${tagName}\\b`, 'g');
  const closeStr = `</${tagName}>`;
  let i = html.indexOf('>', openTagStartIndex) + 1;
  let depth = 1;
  while (depth > 0) {
    openRe.lastIndex = i;
    const nextOpen = html.indexOf(`<${tagName}`, i);
    const nextClose = html.indexOf(closeStr, i);
    if (nextClose === -1) throw new Error(`Unbalanced <${tagName}> starting at ${openTagStartIndex}`);
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = html.indexOf('>', nextOpen) + 1;
    } else {
      depth--;
      i = nextClose + closeStr.length;
      if (depth === 0) return nextClose;
    }
  }
  return -1;
}

function findMatchingBracket(text, openIndex, openCh, closeCh) {
  let depth = 0;
  let inString = null;
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inString = c; continue; }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Unbalanced ${openCh}${closeCh}`);
}

/* ── 2. index.html ───────────────────────────────────────────────── */

/** Existing `<a class="room-link" href="rooms/{stem}.html">` entries, by file stem. */
export function extractIndexRoomStems(html) {
  return [...html.matchAll(/href="rooms\/([a-z0-9-]+)\.html"/gi)].map(m => m[1].toLowerCase());
}

/** Existing site names, in document order. */
export function extractIndexSites(html) {
  return [...html.matchAll(/<h2 class="site-name">([^<]*)<\/h2>/g)].map(m => m[1].trim());
}

/**
 * Inserts a new room-link into the named site's room-list, or — if that
 * site doesn't exist yet — appends a whole new site card. Returns the
 * full updated index.html text. `campus` is still the field name here (and
 * in ROOM_META/ALL_ROOMS below) because that's what room.js/export.js read
 * — only the presentational "Site" label/markup changed, not the data key.
 */
export function patchIndexHtml(html, { id, label, campus }) {
  const escLabel = escapeHtml(label);
  const href = `rooms/${roomFileStem(id)}.html`;
  const linkBlock = `\n          <a class="room-link" href="${href}">\n            <span class="room-link-icon" aria-hidden="true">💻</span>${escLabel}\n          </a>\n        `;

  const h2Re = /<h2 class="site-name">([^<]*)<\/h2>/g;
  let m;
  while ((m = h2Re.exec(html))) {
    if (m[1].trim() !== campus) continue;

    const afterHeading = html.slice(m.index);
    const roomListMatch = /<div class="room-list" id="([^"]+)">/.exec(afterHeading);
    if (!roomListMatch) continue;

    const roomListOpenIdx = m.index + roomListMatch.index;
    const closeIdx = findMatchingTagClose(html, roomListOpenIdx, 'div');
    const before = html.slice(0, closeIdx).replace(/\s+$/, '');
    const after = html.slice(closeIdx);
    return before + linkBlock + after;
  }

  // Site not present yet — append a new site card to .site-grid.
  const gridOpenIdx = html.indexOf('<div class="site-grid">');
  if (gridOpenIdx === -1) throw new Error('index.html: <div class="site-grid"> not found');
  const gridCloseIdx = findMatchingTagClose(html, gridOpenIdx, 'div');

  const existingListIds = [...html.matchAll(/id="(rooms-[a-z0-9-]+)"/gi)].map(m2 => m2[1].toLowerCase());
  const slugBase = campus.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
  let listId = `rooms-${slugBase}`;
  let n = 2;
  while (existingListIds.includes(listId.toLowerCase())) listId = `rooms-${slugBase}-${n++}`;

  const escCampus = escapeHtml(campus);
  const card = `\n\n      <!-- ${escCampus} -->\n      <div class="site-card">\n        <div class="site-card-header">\n          <h2 class="site-name">${escCampus}</h2>\n        </div>\n        <div class="room-list" id="${listId}">\n          <a class="room-link" href="${href}">\n            <span class="room-link-icon" aria-hidden="true">💻</span>${escLabel}\n          </a>\n        </div>\n        <button class="site-toggle" data-target="${listId}" aria-controls="${listId}" aria-expanded="true">Hide Rooms ▴</button>\n      </div>\n\n    `;

  const before = html.slice(0, gridCloseIdx).replace(/\s+$/, '');
  const after = html.slice(gridCloseIdx);
  return before + card + after;
}

/* ── 3. js/export.js — ALL_ROOMS ─────────────────────────────────── */

const ALL_ROOMS_MARKER = 'export const ALL_ROOMS = [';

/** Existing `{ id: '...' }` entries in ALL_ROOMS. */
export function extractAllRoomsIds(exportJsSource) {
  const openIdx = exportJsSource.indexOf(ALL_ROOMS_MARKER);
  if (openIdx === -1) return [];
  const bracketIdx = openIdx + ALL_ROOMS_MARKER.length - 1;
  const closeIdx = findMatchingBracket(exportJsSource, bracketIdx, '[', ']');
  const body = exportJsSource.slice(bracketIdx, closeIdx);
  return [...body.matchAll(/\{\s*id:\s*'([^']*)'/g)].map(m => m[1]);
}

/** Appends a new `{ id, label, campus }` entry to ALL_ROOMS. Returns the
 *  full updated js/export.js text. */
export function patchExportJs(source, { id, label, campus }) {
  const openIdx = source.indexOf(ALL_ROOMS_MARKER);
  if (openIdx === -1) throw new Error('js/export.js: "export const ALL_ROOMS = [" not found');
  const bracketIdx = openIdx + ALL_ROOMS_MARKER.length - 1;
  const closeIdx = findMatchingBracket(source, bracketIdx, '[', ']');

  const before = source.slice(0, closeIdx).replace(/\s+$/, '');
  const after = source.slice(closeIdx);
  const entry = `\n  { id: ${jsStringLiteral(id)}, label: ${jsStringLiteral(label)}, campus: ${jsStringLiteral(campus)} },\n`;
  return before + entry + after;
}

/* ── 4. Cross-file id collision check ────────────────────────────── */

/**
 * Validates a candidate room id against everywhere a room is registered.
 * `existing` = { dataStems, roomHtmlStems, indexStems, exportIds } — all
 * gathered from the real project before any write happens.
 * Returns an array of problem strings; empty means the id is safe to use.
 */
export function validateNewRoomId(id, existing = {}) {
  const problems = [];
  const trimmed = String(id || '').trim();

  if (!trimmed) {
    return ['Room id is required.'];
  }
  if (!/^[A-Za-z0-9-]+$/.test(trimmed)) {
    problems.push('Room id can only contain letters, numbers, and hyphens — it becomes a filename, a URL segment, and a localStorage key prefix.');
  }

  const stem = roomFileStem(trimmed);
  const lists = [
    ['data/', existing.dataStems],
    ['rooms/', existing.roomHtmlStems],
    ['index.html', existing.indexStems],
  ];
  for (const [where, list] of lists) {
    if ((list || []).some(x => String(x).toLowerCase() === stem)) {
      problems.push(`A room with this id already exists in ${where}.`);
    }
  }
  if ((existing.exportIds || []).some(x => String(x).toLowerCase() === trimmed.toLowerCase())) {
    problems.push('A room with this id already exists in js/export.js\'s ALL_ROOMS list.');
  }

  return problems;
}
