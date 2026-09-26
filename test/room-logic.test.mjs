/**
 * room-logic.test.mjs — pure logic behind the room workstation: stats,
 * filter matching, search matching, and the zoom/pan fit math. No DOM
 * needed — see js/room-logic.js's own header for why this is split out
 * from room.js. Run: node test/room-logic.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const results = [];

const {
  computeStats,
  matchesFilter, matchesSearch, buildSearchHaystack,
  deviceFootprint, computeContentBounds, computeFitScale, computeFitPan,
} = await import('../js/room-logic.js');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
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

/* ══════════════════════════════════════════════════════════════════
   computeStats — two-part model: inspectionState + condition
   ══════════════════════════════════════════════════════════════════ */

await test('computeStats counts each condition, not-applicable, and unchecked separately', async () => {
  const devices = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }, { id: 'F' }];
  const table = {
    A: { inspectionState: 'checked', condition: 'working' },
    B: { inspectionState: 'checked', condition: 'working' },
    C: { inspectionState: 'checked', condition: 'minor' },
    D: { inspectionState: 'checked', condition: 'major' },
    E: { inspectionState: 'not-applicable', condition: null },
  };
  const inspectionFor = d => table[d.id] || { inspectionState: 'unchecked', condition: null };
  const stats = computeStats(devices, inspectionFor);
  assertEqual(stats.total, 6, 'total wrong');
  assertEqual(stats.working, 2, 'working count wrong');
  assertEqual(stats.minor, 1, 'minor count wrong');
  assertEqual(stats.major, 1, 'major count wrong');
  assertEqual(stats.notApplicable, 1, 'not-applicable count wrong');
  assertEqual(stats.unchecked, 1, 'unchecked count wrong (F, with no table entry)');
  assertEqual(stats.inspected, 4, 'inspected (checked devices only, not-applicable excluded) wrong');
  assertEqual(stats.issues, 2, 'issues (minor + major) wrong');
});

await test('computeStats on an empty room is all zeroes, not NaN', async () => {
  const stats = computeStats([], () => ({ inspectionState: 'unchecked', condition: null }));
  assertEqual(stats.total, 0, 'total wrong');
  assertEqual(stats.inspected, 0, 'inspected wrong');
  assertEqual(stats.notApplicable, 0, 'notApplicable wrong');
  assertEqual(stats.issues, 0, 'issues wrong');
});

/* ══════════════════════════════════════════════════════════════════
   matchesFilter — 'all'/'unchecked'/'checked'/'not-applicable'/
   'working'/'minor'/'major'/'notes'
   ══════════════════════════════════════════════════════════════════ */

await test('matchesFilter: "all" always matches regardless of inspection state', async () => {
  assert(matchesFilter('checked', 'major', false, 'all'), 'all should match a checked+major device');
  assert(matchesFilter('unchecked', null, false, 'all'), 'all should match an unchecked device');
  assert(matchesFilter('not-applicable', null, false, 'all'), 'all should match a not-applicable device');
});

await test('matchesFilter: "unchecked"/"checked"/"not-applicable" match inspection state only', async () => {
  assert(matchesFilter('unchecked', null, false, 'unchecked'), 'unchecked filter should match an unchecked device');
  assert(!matchesFilter('checked', 'working', false, 'unchecked'), 'unchecked filter should not match a checked device');
  assert(matchesFilter('checked', 'working', false, 'checked'), 'checked filter should match any condition');
  assert(matchesFilter('checked', 'major', false, 'checked'), 'checked filter should match major too');
  assert(!matchesFilter('not-applicable', null, false, 'checked'), 'checked filter should not match not-applicable');
  assert(matchesFilter('not-applicable', null, false, 'not-applicable'), 'not-applicable filter should match a not-applicable device');
  assert(!matchesFilter('unchecked', null, false, 'not-applicable'), 'not-applicable filter should not match an unchecked device');
});

await test('matchesFilter: "working"/"minor"/"major" require checked AND that specific condition', async () => {
  assert(matchesFilter('checked', 'working', false, 'working'), 'working filter should match checked+working');
  assert(!matchesFilter('checked', 'minor', false, 'working'), 'working filter should not match checked+minor');
  assert(matchesFilter('checked', 'minor', false, 'minor'), 'minor filter should match checked+minor');
  assert(matchesFilter('checked', 'major', false, 'major'), 'major filter should match checked+major');
  assert(!matchesFilter('unchecked', null, false, 'working'), 'working filter should never match an unchecked device');
});

