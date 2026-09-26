/**
 * legacy-import.test.mjs — the 5 rooms imported from
 * github.com/ReversalRedGarnet/Intern-Interface-Static-Final as new draft
 * seed data: LAYOUT ONLY (walls/doors/entrances/device positions+labels) —
 * none of that repo's own tap-to-mark interaction, status model, or CSV
 * export came along; every imported device starts fresh (there was no
 * per-device status field in the source data to begin with, and none is
 * ever written to data/*.json — inspection state lives only in
 * localStorage, keyed fresh per room+device, same as any brand-new room).
 *
 * Verifies: the import round-trips cleanly through the current schema
 * (same "reproduces the file byte-for-byte" check every real seed room
 * gets in editor.test.mjs — kept in its own file/array here rather than
 * folded into editor.test.mjs's REAL_ROOMS, since that array specifically
 * means "the 5 originally-final seed rooms" elsewhere in that suite);
 * every new room is registered in the app's roster (ALL_ROOMS + the
 * menu-listing fallback) but genuinely absent from data/campus.json's
 * building/floor structure (left for manual placement later); and each new
 * room gates as "draft" exactly the way any other not-yet-finalized room
 * already does.
 * Run: node test/legacy-import.test.mjs
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const results = [];
let bust = 0;

const { normalizeRoomData, serializeRoomData } = await import('../js/editor/schema.js');
const { extractIndexRoomStems, extractAllRoomsIds } = await import('../js/editor/room-scaffold.js');

function readFile(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function readJson(rel) { return JSON.parse(readFile(rel)); }
const crlfToLf = s => s.replace(/\r\n/g, '\n');
// Same tolerance editor.test.mjs's own round-trip checks use — a missing/
// extra trailing newline has no functional effect and isn't a schema
// requirement.
const normalizeTrailingNewline = s => crlfToLf(s).replace(/\n*$/, '\n');

async function test(name, fn) {
  try { await fn(); results.push(['PASS', name, '']); }
  catch (err) { results.push(['FAIL', name, err.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

const IMPORTED_ROOMS = [
  { stem: 'gpl',     id: 'GPL',     label: 'GPL',     campus: 'Lawson Tama Campus', deviceCount: 36 },
  { stem: 'library', id: 'LIBRARY', label: 'Library', campus: 'King George Campus', deviceCount: 25 },
  { stem: 'mtl',     id: 'MTL',     label: 'MTL',     campus: 'Lawson Tama Campus', deviceCount: 37 },
  { stem: 's28-104', id: 'S28-104', label: 'S28-104', campus: 'King George Campus', deviceCount: 24 },
  { stem: 's28-107', id: 'S28-107', label: 'S28-107', campus: 'King George Campus', deviceCount: 24 },
];

/* ══════════════════════════════════════════════════════════════════
   1. Data round-trips cleanly through the current schema
   ══════════════════════════════════════════════════════════════════ */

for (const room of IMPORTED_ROOMS) {
  await test(`round-trip (no edits) reproduces data/${room.stem}.json exactly`, async () => {
    const original = readFile(`data/${room.stem}.json`);
    const parsed = JSON.parse(original);
    const roundTripped = serializeRoomData(normalizeRoomData(parsed));
    assertEqual(normalizeTrailingNewline(roundTripped), normalizeTrailingNewline(original), `data/${room.stem}.json did not round-trip byte-for-byte`);
  });
}

/* ══════════════════════════════════════════════════════════════════
   2. Every imported room starts draft, with a fresh device roster
   ══════════════════════════════════════════════════════════════════ */

for (const room of IMPORTED_ROOMS) {
  await test(`data/${room.stem}.json starts as a draft room with ${room.deviceCount} devices, no carried-over inspection state`, async () => {
    const data = readJson(`data/${room.stem}.json`);
    assertEqual(data.status, 'draft', `${room.stem} should be status "draft" until reviewed`);
    assertEqual(data.devices.length, room.deviceCount, `expected ${room.deviceCount} devices`);
    for (const d of data.devices) {
      assert(!('inspectionState' in d) && !('condition' in d),
        `${room.stem}'s ${d.id} should carry no inspection state in its data file — that lives only in localStorage, keyed fresh per room+device`);
    }
  });
}

/* ══════════════════════════════════════════════════════════════════
   3. Registered in the app's roster (ALL_ROOMS + menu-listing fallback)
   ══════════════════════════════════════════════════════════════════ */

await test('all 5 imported rooms are registered in js/export.js\'s ALL_ROOMS', async () => {
  const exportIds = extractAllRoomsIds(readFile('js/export.js'));
  for (const room of IMPORTED_ROOMS) {
    assert(exportIds.includes(room.id), `expected ${room.id} in ALL_ROOMS, got: ${exportIds.join(', ')}`);
  }
});

await test('all 5 imported rooms have a room-link in index.html\'s menu-listing fallback', async () => {
  const stems = extractIndexRoomStems(readFile('index.html'));
  for (const room of IMPORTED_ROOMS) {
    assert(stems.includes(room.stem), `expected a room-link for ${room.stem} in index.html, got: ${stems.join(', ')}`);
  }
});

/* ══════════════════════════════════════════════════════════════════
   4. Absent from campus.json's building/floor structure
   ══════════════════════════════════════════════════════════════════ */

await test('none of the 5 imported rooms appear in data/campus.json\'s buildings/floors (left for manual placement)', async () => {
  const campusJson = readFile('data/campus.json');
  for (const room of IMPORTED_ROOMS) {
    assert(!campusJson.includes(`"roomId": "${room.stem}"`), `${room.stem} should not yet be placed in campus.json`);
  }
});

/* ══════════════════════════════════════════════════════════════════
   5. Each new room still gates as draft, same as any other
      not-yet-finalized room
   ══════════════════════════════════════════════════════════════════ */

for (const room of IMPORTED_ROOMS) {
  await test(`${room.id} (draft) renders the "not finalized" placeholder, not the real floor plan`, async () => {
    const data = readJson(`data/${room.stem}.json`);
    const dom = new JSDOM('<!doctype html><body><div id="room-root"></div></body>', { url: 'http://localhost/', pretendToBeVisual: true });
    global.window = dom.window;
    global.document = dom.window.document;
    global.localStorage = dom.window.localStorage;
    global.ResizeObserver = dom.window.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };

    const { initRoomPage } = await import(`../js/room.js?s=${bust++}`);
    initRoomPage({ id: room.id, label: room.label, campus: room.campus, back: '../index.html', ...data });

    const doc = dom.window.document;
    assert(doc.querySelector('.empty-state-title'), 'expected the not-finalized empty state');
    assert(!doc.querySelector('[data-id]'), 'no devices should render for a still-draft room');
  });
}

/* ── Report ────────────────────────────────────────────────────────── */
const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
