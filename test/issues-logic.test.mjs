/**
 * issues-logic.test.mjs — pure aggregation logic behind the global Issues
 * view and the campus view's building stats. No DOM.
 * Run: node test/issues-logic.test.mjs
 */
import {
  collectIssues, sortIssues, filterIssues, summarizeIssues,
  buildingStats, buildingStatusKey,
} from '../js/issues-logic.js';

const results = [];
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

const ROOMS = [
  { id: 'B2-210', label: 'B2-210', campus: 'Northgate Site' },
  { id: 'ANNEX', label: 'Annex Lab', campus: 'Riverside Site' },
];

const ROOM_DEVICES = {
  'B2-210': [{ id: 'PC1' }, { id: 'PC2' }, { id: 'PC3' }],
  'ANNEX': [{ id: 'PRINTER1' }],
};

function entry(inspectionState, condition, notes) {
  return { inspectionState, condition, notes: notes || '', updatedAt: null };
}

/* ══════════════════════════════════════════════════════════════════
   collectIssues / sortIssues / filterIssues / summarizeIssues
   ══════════════════════════════════════════════════════════════════ */

await test('collectIssues only picks up devices that are checked AND minor/major', async () => {
  const state = {
    'B2-210_PC1': entry('checked', 'major'),
    'B2-210_PC2': entry('checked', 'working'),
    'B2-210_PC3': entry('unchecked', null),
    'ANNEX_PRINTER1': entry('checked', 'minor', 'toner low'),
  };
  const issues = collectIssues(ROOMS, ROOM_DEVICES, state);
  assertEqual(issues.length, 2, 'only PC1 (major) and PRINTER1 (minor) should be issues');
  assert(issues.some(i => i.deviceId === 'PC1' && i.condition === 'major'), 'expected PC1/major');
  assert(issues.some(i => i.deviceId === 'PRINTER1' && i.condition === 'minor' && i.notes === 'toner low'), 'expected PRINTER1/minor with its note');
});

await test('collectIssues ignores not-applicable and untouched devices entirely', async () => {
  const state = { 'B2-210_PC1': entry('not-applicable', null) };
  const issues = collectIssues(ROOMS, ROOM_DEVICES, state);
  assertEqual(issues.length, 0, 'not-applicable and unchecked devices are not issues');
});

await test('collectIssues tolerates a room with no fetched roster yet (empty array default)', async () => {
  const issues = collectIssues(ROOMS, {}, {});
  assertEqual(issues.length, 0, 'a missing roomDevices entry should behave like an empty roster, not throw');
});

await test('sortIssues orders by building, then room, then major-before-minor, then device id', async () => {
  const state = {
    'B2-210_PC1': entry('checked', 'minor'),
    'B2-210_PC2': entry('checked', 'major'),
    'ANNEX_PRINTER1': entry('checked', 'major'),
  };
  const sorted = sortIssues(collectIssues(ROOMS, ROOM_DEVICES, state));
  // Northgate Site < Riverside Site alphabetically; within B2-210, major (PC2) before minor (PC1).
  assertEqual(sorted.map(i => i.deviceId).join(','), 'PC2,PC1,PRINTER1', 'unexpected sort order');
});

await test('filterIssues narrows to major or minor only, "all" (or anything else) passes everything through', async () => {
  const issues = [
    { deviceId: 'a', condition: 'major' },
    { deviceId: 'b', condition: 'minor' },
  ];
  assertEqual(filterIssues(issues, 'major').length, 1, 'expected only the major entry');
  assertEqual(filterIssues(issues, 'minor').length, 1, 'expected only the minor entry');
  assertEqual(filterIssues(issues, 'all').length, 2, '"all" should pass everything through');
});

await test('summarizeIssues counts total/rooms/major/minor correctly, including the empty case', async () => {
  const state = {
    'B2-210_PC1': entry('checked', 'major'),
    'B2-210_PC2': entry('checked', 'minor'),
    'ANNEX_PRINTER1': entry('checked', 'major'),
  };
  const summary = summarizeIssues(collectIssues(ROOMS, ROOM_DEVICES, state));
  assertEqual(summary.total, 3, 'expected 3 total issues');
  assertEqual(summary.rooms, 2, 'expected 2 distinct rooms');
  assertEqual(summary.major, 2, 'expected 2 major');
  assertEqual(summary.minor, 1, 'expected 1 minor');

  const empty = summarizeIssues([]);
  assertEqual(empty.total, 0, 'empty summary should be all zeros, not throw');
  assertEqual(empty.rooms, 0, 'empty summary rooms should be 0');
});

/* ══════════════════════════════════════════════════════════════════
   buildingStats / buildingStatusKey
   ══════════════════════════════════════════════════════════════════ */

const FLOORS = [{ roomId: 'B2-210', label: 'B2-210' }, { roomId: 'B2-204', label: 'B2-204' }];
const TOWER_DEVICES = {
  'B2-210': [{ id: 'PC1' }, { id: 'PC2' }],
  'B2-204': [{ id: 'PC3' }, { id: 'PC4' }],
};

await test('buildingStats sums per-floor computeStats across every floor in the building', async () => {
  const state = {
    'B2-210_PC1': entry('checked', 'working'),
    'B2-210_PC2': entry('checked', 'minor'),
    'B2-204_PC3': entry('unchecked', null),
    'B2-204_PC4': entry('not-applicable', null),
  };
  const stats = buildingStats(FLOORS, TOWER_DEVICES, state);
  assertEqual(stats.total, 4, 'expected 4 devices total across both floors');
  assertEqual(stats.inspected, 2, 'expected 2 inspected (working + minor)');
  assertEqual(stats.unchecked, 1, 'expected 1 unchecked');
  assertEqual(stats.notApplicable, 1, 'expected 1 not-applicable');
  assertEqual(stats.issues, 1, 'expected 1 issue (the minor)');
});

await test('buildingStats tolerates a floor with no fetched roster yet', async () => {
  const stats = buildingStats(FLOORS, {}, {});
  assertEqual(stats.total, 0, 'a missing roster should contribute 0 devices, not throw');
});

await test('buildingStatusKey: has-issues wins even when most devices are untouched', async () => {
  const stats = { total: 10, inspected: 1, unchecked: 8, notApplicable: 0, issues: 1 };
  assertEqual(buildingStatusKey(stats), 'has-issues', 'a single issue should override "mostly unchecked"');
});

await test('buildingStatusKey: not-inspected when every device is still unchecked (or there are none)', async () => {
  assertEqual(buildingStatusKey({ total: 5, inspected: 0, unchecked: 5, notApplicable: 0, issues: 0 }), 'not-inspected', 'all-unchecked should read as not-inspected');
  assertEqual(buildingStatusKey({ total: 0, inspected: 0, unchecked: 0, notApplicable: 0, issues: 0 }), 'not-inspected', 'a building with no devices yet should read as not-inspected');
});

await test('buildingStatusKey: complete when nothing is left unchecked and there are no issues', async () => {
  const stats = { total: 4, inspected: 3, unchecked: 0, notApplicable: 1, issues: 0 };
  assertEqual(buildingStatusKey(stats), 'complete', 'zero unchecked with zero issues should read as complete');
});

await test('buildingStatusKey: in-progress for a partially-checked building with no issues', async () => {
  const stats = { total: 10, inspected: 4, unchecked: 6, notApplicable: 0, issues: 0 };
  assertEqual(buildingStatusKey(stats), 'in-progress', 'expected in-progress for a partial sweep with no issues');
});

/* ── Report ────────────────────────────────────────────────────────── */

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
