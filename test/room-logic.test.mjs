/**
 * room-logic.test.mjs — pure logic behind the room workstation: inspection
 * order, next-unchecked lookup, stats, filter matching, search matching.
 * No DOM needed — see js/room-logic.js's own header for why this is split
 * out from room.js. Run: node test/room-logic.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const results = [];

const {
  orderDevicesForInspection, findNextUnchecked, computeStats,
  matchesFilter, matchesSearch, buildSearchHaystack,
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
   orderDevicesForInspection — row-major, derived from top/left only
   ══════════════════════════════════════════════════════════════════ */

await test('orders top-to-bottom, then left-to-right within a shared row', async () => {
  const devices = [
    { id: 'B', top: 60, left: 200 },
    { id: 'A', top: 60, left: 100 },
    { id: 'C', top: 10, left: 999 },
  ];
  const ordered = orderDevicesForInspection(devices).map(d => d.id);
  assertEqual(ordered.join(','), 'C,A,B', 'expected the top row first, then left-to-right within a row');
});

await test('does not mutate the input array or the device objects', async () => {
  const devices = [{ id: 'B', top: 5, left: 5 }, { id: 'A', top: 0, left: 0 }];
  const before = JSON.stringify(devices);
  orderDevicesForInspection(devices);
  assertEqual(JSON.stringify(devices), before, 'input array/order was mutated in place');
});

await test('tolerates missing/non-numeric top or left instead of throwing', async () => {
  const devices = [{ id: 'A' }, { id: 'B', top: 5, left: 5 }];
  const ordered = orderDevicesForInspection(devices).map(d => d.id);
  assertEqual(ordered.join(','), 'A,B', 'a device with no top/left should sort as if at (0,0)');
});

await test('matches the real commons.json layout: PC1..PC5 read left-to-right on their row', async () => {
  const data = readJson('data/commons.json');
  const ordered = orderDevicesForInspection(data.devices).map(d => d.id);
  const rowStart = ordered.indexOf('PC1');
  assertEqual(ordered.slice(rowStart, rowStart + 5).join(','), 'PC1,PC2,PC3,PC4,PC5', 'PC1..PC5 should read in id order along their shared row');
});

/* ══════════════════════════════════════════════════════════════════
   findNextUnchecked
   ══════════════════════════════════════════════════════════════════ */

const isUncheckedFrom = statuses => d => !(d.id in statuses);

await test('finds the first unchecked device from the top when nothing is given as "after"', async () => {
  const ordered = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  const next = findNextUnchecked(ordered, isUncheckedFrom({ A: 1 }));
  assertEqual(next.id, 'B', 'expected the first unchecked device after the already-checked A');
});

await test('resumes after the given device rather than restarting from the top', async () => {
  const ordered = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  const next = findNextUnchecked(ordered, () => true, 'A');
  assertEqual(next.id, 'B', 'expected the device right after "A", not A itself again');
});

await test('wraps around once instead of stopping at the end of the list', async () => {
  const ordered = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  const next = findNextUnchecked(ordered, isUncheckedFrom({ B: 1, C: 1 }), 'B');
  assertEqual(next.id, 'A', 'expected to wrap around to A, the only unchecked device left');
});

await test('returns null when every device is already checked', async () => {
  const ordered = [{ id: 'A' }, { id: 'B' }];
  assertEqual(findNextUnchecked(ordered, isUncheckedFrom({ A: 1, B: 1 })), null, 'expected null when nothing is left to check');
});

await test('returns null for an empty device list instead of throwing', async () => {
  assertEqual(findNextUnchecked([], () => true), null, 'an empty room should return null, not throw');
});

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

/* ── Report ────────────────────────────────────────────────────────── */

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
