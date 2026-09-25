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
 *  mirroring room.test.mjs's mount() for room.js. `roomDevices` (optional) is
 *  `{ [roomId]: devices[] }`, served as `data/{stem}.json` for campus.js's own
 *  lazy per-building stats fetch — any room not listed resolves to an empty
 *  roster (fetchRoomDevices() already tolerates that), same as a room whose
 *  data file 404s in production. `statusByStem` (optional) is
 *  `{ [stem]: 'draft' | 'final' }` — any stem in `roomDevices` not listed
 *  here defaults to 'final', so every call site written before draft/final
 *  existed keeps behaving exactly as it did. localStorage backs state.js's
 *  loadState() exactly as a real browser would. */
async function mountCampus(campusJson, roomDevices = {}, stateEntries = {}, statusByStem = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="campus-root"></div></body></html>', {
    url: 'http://localhost/index.html', virtualConsole: silentConsole,
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  if (Object.keys(stateEntries).length) {
    global.localStorage.setItem('it-room-monitor-v1', JSON.stringify(stateEntries));
  }
  global.fetch = async url => {
    const s = String(url);
    if (s.includes('campus.json')) return { ok: true, json: async () => campusJson };
    const m = /data\/([a-z0-9-]+)\.json$/.exec(s);
    if (m) {
      // A stem not listed in roomDevices at all still resolves successfully
      // (empty roster, status final) — same "don't care about this room for
      // this test" shorthand tests already relied on before draft/final
      // existed. A genuine fetch failure is simulated by overriding
      // global.fetch directly (see the dedicated failure test below), not
      // through this helper.
      const devices = roomDevices[m[1]] || [];
      const status = statusByStem[m[1]] || 'final';
      return { ok: true, json: async () => ({ devices, status }) };
    }
    return { ok: false, status: 404, statusText: 'Not Found' };
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

/* ══════════════════════════════════════════════════════════════════
   Draft (not-yet-finalized) rooms in campus nav — a floor whose room is
   still draft must never silently navigate or error; it shows a clear
   "not yet finalized" state instead.
   ══════════════════════════════════════════════════════════════════ */

await test('clicking a single-floor building whose room is still draft shows a "not yet finalized" notice instead of navigating', async () => {
  const { doc } = await mountCampus(SAMPLE, { commons: [{ id: 'PC1' }] }, {}, { commons: 'draft' });
  click(doc.querySelector('.campus-building[data-building-id="single"] rect'));

  const overlay = doc.getElementById('floor-picker-overlay');
  assert(overlay.classList.contains('open'), 'expected a notice to open rather than silently doing nothing');
  assert(/finalized/i.test(doc.getElementById('floor-picker-body').textContent), 'expected a clear not-yet-finalized message');
  const links = [...doc.querySelectorAll('#floor-picker-list a')];
  assert(!links.some(a => a.getAttribute('href') === 'rooms/commons.html'), 'should not offer a link straight into the draft room');
});

await test('a final single-floor building still navigates directly once its status is confirmed final', async () => {
  const { doc } = await mountCampus(SAMPLE, { commons: [{ id: 'PC1' }] }, {}, { commons: 'final' });
  click(doc.querySelector('.campus-building[data-building-id="single"] rect'));
  assert(!doc.getElementById('floor-picker-overlay').classList.contains('open'), 'a final single-floor building should navigate directly, not show a notice');
});

await test('a multi-floor picker lists a draft floor as non-clickable "Not yet finalized", alongside a normal link for the final one', async () => {
  const { doc } = await mountCampus(SAMPLE, {
    'b2-210': [{ id: 'PC1' }], 'b2-204': [{ id: 'PC2' }],
  }, {}, { 'b2-210': 'final', 'b2-204': 'draft' });
  click(doc.querySelector('.campus-building[data-building-id="multi"] rect'));

  const list = doc.getElementById('floor-picker-list');
  const links = [...list.querySelectorAll('a.room-link')];
  assertEqual(links.map(a => a.getAttribute('href')).join(','), 'rooms/b2-210.html', 'only the final floor should be a real link');
  assert(list.querySelector('.room-link-disabled'), 'the draft floor should render as a disabled entry');
  assert(/not yet finalized/i.test(list.textContent), 'the draft floor\'s entry should say so');
});

await test('a draft floor never contributes to its building\'s aggregate stats or status marker', async () => {
  const { doc } = await mountCampus(SAMPLE, {
    'b2-210': [{ id: 'PC1' }],
    'b2-204': [{ id: 'PC2' }],
  }, {
    // If the draft floor's device leaked into the aggregate, this major
    // would flip the building to has-issues.
    'B2-204_PC2': { inspectionState: 'checked', condition: 'major', notes: '', updatedAt: null },
  }, { 'b2-210': 'final', 'b2-204': 'draft' });

  assertEqual(marker(doc, 'multi').dataset.state, 'not-inspected', 'the draft floor\'s major device should never count toward the building\'s status marker');
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
   Building stats: lazy per-building fetch, the status marker, and the
   hover/focus tooltip reveal
   ══════════════════════════════════════════════════════════════════ */

function marker(doc, buildingId) {
  return doc.querySelector(`.campus-building[data-building-id="${buildingId}"] .campus-building-status`);
}

await test('a building with an unchecked device and no issues marks itself in-progress', async () => {
  const { doc } = await mountCampus(SAMPLE, { commons: [{ id: 'PC1' }, { id: 'PC2' }] }, {
    'COMMONS_PC1': { inspectionState: 'checked', condition: 'working', notes: '', updatedAt: null },
  });
  assertEqual(marker(doc, 'single').dataset.state, 'in-progress', 'one checked + one unchecked, no issues, should read in-progress');
});

await test('a fully-checked building with no issues marks itself complete', async () => {
  const { doc } = await mountCampus(SAMPLE, { commons: [{ id: 'PC1' }] }, {
    'COMMONS_PC1': { inspectionState: 'checked', condition: 'working', notes: '', updatedAt: null },
  });
  assertEqual(marker(doc, 'single').dataset.state, 'complete', 'a fully-checked, issue-free building should read complete');
});

await test('a building with even one minor/major device marks itself has-issues, overriding the other states', async () => {
  const { doc } = await mountCampus(SAMPLE, { commons: [{ id: 'PC1' }] }, {
    'COMMONS_PC1': { inspectionState: 'checked', condition: 'major', notes: '', updatedAt: null },
  });
  assertEqual(marker(doc, 'single').dataset.state, 'has-issues', 'a single major device should override every other state');
});

await test('a building with no touched devices at all marks itself not-inspected', async () => {
  const { doc } = await mountCampus(SAMPLE, { commons: [{ id: 'PC1' }] });
  assertEqual(marker(doc, 'single').dataset.state, 'not-inspected', 'an untouched building should read not-inspected');
});

await test('a multi-floor building\'s stats sum every floor, keyed by the real (differently-cased) room id, not the campus.json stem', async () => {
  const { doc } = await mountCampus(SAMPLE, {
    'b2-210': [{ id: 'PC1' }, { id: 'PC2' }],
    'b2-204': [{ id: 'PC3' }],
  }, {
    // Real stored keys use the uppercase ROOM_META id (B2-210), never the
    // lowercase campus.json stem (b2-210) — this is the exact mismatch
    // canonicalRoomId() in campus.js exists to bridge.
    'B2-210_PC1': { inspectionState: 'checked', condition: 'working', notes: '', updatedAt: null },
    'B2-210_PC2': { inspectionState: 'checked', condition: 'minor', notes: '', updatedAt: null },
    'B2-204_PC3': { inspectionState: 'unchecked', condition: null, notes: '', updatedAt: null },
  });
  assertEqual(marker(doc, 'multi').dataset.state, 'has-issues', 'the minor device on one floor should still be picked up and flip the whole building to has-issues');
});

await test('hovering a building reveals its device/inspected/remaining/issue counts in a tooltip', async () => {
  const { doc, dom } = await mountCampus(SAMPLE, { commons: [{ id: 'PC1' }, { id: 'PC2' }] }, {
    'COMMONS_PC1': { inspectionState: 'checked', condition: 'major', notes: '', updatedAt: null },
  });
  const tooltip = doc.getElementById('campus-tooltip');
  assert(tooltip.hidden, 'tooltip should start hidden');

  const g = doc.querySelector('.campus-building[data-building-id="single"]');
  g.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
  assert(!tooltip.hidden, 'tooltip should be revealed on hover');
  assert(tooltip.textContent.includes('2 device'), `expected device count in tooltip, got: ${tooltip.textContent}`);
  assert(tooltip.textContent.includes('1 inspected'), `expected inspected count in tooltip, got: ${tooltip.textContent}`);
  assert(tooltip.textContent.includes('1 remaining'), `expected remaining count in tooltip, got: ${tooltip.textContent}`);
  assert(tooltip.textContent.includes('1 issue'), `expected issue count in tooltip, got: ${tooltip.textContent}`);

  g.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true }));
  assert(tooltip.hidden, 'tooltip should hide again on mouseout');
});

await test('keyboard focus reveals the same tooltip hover does, for reachability without a mouse', async () => {
  const { doc, dom } = await mountCampus(SAMPLE, { commons: [{ id: 'PC1' }] });
  const tooltip = doc.getElementById('campus-tooltip');
  const g = doc.querySelector('.campus-building[data-building-id="single"]');

  g.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }));
  assert(!tooltip.hidden, 'tooltip should be revealed on keyboard focus');

  g.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
  assert(tooltip.hidden, 'tooltip should hide again on blur');
});

await test('the default (unselected) building block never renders full stats inline — only name + floor count', async () => {
  const { doc } = await mountCampus(SAMPLE, { commons: [{ id: 'PC1' }] }, {
    'COMMONS_PC1': { inspectionState: 'checked', condition: 'major', notes: '', updatedAt: null },
  });
  const g = doc.querySelector('.campus-building[data-building-id="single"]');
  assert(!/\d+ inspected/.test(g.textContent), 'device/inspected counts should never render inline in the static block, only in the hover/focus tooltip');
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
