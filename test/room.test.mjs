/**
 * room.test.mjs — feedback loop for the room page as a workstation.
 *
 * Drives the real js/room.js inside jsdom and asserts on the DOM a checker
 * would actually touch: the inspector panel (not a popup) for ordinary
 * inspection, Inspection Mode, Next Unchecked, filters, search, and the
 * save-status indicator. Reset stays a modal (destructive, room-wide);
 * everything else here goes through the persistent inspector.
 * Run: node test/room.test.mjs
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const results = [];
let bust = 0;

function readRoom(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${name}.json`), 'utf8'));
}

/** Fresh jsdom + fresh module instance, room rendered. Real fetch() is left
 *  alone deliberately for the cross-room search lookups room.js makes —
 *  Node's fetch rejects a relative URL with no base, which room.js already
 *  treats as "that other room didn't load", so this exercises the same
 *  tolerant-failure path a real network hiccup would. */
async function mount(data, meta = {}, seed = null) {
  const dom = new JSDOM('<!doctype html><html><body><div id="room-root"></div></body></html>', {
    url: 'http://localhost/rooms/test.html',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.localStorage = window.localStorage;
  global.Element = window.Element;
  global.HTMLElement = window.HTMLElement;
  global.Node = window.Node;
  global.getComputedStyle = window.getComputedStyle.bind(window);
  global.ResizeObserver = window.ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
  window.localStorage.clear();
  if (seed) window.localStorage.setItem('it-room-monitor-v1', JSON.stringify(seed));

  const { initRoomPage } = await import(`../js/room.js?b=${bust++}`);
  const cfg = {
    id: 'TEST', label: 'Test Room', campus: 'Test Campus', back: '../index.html', assets: {},
    ...meta, ...data,
  };
  initRoomPage(cfg);
  return { dom, window, doc: window.document, cfg };
}

function click(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
}
function input(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true }));
}
function key(doc, k) {
  doc.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: k, bubbles: true }));
}
function readState(window) {
  return JSON.parse(window.localStorage.getItem('it-room-monitor-v1') || '{}');
}

/** Selects a device via a plain floor-plan click and returns it. */
function selectViaClick(doc, deviceId) {
  const el = doc.querySelector(`[data-id="${deviceId}"]`);
  click(el);
  return el;
}

