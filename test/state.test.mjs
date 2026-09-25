/**
 * state.test.mjs — the localStorage migration from the old single-status
 * shape to the current two-part inspectionState/condition shape. Uses
 * representative OLD-shape sample data (not freshly-created new-shape
 * data) throughout, since the whole point of this migration is that real
 * browsers already have data in the old shape.
 * Run: node test/state.test.mjs
 */
import { JSDOM } from 'jsdom';

const results = [];
const STORAGE_KEY = 'it-room-monitor-v1';

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

let bust = 0;
/** Fresh localStorage seeded with the given raw (old- or new-shape) blob,
 *  then a fresh import of state.js so no module-level state leaks between
 *  tests. */
async function withSeed(raw) {
  const dom = new JSDOM('', { url: 'http://localhost/' });
  global.localStorage = dom.window.localStorage;
  global.localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));
  return import(`../js/state.js?b=${bust++}`);
}

/* ══════════════════════════════════════════════════════════════════
   Migration — representative OLD-shape sample data
   ══════════════════════════════════════════════════════════════════ */

await test('migrates an old working/minor/major status into checked + that condition', async () => {
  const { loadState } = await withSeed({
    'COMMONS_PC1': { status: 'working', notes: '', updatedAt: '2026-01-05T10:00:00.000Z' },
    'COMMONS_PC2': { status: 'minor', notes: 'mouse missing', updatedAt: '2026-01-05T10:05:00.000Z' },
    'COMMONS_PC3': { status: 'major', notes: '', updatedAt: '2026-01-05T10:10:00.000Z' },
  });
  const state = loadState();
  assertEqual(state['COMMONS_PC1'].inspectionState, 'checked', 'PC1 should have migrated to checked');
  assertEqual(state['COMMONS_PC1'].condition, 'working', 'PC1 condition should be working');
  assertEqual(state['COMMONS_PC2'].inspectionState, 'checked', 'PC2 should have migrated to checked');
  assertEqual(state['COMMONS_PC2'].condition, 'minor', 'PC2 condition should be minor');
  assertEqual(state['COMMONS_PC2'].notes, 'mouse missing', 'PC2 notes should survive migration');
  assertEqual(state['COMMONS_PC3'].condition, 'major', 'PC3 condition should be major');
  assertEqual(state['COMMONS_PC1'].updatedAt, '2026-01-05T10:00:00.000Z', 'updatedAt should survive migration');
});

await test('migrates an old explicit "unknown" status into unchecked, keeping any notes', async () => {
  const { loadState } = await withSeed({
    'COMMONS_PC4': { status: 'unknown', notes: 'left a note before marking unchecked', updatedAt: '2026-01-05T09:00:00.000Z' },
  });
  const state = loadState();
  assertEqual(state['COMMONS_PC4'].inspectionState, 'unchecked', 'old "unknown" should migrate to unchecked');
  assertEqual(state['COMMONS_PC4'].condition, null, 'unchecked should carry no condition');
  assertEqual(state['COMMONS_PC4'].notes, 'left a note before marking unchecked', 'notes should survive even for an unchecked entry');
});

await test('migrates an old entry with a missing/unrecognized status to unchecked instead of throwing', async () => {
  const { loadState } = await withSeed({
    'COMMONS_PC5': { notes: 'no status field at all', updatedAt: '2026-01-05T09:00:00.000Z' },
    'COMMONS_PC6': { status: 'weird-legacy-value', notes: '' },
  });
  const state = loadState();
  assertEqual(state['COMMONS_PC5'].inspectionState, 'unchecked', 'an entry with no status field should migrate to unchecked');
  assertEqual(state['COMMONS_PC6'].inspectionState, 'unchecked', 'an unrecognized status value should migrate to unchecked, not crash');
  assertEqual(state['COMMONS_PC6'].condition, null, 'an unrecognized status should carry no condition');
});

await test('migration never wipes data — a mixed old-shape blob keeps every key', async () => {
  const raw = {
    'COMMONS_PC1': { status: 'working', notes: '', updatedAt: '2026-01-01T00:00:00.000Z' },
    'ANNEX_PRINTER': { status: 'major', notes: 'jammed', updatedAt: '2026-01-02T00:00:00.000Z' },
    'WORKSHOP_STAFF1': { status: 'unknown', notes: '', updatedAt: '2026-01-03T00:00:00.000Z' },
  };
  const { loadState } = await withSeed(raw);
  const state = loadState();
  assertEqual(Object.keys(state).length, Object.keys(raw).length, 'migration should preserve every key, not drop any');
  assert(state['COMMONS_PC1'] && state['ANNEX_PRINTER'] && state['WORKSHOP_STAFF1'], 'every original key should still be present after migration');
});

await test('an already-new-shape entry passes through unchanged (migration is idempotent)', async () => {
  const alreadyMigrated = { inspectionState: 'not-applicable', condition: null, notes: 'decommissioned', updatedAt: '2026-02-01T00:00:00.000Z' };
  const { loadState } = await withSeed({ 'COMMONS_PC9': alreadyMigrated });
  const state = loadState();
  assertEqual(JSON.stringify(state['COMMONS_PC9']), JSON.stringify(alreadyMigrated), 'a new-shape entry should not be altered by loadState');
});

await test('loading old-shape data does not itself rewrite localStorage — migration is read-time and non-destructive', async () => {
  const raw = { 'COMMONS_PC1': { status: 'working', notes: '', updatedAt: '2026-01-01T00:00:00.000Z' } };
  const { loadState } = await withSeed(raw);
  loadState();
  const stillStored = JSON.parse(global.localStorage.getItem(STORAGE_KEY));
  assertEqual(stillStored['COMMONS_PC1'].status, 'working', 'reading state should not silently rewrite the stored old-shape blob');
});

await test('saving after a migrated read persists the new shape (the real, deferred write-back path)', async () => {
  const raw = { 'COMMONS_PC1': { status: 'minor', notes: 'sticky key', updatedAt: '2026-01-01T00:00:00.000Z' } };
  const { loadState, saveState } = await withSeed(raw);
  const migrated = loadState();
  saveState(migrated);
  const stored = JSON.parse(global.localStorage.getItem(STORAGE_KEY));
  assertEqual(stored['COMMONS_PC1'].inspectionState, 'checked', 'a save after a migrated read should persist the new shape');
  assertEqual(stored['COMMONS_PC1'].condition, 'minor', 'the migrated condition should be what gets persisted');
});

/* ── Report ────────────────────────────────────────────────────── */

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
