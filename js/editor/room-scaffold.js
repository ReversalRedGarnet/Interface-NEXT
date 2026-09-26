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

/** Matches the `.room-link-icon` markup index.html and campus.js already
 *  use byte-for-byte — a new room's link must render identically to every
 *  existing one. No emoji anywhere in the app; this is a flat outline
 *  "monitor" glyph sized in `em`/colored via `currentColor`. */
const ROOM_LINK_ICON = '<svg class="icon" width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1" y="2" width="14" height="9" rx="1"/><line x1="5.5" y1="14" x2="10.5" y2="14" stroke-linecap="round"/><line x1="8" y1="11" x2="8" y2="14" stroke-linecap="round"/></svg>';

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
  <title>${escapeHtml(label)}</title>
  <link rel="manifest" href="../manifest.json">
  <meta name="theme-color" content="#FAF9F6">
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
      <span class="site-tool"></span>
      <nav class="site-nav" aria-label="Primary">
        <a href="../index.html">Campus</a>
        <a href="../issues.html">Issues</a>
        <a href="../editor.html">Editor</a>
      </nav>
    </div>
  </div>

  <div id="room-root"></div>
  <script type="module" src="../js/main.js"></script>

  <footer class="site-footer">
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
  const linkBlock = `\n          <a class="room-link" href="${href}">\n            <span class="room-link-icon" aria-hidden="true">${ROOM_LINK_ICON}</span>${escLabel}\n          </a>\n        `;

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
  const card = `\n\n      <!-- ${escCampus} -->\n      <div class="site-card">\n        <div class="site-card-header">\n          <h2 class="site-name">${escCampus}</h2>\n        </div>\n        <div class="room-list" id="${listId}">\n          <a class="room-link" href="${href}">\n            <span class="room-link-icon" aria-hidden="true">${ROOM_LINK_ICON}</span>${escLabel}\n          </a>\n        </div>\n        <button class="site-toggle" data-target="${listId}" aria-controls="${listId}" aria-expanded="true">Hide Rooms ▴</button>\n      </div>\n\n    `;

  const before = html.slice(0, gridCloseIdx).replace(/\s+$/, '');
  const after = html.slice(gridCloseIdx);
  return before + card + after;
}

/** Removes a room's `<a class="room-link">` from index.html — the reverse
 *  of patchIndexHtml. If that leaves its `<div class="room-list">` with no
 *  other room-link in it, the whole site-card (and its leading `<!-- {campus}
 *  -->` comment, if immediately adjacent) is removed too — the mirror of
 *  patchIndexHtml only ever creating a new card when a site doesn't already
 *  have one. A no-op (returns `html` unchanged) if the room isn't present. */
export function removeFromIndexHtml(html, id) {
  const hrefAttr = `href="rooms/${roomFileStem(id)}.html"`;
  const hrefIdx = html.indexOf(hrefAttr);
  if (hrefIdx === -1) return html;

  const anchorStart = html.lastIndexOf('<a class="room-link"', hrefIdx);
  if (anchorStart === -1) return html;
  const anchorCloseIdx = findMatchingTagClose(html, anchorStart, 'a');
  const anchorEnd = anchorCloseIdx + '</a>'.length;

  // Trim *all* trailing whitespace (not just same-line indentation) back to
  // the previous sibling's closing tag — the separator between anchors is
  // itself whitespace (`\n` + indent), so leaving any of it behind here
  // would double up with the whitespace already sitting on the other side
  // of the removed anchor, leaving a blank line patchIndexHtml never wrote.
  const beforeAnchor = html.slice(0, anchorStart).replace(/\s+$/, '');
  const withoutAnchor = beforeAnchor + html.slice(anchorEnd);

  const roomListStart = withoutAnchor.lastIndexOf('<div class="room-list"', beforeAnchor.length);
  if (roomListStart === -1) return withoutAnchor;
  const roomListCloseIdx = findMatchingTagClose(withoutAnchor, roomListStart, 'div');
  if (withoutAnchor.slice(roomListStart, roomListCloseIdx).includes('class="room-link"')) {
    return withoutAnchor; // other rooms remain in this site's list
  }

  const cardStart = withoutAnchor.lastIndexOf('<div class="site-card">', roomListStart);
  if (cardStart === -1) return withoutAnchor;
  const cardCloseIdx = findMatchingTagClose(withoutAnchor, cardStart, 'div');
  const cardEnd = cardCloseIdx + '</div>'.length;

  // Fold in the card's own leading comment (`<!-- {campus} -->`) if it's
  // immediately before the card, so removing the last room in a site
  // doesn't leave a stray comment with nothing under it.
  let cutStart = cardStart;
  const beforeCardTrimmedLen = withoutAnchor.slice(0, cardStart).replace(/\s+$/, '').length;
  if (withoutAnchor.slice(0, beforeCardTrimmedLen).endsWith('-->')) {
    const commentOpenIdx = withoutAnchor.lastIndexOf('<!--', beforeCardTrimmedLen);
    if (commentOpenIdx !== -1) cutStart = commentOpenIdx;
  }

  const before = withoutAnchor.slice(0, cutStart).replace(/\s+$/, '');
  const after = withoutAnchor.slice(cardEnd);
  return before + after;
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

/** Removes an existing `{ id: '...', ... }` entry from ALL_ROOMS — the
 *  reverse of patchExportJs. Every entry patchExportJs writes (and every
 *  real one in js/export.js today) is its own single line, so a per-line
 *  filter is enough; a no-op (returns `source` unchanged) if `id` isn't
 *  present, rather than throwing — deleting an already-gone room should
 *  degrade gracefully, not fail the whole operation. */
export function removeFromExportJs(source, id) {
  const idLit = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entryRe = new RegExp(`^\\s*\\{\\s*id:\\s*'${idLit}'\\s*,.*\\},?\\s*$`);
  return source.split('\n').filter(line => !entryRe.test(line)).join('\n');
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
