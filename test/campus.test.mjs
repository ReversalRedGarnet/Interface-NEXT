/**
 * campus.test.mjs — feedback loop for the campus/building/floor nav
 * prototype: campus-data.js's pure logic (normalizing data/campus.json,
 * finding a building, deciding where a click should go), a sanity check on
 * the real seed file, and campus.js's actual rendering/click/keyboard
 * behaviour driven in jsdom (same approach as room.test.mjs drives room.js).
 *
 * Run: node test/campus.test.mjs
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const results = [];
let bust = 0;

const { normalizeCampusData, findBuilding, buildingDestination } = await import('../js/campus-data.js');
const { roomFileStem } = await import('../js/editor/room-scaffold.js');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

// Clicking a single-floor building really does assign window.location.href
// (see js/campus.js's activate()) — jsdom doesn't implement real navigation
// and logs a "Not implemented" jsdomError for it. That's expected here (we
// only care what href *would* be requested, not an actual page load), so a
// virtual console swallows just that noise rather than polluting test output.
const silentConsole = new VirtualConsole();
silentConsole.on('jsdomError', () => {});

/** Fresh jsdom + fresh module instance + a stubbed fetch('data/campus.json'),
 *  mirroring room.test.mjs's mount() for room.js. */
async function mountCampus(campusJson) {
  const dom = new JSDOM('<!doctype html><html><body><div id="campus-root"></div></body></html>', {
    url: 'http://localhost/index.html', virtualConsole: silentConsole,
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.fetch = async url => {
    if (!String(url).includes('campus.json')) throw new Error(`mountCampus: unexpected fetch("${url}")`);
    return { ok: true, json: async () => campusJson };
  };

  const { initCampusPage } = await import(`../js/campus.js?b=${bust++}`);
  await initCampusPage();
  return { dom, doc: dom.window.document };
}

function click(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
}
/** Works for either a Document (campus.js's document-level Escape handler)
 *  or an Element (dispatched there so it bubbles up through the canvas's
 *  delegated Enter/Space handler, same as a real keypress would). */
function key(node, k) {
  const win = node.defaultView || node.ownerDocument.defaultView;
  node.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }));
}

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

await test('normalizeCampusData tolerates a missing/malformed file, same as normalizeRoomData does', async () => {
  const empty = normalizeCampusData(undefined);
  assertEqual(empty.buildings.length, 0, 'a missing file should normalize to no buildings');
  assertEqual(empty.canvasWidth, 1000, 'a missing canvasWidth should fall back to the default');
  assertEqual(empty.canvasHeight, 460, 'a missing canvasHeight should fall back to the default');
});

await test('normalizeCampusData fills in defaults for a partially-specified building', async () => {
  const data = normalizeCampusData({ buildings: [{ id: 'x' }] });
  const b = data.buildings[0];
  assertEqual(b.label, 'x', 'a missing label should fall back to the id');
  assertEqual(JSON.stringify(b.shape), JSON.stringify({ x: 0, y: 0, width: 100, height: 100 }), 'a missing shape should get sane defaults');
  assertEqual(b.floors.length, 0, 'a missing floors array should normalize to empty, not throw');
});