async function test(name, fn) {
  try { await fn(); results.push(['PASS', name, '']); }
  catch (err) { results.push(['FAIL', name, err.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* ── Regressions: behaviour that must keep working ─────────────── */

await test('renders every device from the data file', async () => {
  const data = readRoom('commons');
  const { doc } = await mount(data);
  const nodes = doc.querySelectorAll('[data-id]');
  assert(nodes.length === data.devices.length,
    `expected ${data.devices.length} device nodes, got ${nodes.length}`);
});

await test('clicking a device selects it and applies a status via the inspector (no popup)', async () => {
  const { doc, window } = await mount(readRoom('commons'));
  const pc = selectViaClick(doc, 'PC7');
  assert(pc.classList.contains('selected'), 'device not marked selected');
  assert(!doc.getElementById('inspector-empty').hidden === false || doc.getElementById('inspector-content').hidden === false,
    'inspector content should be visible once a device is selected');
  click(doc.querySelector('#inspector-status-grid [data-status="major"]'));
  const notes = doc.getElementById('inspector-notes');
  notes.focus();
  notes.value = 'no power';
  input(notes);
  notes.blur();
  const st = readState(window);
  assert(st['TEST_PC7']?.status === 'major', `state was ${JSON.stringify(st)}`);
  assert(st['TEST_PC7']?.notes === 'no power', 'notes not saved');
  assert(pc.dataset.status === 'major', `node status was ${pc.dataset.status}`);
});

await test('summary/stats line reflects saved statuses', async () => {
  const { doc } = await mount(readRoom('commons'));
  for (const [id, status] of [['PC1', 'working'], ['PC2', 'working'], ['PC3', 'minor']]) {
    selectViaClick(doc, id);
    click(doc.querySelector(`#inspector-status-grid [data-status="${status}"]`));
  }
  const stats = doc.getElementById('room-stats').textContent;
  assert(/3 inspected/.test(stats), `expected 3 inspected in "${stats}"`);
  assert(/1 issue/.test(stats), `expected 1 issue (the minor) in "${stats}"`);
});

await test('reset clears this room only', async () => {
  const { doc, window } = await mount(readRoom('commons'), {}, { 'ANNEX_PC1': { status: 'major' } });
  selectViaClick(doc, 'PC1');
  click(doc.querySelector('#inspector-status-grid [data-status="major"]'));
  click(doc.getElementById('btn-reset'));
  click(doc.getElementById('reset-confirm'));
  const st = readState(window);
  assert(!st['TEST_PC1'], 'room state not cleared');
  assert(st['ANNEX_PC1'], 'other room state was destroyed');
});

await test('a save does not clobber writes made in another tab', async () => {
  const { doc, window } = await mount(readRoom('commons'));
  const before = readState(window);
  window.localStorage.setItem('it-room-monitor-v1',
    JSON.stringify({ ...before, 'WORKSHOP_PC3': { status: 'major', notes: 'from the other tab' } }));
  selectViaClick(doc, 'PC2');
  click(doc.querySelector('#inspector-status-grid [data-status="working"]'));
  const st = readState(window);
  assert(st['TEST_PC2']?.status === 'working', 'this tab failed to save');
  assert(st['WORKSHOP_PC3']?.status === 'major', 'the other tab\'s save was wiped out');
});

/* ── Checker-interface symptoms ────────────────────────────────── */

await test('every device is keyboard-operable', async () => {
  const { doc } = await mount(readRoom('commons'));
  const bad = [...doc.querySelectorAll('[data-id]')].filter(el => {
    const focusable = el.tagName === 'BUTTON' || el.tabIndex >= 0;
    return !focusable;
  });
  assert(bad.length === 0,
    `${bad.length} devices unreachable by keyboard (e.g. ${bad[0]?.dataset.id})`);
});

await test('every device has an accessible name carrying its status', async () => {
  const { doc } = await mount(readRoom('commons'));
  const pc = doc.querySelector('[data-id="PC5"]');
  const name = pc.getAttribute('aria-label') || '';
  assert(/PC5/.test(name), `aria-label missing device id: "${name}"`);
  assert(/unknown|not checked/i.test(name), `aria-label missing status: "${name}"`);
});

await test('selecting a device moves focus to its status control in the inspector', async () => {
  const { doc } = await mount(readRoom('commons'));
  const pc = selectViaClick(doc, 'PC9');
  assert(doc.getElementById('inspector-panel').contains(doc.activeElement),
    `focus landed on <${doc.activeElement?.tagName}>, not inside the inspector`);
  assert(doc.activeElement.classList.contains('status-btn'), 'focus should land on a status control, not elsewhere in the inspector');
});

await test('a second printer keeps its own status', async () => {
  const data = readRoom('commons');
  data.devices = [...data.devices, { id: 'PRINTER2', type: 'printer', top: 172, left: 720 }];
  const { doc, window } = await mount(data);
  const p2 = doc.querySelector('[data-id="PRINTER2"]');
  assert(p2, 'second printer not rendered');
  click(p2);
  click(doc.querySelector('#inspector-status-grid [data-status="major"]'));
  const st = readState(window);
  assert(st['TEST_PRINTER2']?.status === 'major',
    `PRINTER2 status landed under the wrong key: ${JSON.stringify(st)}`);
  assert(!st['TEST_PRINTER'], 'marking PRINTER2 also wrote PRINTER');
});

await test('printer inspector only offers Working/Not Working, not the full 4-way grid', async () => {
  const { doc } = await mount(readRoom('commons'));
  click(doc.querySelector('[data-id="PRINTER"]'));
  const options = [...doc.querySelectorAll('#inspector-status-grid .status-btn')].map(b => b.dataset.status);
  assert(options.join(',') === 'working,major', `expected exactly working,major — got ${options.join(',')}`);
});

await test('long device labels get the wide chip so text is not clipped', async () => {
  const { doc } = await mount(readRoom('workshop'));
  const staff = doc.querySelector('[data-id="STAFF-PC"]');
  assert(staff, 'STAFF-PC not rendered');
  const label = (staff.textContent || '').trim();
  assert(staff.classList.contains('staff') || staff.classList.contains('wide') || label.length <= 5,
    `"${label}" (${label.length} chars) rendered in the narrow 42px chip`);
});

await test('device labels are HTML-escaped', async () => {
  const data = readRoom('commons');
  data.devices = [{ id: 'X1', type: 'pc', top: 10, left: 10, label: '<img src=x onerror=1>' }];
  const { doc } = await mount(data);
  assert(!doc.querySelector('#room img'), 'device label was injected as markup');
});

await test('progress is visible: the stats line shows remaining devices', async () => {
  const data = readRoom('commons');
  const { doc } = await mount(data);
  const el = doc.getElementById('room-stats');
  assert(el, 'no #room-stats indicator on the page');
  assert(el.textContent.includes(`${data.devices.length} devices`),
    `expected all ${data.devices.length} devices reflected, got "${el.textContent}"`);
  assert(/0 inspected/.test(el.textContent), 'a fresh room should show 0 inspected');
});

await test('devices carrying notes are flagged on the map', async () => {
  const { doc } = await mount(readRoom('commons'));
  const pc = selectViaClick(doc, 'PC4');
  click(doc.querySelector('#inspector-status-grid [data-status="minor"]'));
  const notes = doc.getElementById('inspector-notes');
  notes.focus();
  notes.value = 'mouse missing';
  input(notes);
  notes.blur();
  assert(pc.dataset.hasNotes === 'true', 'no data-has-notes flag after saving a note');
  assert(/mouse missing/.test(pc.getAttribute('aria-label') || pc.getAttribute('title') || ''),
    'note text not surfaced on the device');
});

/* ── Inspection Mode (built on the old Quick Mark) ──────────────── */

await test('Inspection Mode applies a status in one tap, with no inspector opening', async () => {
  const { doc } = await mount(readRoom('commons'));
  const arm = doc.querySelector('#mode-group [data-mode-status="working"]');
  assert(arm, 'no Inspection Mode control in the toolbar');
  click(arm);
  assert(arm.getAttribute('aria-pressed') === 'true', 'Inspection Mode did not arm');
  assert(!doc.getElementById('mode-banner').hidden, 'the mode banner should be visible while armed — the mode must be obvious, not just a pressed button');

  const pc = doc.querySelector('[data-id="PC11"]');
  click(pc);
  assert(doc.getElementById('inspector-content').hidden, 'inspector opened during Inspection Mode instead of applying directly');
  assert(pc.dataset.status === 'working', `status not applied (${pc.dataset.status})`);
  assert(!pc.classList.contains('selected'), 'a device should not become "selected" via an Inspection Mode tap');

  click(arm);
  assert(arm.getAttribute('aria-pressed') === 'false', 'Inspection Mode did not disarm');
  assert(doc.getElementById('mode-banner').hidden, 'the mode banner should hide once disarmed');
  click(doc.querySelector('[data-id="PC12"]'));
  assert(!doc.getElementById('inspector-content').hidden, 'the inspector should open normally once Inspection Mode is off');
});

await test('Escape exits Inspection Mode', async () => {
  const { doc } = await mount(readRoom('commons'));
  click(doc.querySelector('#mode-group [data-mode-status="major"]'));
  key(doc, 'Escape');
  assert(doc.querySelector('#mode-group [data-mode-status="major"]').getAttribute('aria-pressed') === 'false',
    'Escape should exit Inspection Mode');
});

/* ── Next Unchecked ──────────────────────────────────────────────── */

await test('Next Unchecked selects the first unchecked device in row-major order', async () => {
  const { doc } = await mount(readRoom('commons'));
  click(doc.getElementById('btn-next-unchecked'));
  const selected = doc.querySelector('.pc.selected, .printer.selected');
  assert(selected, 'Next Unchecked did not select any device');
  // commons.json's actual top-most row is Staff 1/2 (top:30), above the
  // PC1..PC5 row (top:60) — this assertion is pinned to the real fixture,
  // not to an assumption about which row "looks" first.
  assert(selected.dataset.id === 'SPC1', `expected SPC1 (the real top-most device) first, got ${selected.dataset.id}`);
});

await test('Next Unchecked skips already-inspected devices and advances past the current selection', async () => {
  const { doc } = await mount(readRoom('commons'));
  selectViaClick(doc, 'SPC1');
  click(doc.querySelector('#inspector-status-grid [data-status="working"]'));
  click(doc.getElementById('btn-next-unchecked'));
  const selected = doc.querySelector('.pc.selected, .printer.selected');
  assert(selected.dataset.id === 'SPC2', `expected SPC2 next (same row, to the right), got ${selected?.dataset.id}`);
});

/* ── Filters (fade, never hide) ──────────────────────────────────── */

await test('the Working filter fades non-working devices but never removes them from the DOM', async () => {
  const { doc } = await mount(readRoom('commons'));
  selectViaClick(doc, 'PC1');
  click(doc.querySelector('#inspector-status-grid [data-status="working"]'));

  click(doc.querySelector('#filter-row [data-filter="working"]'));
  const pc1 = doc.querySelector('[data-id="PC1"]');
  const pc2 = doc.querySelector('[data-id="PC2"]');
  assert(!pc1.classList.contains('filtered-out'), 'the matching (working) device should not be faded');
  assert(pc2.classList.contains('filtered-out'), 'a non-matching device should be faded');
  assert(doc.querySelectorAll('[data-id]').length === readRoom('commons').devices.length,
    'filtering must never remove a device node — spatial context has to survive');

  click(doc.querySelector('#filter-row [data-filter="all"]'));
  assert(!pc2.classList.contains('filtered-out'), 'switching back to All should clear the fade');
});

/* ── Search ──────────────────────────────────────────────────────── */

await test('search finds a device in the current room and selecting a result opens the inspector', async () => {
  const { doc } = await mount(readRoom('commons'));
  click(doc.getElementById('btn-search'));
  assert(doc.getElementById('search-overlay').classList.contains('open'), 'search overlay did not open');

  const searchInput = doc.getElementById('search-input');
  searchInput.value = 'PC9';
  input(searchInput);
  const result = doc.querySelector('.search-result');
  assert(result, 'no search result rendered for a query matching a real device id');

  click(result);
  assert(!doc.getElementById('search-overlay').classList.contains('open'), 'search overlay should close after selecting a result');
  assert(doc.querySelector('[data-id="PC9"]').classList.contains('selected'), 'selecting the result should select that device');
});

await test('search is a no-op query and other-room lookups failing does not break in-room results', async () => {
  const { doc } = await mount(readRoom('commons'));
  click(doc.getElementById('btn-search'));
  const searchInput = doc.getElementById('search-input');
  input(searchInput); // empty query
  assert(doc.querySelector('.search-hint'), 'an empty query should show a hint, not stale/garbage results');

  searchInput.value = 'Staff 1';
  input(searchInput);
  assert(doc.querySelector('.search-result'), 'a device label should be searchable even though cross-room data failed to load');
});

/* ── Zoom / pan controls (view-transform only — device data never changes) ── */

await test('zoom controls run without throwing and only ever transform .room, never move device coordinates', async () => {
  const data = readRoom('commons');
  const { doc } = await mount(data);
  const before = JSON.stringify(data.devices);
  for (const id of ['zoom-in', 'zoom-out', 'zoom-fit', 'zoom-100', 'zoom-fullscreen']) {
    click(doc.getElementById(id));
  }
  assert(JSON.stringify(data.devices) === before, 'zoom controls must never mutate device coordinates');
  assert(doc.getElementById('room').style.transform.includes('scale'), '.room should carry a scale() transform after zoom controls run');
});

/* ── Save-status indicator ──────────────────────────────────────── */

await test('the save-status indicator shows "Saving…" immediately after a status change', async () => {
  const { doc } = await mount(readRoom('commons'));
  selectViaClick(doc, 'PC1');
  click(doc.querySelector('#inspector-status-grid [data-status="working"]'));
  assert(doc.getElementById('save-status').textContent === 'Saving…', 'expected an immediate "Saving…" indicator after a status change');
});

/* ── Keyboard shortcuts ──────────────────────────────────────────── */

await test('1/2/3/0 apply a status to the currently selected device', async () => {
  const { doc, window } = await mount(readRoom('commons'));
  selectViaClick(doc, 'PC1');
  key(doc, '2');
  assert(readState(window)['TEST_PC1']?.status === 'minor', '"2" should mark the selected device Minor');
  key(doc, '0');
  assert(!readState(window)['TEST_PC1'], '"0" should clear the selected device\'s status');
});

await test('U undoes the most recent status change, regardless of how it was made', async () => {
  const { doc, window } = await mount(readRoom('commons'));
  selectViaClick(doc, 'PC1');
  key(doc, '1');
  assert(readState(window)['TEST_PC1']?.status === 'working', 'setup: expected PC1 working before undo');
  key(doc, 'u');
  assert(!readState(window)['TEST_PC1'], 'U should undo the "1" keyboard shortcut\'s status change');
});

await test('ArrowRight triggers Next Unchecked from the keyboard', async () => {
  const { doc } = await mount(readRoom('commons'));
  key(doc, 'ArrowRight');
  const selected = doc.querySelector('.pc.selected, .printer.selected');
  assert(selected?.dataset.id === 'SPC1', `ArrowRight should select the first unchecked device, got ${selected?.dataset.id}`);
});

await test('typing in the notes field does not trigger 1/2/3/0/U/ArrowRight shortcuts', async () => {
  const { doc, window } = await mount(readRoom('commons'));
  selectViaClick(doc, 'PC1');
  const notes = doc.getElementById('inspector-notes');
  notes.focus();
  key(doc, '2'); // dispatched on doc, but activeElement is the textarea — must be ignored
  assert(!readState(window)['TEST_PC1'], 'a keystroke while typing notes should not have applied a status');
});

/* ── Report ────────────────────────────────────────────────────── */

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