await test('matchesFilter: "notes" matches purely on hasNotes, regardless of inspection state', async () => {
  assert(matchesFilter('checked', 'working', true, 'notes'), 'notes filter should match a working device with a note');
  assert(!matchesFilter('checked', 'major', false, 'notes'), 'notes filter should not match a major device with no note');
});

/* ══════════════════════════════════════════════════════════════════
   matchesSearch / buildSearchHaystack
   ══════════════════════════════════════════════════════════════════ */

await test('matchesSearch is a case-insensitive substring match', async () => {
  assert(matchesSearch('PC7 Commons working', 'pc7'), 'lowercase query should match mixed-case haystack');
  assert(matchesSearch('PC7 Commons working', 'COMMONS'), 'uppercase query should match');
  assert(!matchesSearch('PC7 Commons working', 'workshop'), 'unrelated query should not match');
});

await test('matchesSearch: a blank query matches nothing (no accidental "show everything")', async () => {
  assert(!matchesSearch('PC7 Commons working', ''), 'an empty query should not match');
  assert(!matchesSearch('PC7 Commons working', '   '), 'a whitespace-only query should not match');
});

await test('buildSearchHaystack includes every present field and skips missing ones cleanly', async () => {
  const haystack = buildSearchHaystack({
    roomId: 'COMMONS', roomLabel: 'Commons',
    device: { id: 'PC7', label: 'PC7', assetId: 'AST-4K9QXZ' },
    statusWord: 'major issue', notes: 'no power',
    assetRecord: { manufacturer: 'Dell', serial: 'SN123' },
  });
  for (const term of ['COMMONS', 'Commons', 'PC7', 'AST-4K9QXZ', 'major issue', 'no power', 'Dell', 'SN123']) {
    assert(matchesSearch(haystack, term), `haystack missing expected term "${term}": "${haystack}"`);
  }
});

await test('buildSearchHaystack omits missing optional fields instead of stringifying undefined', async () => {
  const haystack = buildSearchHaystack({
    roomId: 'COMMONS', roomLabel: 'Commons',
    device: { id: 'PC1', label: 'PC1' },
    statusWord: 'not checked', notes: '', assetRecord: null,
  });
  assert(!/undefined/.test(haystack), `haystack should never contain the literal word "undefined": "${haystack}"`);
});

/* ══════════════════════════════════════════════════════════════════
   Fit-to-screen geometry — deviceFootprint / computeContentBounds /
   computeFitScale / computeFitPan
   ══════════════════════════════════════════════════════════════════ */

await test('deviceFootprint matches floor-plan.css\'s actual chip sizes, including the wide-over-staff precedence', async () => {
  assertEqual(JSON.stringify(deviceFootprint({ type: 'printer' })), JSON.stringify({ width: 88, height: 44 }), 'printer footprint');
  assertEqual(JSON.stringify(deviceFootprint({ id: 'PC1' })), JSON.stringify({ width: 42, height: 42 }), 'plain PC footprint');
  assertEqual(JSON.stringify(deviceFootprint({ type: 'staff', id: 'S1' })), JSON.stringify({ width: 52, height: 42 }), 'staff PC footprint');
  assertEqual(JSON.stringify(deviceFootprint({ id: 'STAFF-PC1' })), JSON.stringify({ width: 64, height: 42 }), 'a long label alone (>5 chars) should widen to 64, wide-chip rule');
  assertEqual(JSON.stringify(deviceFootprint({ type: 'staff', label: 'STAFF-PC1' })), JSON.stringify({ width: 64, height: 42 }), 'wide should win over staff when both would apply, matching the CSS cascade');
});

await test('computeContentBounds measures the true drawn extent — walls/rooms/devices — not just the nominal canvas size', async () => {
  const layout = [
    { type: 'outline', points: [[100, 80], [1100, 80], [1100, 730], [100, 730]] },
    { type: 'wall', x1: 100, y1: 80, x2: 1100, y2: 80 },
  ];
  // Placed close to the outline's own far corner so its 42×42 footprint
  // pushes the true bounds a little past the outline alone.
  const devices = [{ id: 'PC1', top: 700, left: 1090 }];
  const bounds = computeContentBounds(layout, devices, 1200, 800);
  assertEqual(bounds.minX, 100, 'minX should come from the outline, not the nominal canvas (0)');
  assertEqual(bounds.minY, 80, 'minY should come from the outline, not the nominal canvas (0)');
  assertEqual(bounds.maxX, 1132, 'maxX should extend to the device\'s own right edge (1090+42), past the outline\'s 1100');
  assertEqual(bounds.maxY, 742, 'maxY should extend to the device\'s own bottom edge (700+42), past the outline\'s 730');
});