await test('findBuilding looks up by id, and returns null for an unknown one', async () => {
  const data = normalizeCampusData({ buildings: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  assertEqual(findBuilding(data, 'b').label, 'B', 'expected to find building "b"');
  assertEqual(findBuilding(data, 'nope'), null, 'an unknown building id should return null, not throw or return undefined');
});

await test('buildingDestination sends a single-floor building straight to its room', async () => {
  const building = { id: 'a', floors: [{ roomId: 'commons', label: 'Commons' }] };
  const dest = buildingDestination(building);
  assertEqual(dest.kind, 'room', 'a single-floor building should resolve straight to a room');
  assertEqual(dest.roomId, 'commons', 'should resolve to that floor\'s roomId');
});

await test('buildingDestination opens a floor picker for a multi-floor building', async () => {
  const building = { id: 'a', floors: [{ roomId: 'b2-210', label: 'B2-210' }, { roomId: 'b2-204', label: 'B2-204' }] };
  const dest = buildingDestination(building);
  assertEqual(dest.kind, 'floor-picker', 'a multi-floor building should open a floor picker, not navigate directly');
  assertEqual(dest.floors.length, 2, 'the floor picker should carry all of the building\'s floors');
});

await test('buildingDestination is a safe no-op for a building with no floors, and for a missing building', async () => {
  assertEqual(buildingDestination({ id: 'empty', floors: [] }).kind, 'none', 'a building with no floors should resolve to "none", not throw');
  assertEqual(buildingDestination(null).kind, 'none', 'a missing building (e.g. a stale id) should resolve to "none", not throw');
});

/* ══════════════════════════════════════════════════════════════════
   campus.js rendering + click/keyboard behaviour (driven in jsdom)
   ══════════════════════════════════════════════════════════════════ */

const SAMPLE = {
  canvasWidth: 1000, canvasHeight: 460,
  buildings: [
    { id: 'single', label: 'Solo Hall', shape: { x: 0, y: 0, width: 100, height: 100 }, floors: [{ roomId: 'commons', label: 'Commons' }] },
    { id: 'multi', label: 'Tower & Co', shape: { x: 200, y: 0, width: 100, height: 100 }, floors: [
      { roomId: 'b2-210', label: 'B2-210' }, { roomId: 'b2-204', label: 'B2-204' },
    ] },
  ],
};

await test('renders one clickable building block per entry, correctly escaped', async () => {
  const { doc } = await mountCampus(SAMPLE);
  const blocks = [...doc.querySelectorAll('.campus-building')];
  assertEqual(blocks.length, 2, 'expected one block per building');
  assertEqual(blocks[1].getAttribute('aria-label'), 'Tower & Co', 'building label should round-trip through HTML-escaping intact');
  assert(!doc.querySelector('#floor-picker-overlay').classList.contains('open'), 'the floor picker should start closed');
});

await test('clicking a single-floor building does not open the floor picker (it navigates directly instead)', async () => {
  const { doc } = await mountCampus(SAMPLE);
  const rect = doc.querySelector('.campus-building[data-building-id="single"] rect');
  click(rect);
  assert(!doc.getElementById('floor-picker-overlay').classList.contains('open'), 'a single-floor building should not open the floor picker');
});

await test('clicking a multi-floor building opens the floor picker listing every floor, linked to its real room page', async () => {
  const { doc } = await mountCampus(SAMPLE);
  const rect = doc.querySelector('.campus-building[data-building-id="multi"] rect');
  click(rect);

  const overlay = doc.getElementById('floor-picker-overlay');
  assert(overlay.classList.contains('open'), 'the floor picker should open for a multi-floor building');
  assertEqual(doc.getElementById('floor-picker-title').textContent, 'Tower & Co', 'floor picker title should name the building');

  const links = [...doc.querySelectorAll('#floor-picker-list a.room-link')];
  assertEqual(links.map(a => a.getAttribute('href')).join(','), 'rooms/b2-210.html,rooms/b2-204.html', 'floor links should point at the real room pages, in order');
});

await test('Enter/Space activate a building the same as a click (keyboard reachability)', async () => {
  const { doc } = await mountCampus(SAMPLE);
  const g = doc.querySelector('.campus-building[data-building-id="multi"]');
  key(g, 'Enter');
  assert(doc.getElementById('floor-picker-overlay').classList.contains('open'), 'Enter should activate a building exactly like a click');
});

await test('the floor picker\'s close button and Escape both close it', async () => {
  const { doc } = await mountCampus(SAMPLE);
  const overlay = doc.getElementById('floor-picker-overlay');
  click(doc.querySelector('.campus-building[data-building-id="multi"] rect'));
  assert(overlay.classList.contains('open'), 'fixture assumption: overlay should be open before testing close');

  click(doc.getElementById('floor-picker-close'));
  assert(!overlay.classList.contains('open'), 'the close button should close the floor picker');

  click(doc.querySelector('.campus-building[data-building-id="multi"] rect'));
  key(doc, 'Escape');
  assert(!overlay.classList.contains('open'), 'Escape should close the floor picker');
});

await test('a fetch failure shows an inline error instead of throwing or leaving a blank canvas', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="campus-root"></div></body></html>', { url: 'http://localhost/index.html', virtualConsole: silentConsole });
  global.window = dom.window;
  global.document = dom.window.document;
  global.fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found' });

  const { initCampusPage } = await import(`../js/campus.js?b=${bust++}`);
  await initCampusPage();

  const wrap = dom.window.document.getElementById('campus-canvas-wrap');
  assert(!wrap.querySelector('svg'), 'no campus SVG should render after a failed fetch');
  assert(/couldn.t load/i.test(wrap.textContent), 'expected an inline error message after a failed fetch');
});

/* ══════════════════════════════════════════════════════════════════
   Real seed data: data/campus.json
   ══════════════════════════════════════════════════════════════════ */

await test('data/campus.json seeds a mix of single- and multi-floor buildings', async () => {
  const data = normalizeCampusData(readJson('data/campus.json'));
  assert(data.buildings.length >= 2, 'expected at least two placeholder buildings');

  const counts = data.buildings.map(b => b.floors.length);
  assert(counts.includes(1), 'expected at least one single-floor building');
  assert(counts.some(n => n > 1), 'expected at least one multi-floor building');
});

await test('every floor in data/campus.json points at a room that actually exists', async () => {
  const data = normalizeCampusData(readJson('data/campus.json'));
  const realRooms = ['commons', 'annex', 'workshop', 'b2-204', 'b2-210'];

  for (const building of data.buildings) {
    for (const floor of building.floors) {
      const stem = roomFileStem(floor.roomId);
      assert(realRooms.includes(stem), `${building.id}: floor roomId "${floor.roomId}" does not match any real room`);
      assert(fs.existsSync(path.join(ROOT, 'data', `${stem}.json`)), `${building.id}: data/${stem}.json is missing`);
      assert(fs.existsSync(path.join(ROOT, 'rooms', `${stem}.html`)), `${building.id}: rooms/${stem}.html is missing`);
    }
  }
});

await test('no building id or room id is duplicated across data/campus.json', async () => {
  const data = normalizeCampusData(readJson('data/campus.json'));
  const buildingIds = data.buildings.map(b => b.id);
  assertEqual(new Set(buildingIds).size, buildingIds.length, 'building ids should be unique');

  const roomIds = data.buildings.flatMap(b => b.floors.map(f => roomFileStem(f.roomId)));
  assertEqual(new Set(roomIds).size, roomIds.length, 'each real room should be reachable from at most one floor');
});

/* ── Report ────────────────────────────────────────────────────────── */

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
