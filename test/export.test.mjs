/**
 * export.test.mjs — the CSV report is roster-complete (every device in
 * every room appears, even ones nobody has ever clicked) and reflects the
 * two-part inspectionState/condition model correctly. No DOM needed for
 * `buildRoomRows` itself — see export.js's own split between that pure
 * row-building step and the DOM-dependent download/prompt plumbing.
 * Run: node test/export.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const results = [];

const { buildRoomRows, fetchRoomDevices, ALL_ROOMS } = await import('../js/export.js');

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

const ROOM = { id: 'COMMONS', label: 'Commons', campus: 'Northgate Site' };

/* ══════════════════════════════════════════════════════════════════
   Roster-completeness — the whole point of this pass
   ══════════════════════════════════════════════════════════════════ */

await test('every device in the roster gets a row, even ones with no localStorage entry at all', async () => {
  const data = readJson('data/commons.json');
  const rows = buildRoomRows(ROOM, data.devices, {}); // empty state — nothing ever touched
  assertEqual(rows.length, data.devices.length, `expected one row per roster device (${data.devices.length}), got ${rows.length}`);
  const ids = rows.map(r => r[2]);
  for (const d of data.devices) {
    assert(ids.includes(d.id), `device ${d.id} missing from the export — untouched devices must still appear`);
  }
});

await test('an untouched device exports as "Not Checked", not blank/absent', async () => {
  const devices = [{ id: 'PC1' }, { id: 'PC2' }];
  const rows = buildRoomRows(ROOM, devices, {});
  const pc1Row = rows.find(r => r[2] === 'PC1');
  assertEqual(pc1Row[3], 'Not Checked', 'untouched device should read "Not Checked"');
  assertEqual(pc1Row[4], 'No', 'untouched device is not "Working"');
});

await test('a room with zero devices still produces a placeholder row instead of an empty file', async () => {
  const rows = buildRoomRows(ROOM, [], {});
  assertEqual(rows.length, 1, 'expected exactly one placeholder row for a device-less room');
  assertEqual(rows[0][3], 'No devices', 'placeholder row should say so, not read as a real status');
});

/* ══════════════════════════════════════════════════════════════════
   Two-part model → CSV columns
   ══════════════════════════════════════════════════════════════════ */

await test('checked+condition, unchecked, and not-applicable each get their own row label', async () => {
  const devices = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }];
  const state = {
    'COMMONS_A': { inspectionState: 'checked', condition: 'working', notes: '', updatedAt: null },
    'COMMONS_B': { inspectionState: 'checked', condition: 'major', notes: 'no power', updatedAt: null },
    'COMMONS_C': { inspectionState: 'not-applicable', condition: null, notes: '', updatedAt: null },
    // D: no entry at all → unchecked
  };
  const rows = buildRoomRows(ROOM, devices, state);
  const byId = Object.fromEntries(rows.map(r => [r[2], r]));
  assertEqual(byId['A'][3], 'Working', 'A should read Working');
  assertEqual(byId['A'][4], 'Yes', 'A is working, so the Working column should be Yes');
  assertEqual(byId['B'][3], 'Major', 'B should read Major');
  assertEqual(byId['B'][5], 'no power', 'B\'s note should carry through to the Notes column');
  assertEqual(byId['C'][3], 'Not Applicable', 'C should read Not Applicable');
  assertEqual(byId['D'][3], 'Not Checked', 'D (no entry) should read Not Checked');
});

await test('rows sort worst-first: major, minor, unchecked, working, not-applicable last', async () => {
  const devices = [{ id: 'W' }, { id: 'M' }, { id: 'J' }, { id: 'U' }, { id: 'N' }];
  const state = {
    'COMMONS_W': { inspectionState: 'checked', condition: 'working' },
    'COMMONS_M': { inspectionState: 'checked', condition: 'minor' },
    'COMMONS_J': { inspectionState: 'checked', condition: 'major' },
    'COMMONS_N': { inspectionState: 'not-applicable', condition: null },
    // U: unchecked, no entry
  };
  const rows = buildRoomRows(ROOM, devices, state);
  assertEqual(rows.map(r => r[2]).join(','), 'J,M,U,W,N', 'expected major,minor,unchecked,working,not-applicable order');
});

/* ══════════════════════════════════════════════════════════════════
   fetchRoomDevices — used to build the full multi-room roster
   ══════════════════════════════════════════════════════════════════ */

await test('fetchRoomDevices calls dataUrlFor with the lowercase room stem', async () => {
  const seen = [];
  global.fetch = async url => {
    seen.push(url);
    return { ok: true, json: async () => ({ devices: [{ id: 'X1' }] }) };
  };
  const devices = await fetchRoomDevices({ id: 'B2-210' }, stem => `../data/${stem}.json`);
  assertEqual(seen[0], '../data/b2-210.json', `expected the lowercase stem in the fetched URL, got ${seen[0]}`);
  assertEqual(devices.length, 1, 'expected the devices array from the fetched JSON');
});

await test('fetchRoomDevices degrades to an empty roster instead of throwing on a network/parse failure', async () => {
  global.fetch = async () => { throw new Error('offline'); };
  const devices = await fetchRoomDevices({ id: 'ANNEX' }, stem => `../data/${stem}.json`);
  assertEqual(devices.length, 0, 'a failed fetch should yield an empty roster, not throw');
});

await test('fetchRoomDevices also tolerates a non-ok response', async () => {
  global.fetch = async () => ({ ok: false });
  const devices = await fetchRoomDevices({ id: 'ANNEX' }, stem => `../data/${stem}.json`);
  assertEqual(devices.length, 0, 'a non-ok response should yield an empty roster');
});

await test('ALL_ROOMS still lists every room export.js knows about (unchanged by this pass)', async () => {
  assert(ALL_ROOMS.length >= 5, 'expected at least the 5 real rooms in ALL_ROOMS');
});

/* ── Report ────────────────────────────────────────────────────── */

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