await test('computeContentBounds falls back to the nominal canvas size when there is truly nothing to measure', async () => {
  const bounds = computeContentBounds([], [], 1200, 800);
  assertEqual(JSON.stringify(bounds), JSON.stringify({ minX: 0, minY: 0, maxX: 1200, maxY: 800 }), 'empty layout/devices should fall back to the nominal canvas size, not throw or return an inverted/Infinity box');
});

await test('computeContentBounds handles x1/y1/x2/y2-style shapes (walls) and x/y/width/height-style shapes (rooms/counters) alike', async () => {
  const layout = [
    { type: 'wall', x1: 10, y1: 500, x2: 10, y2: 10 },
    { type: 'room', x: 400, y: 20, width: 100, height: 50 },
  ];
  const bounds = computeContentBounds(layout, [], 1200, 800);
  assertEqual(bounds.minX, 10, 'expected the wall\'s x to set minX');
  assertEqual(bounds.minY, 10, 'expected the wall\'s y2 to set minY');
  assertEqual(bounds.maxX, 500, 'expected the room\'s x+width to set maxX');
  assertEqual(bounds.maxY, 500, 'expected the wall\'s y1 to set maxY');
});

await test('computeFitScale picks the tighter of width/height — this is the actual regression fix: the old calculation only ever looked at width', async () => {
  const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 500 }; // 2:1 aspect ratio
  // Plenty of width available (would allow 1×), but height is the binding constraint.
  const scale = computeFitScale(bounds, 2000, 300, 0);
  assertEqual(scale, 300 / 500, 'expected the scale to be bound by the shorter dimension (height), not width');
});

await test('computeFitScale never scales past 1× even when the viewport is huge relative to the content', async () => {
  const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 150 };
  assertEqual(computeFitScale(bounds, 5000, 5000, 0), 1, 'fit should never zoom in past actual size automatically');
});

await test('computeFitScale reserves the margin on every side (a smaller effective viewport), not zero', async () => {
  const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  const withoutMargin = computeFitScale(bounds, 1000, 1000, 0);
  const withMargin = computeFitScale(bounds, 1000, 1000, 16);
  assert(withMargin < withoutMargin, 'a positive margin should produce a strictly smaller fit scale than no margin at all');
  assertEqual(withMargin, (1000 - 32) / 1000, 'expected exactly 16px reserved on each side (32px total) to be subtracted before the ratio');
});

await test('computeFitPan centers the content\'s bounding box, not the room\'s raw (0,0) origin — the actual centering fix', async () => {
  // A room whose content starts well inside its nominal canvas (true of
  // every real room but one — see computeContentBounds's own doc comment).
  const bounds = { minX: 100, minY: 80, maxX: 1100, maxY: 730 };
  const scale = 0.5;
  const pan = computeFitPan(bounds, 900, 560, scale);
  // Expected: center the (1000×650) bbox at 0.5× (500×325) within a 900×560
  // viewport, then shift left/up by the bbox's own minX/minY at that scale.
  assertEqual(pan.x, (900 - 1000 * 0.5) / 2 - 100 * 0.5, 'unexpected x pan');
  assertEqual(pan.y, (560 - 650 * 0.5) / 2 - 80 * 0.5, 'unexpected y pan');
});

await test('computeFitScale + computeFitPan together produce a true maximum contain-fit for every real room\'s actual data', async () => {
  for (const stem of ['commons', 'b2-210', 'b2-204', 'annex', 'workshop']) {
    const data = readJson(`data/${stem}.json`);
    const bounds = computeContentBounds(data.layout, data.devices, data.canvasWidth, data.canvasHeight);
    // A representative desktop floor-plan pane size.
    const availableW = 900, availableH = 560, margin = 16;
    const scale = computeFitScale(bounds, availableW, availableH, margin);
    const boundsW = bounds.maxX - bounds.minX, boundsH = bounds.maxY - bounds.minY;
    assert(boundsW * scale <= availableW - margin * 2 + 0.01, `${stem}: fitted content width should not exceed the available width`);
    assert(boundsH * scale <= availableH - margin * 2 + 0.01, `${stem}: fitted content height should not exceed the available height`);
    // At the computed scale, at least one axis should be genuinely tight
    // against its margin-adjusted limit (a "true maximum" fit, not an
    // arbitrarily conservative one) — unless already capped at 1×.
    if (scale < 1) {
      const wTight = Math.abs(boundsW * scale - (availableW - margin * 2)) < 0.5;
      const hTight = Math.abs(boundsH * scale - (availableH - margin * 2)) < 0.5;
      assert(wTight || hTight, `${stem}: expected the fit to be tight against width or height, not leave slack on both`);
    }
  }
});

/* ── Report ────────────────────────────────────────────────────────── */

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
