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
async function mount(data, meta = {}, seed = null, url = 'http://localhost/rooms/test.html') {
  const dom = new JSDOM('<!doctype html><html><body><div id="room-root"></div></body></html>', {
    url,
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
function wheel(el, opts = {}) {
  const win = el.ownerDocument.defaultView;
  el.dispatchEvent(new win.WheelEvent('wheel', {
    bubbles: true, cancelable: true,
    deltaY: opts.deltaY ?? -100,
    ctrlKey: !!opts.ctrlKey,
    metaKey: !!opts.metaKey,
  }));
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
  assert(st['TEST_PC7']?.inspectionState === 'checked', `state was ${JSON.stringify(st)}`);
  assert(st['TEST_PC7']?.condition === 'major', `condition was ${st['TEST_PC7']?.condition}`);
  assert(st['TEST_PC7']?.notes === 'no power', 'notes not saved');
  assert(pc.dataset.status === 'major', `node status was ${pc.dataset.status}`);
});

await test('marking a device Not Applicable stores that inspection state with no condition', async () => {
  const { doc, window } = await mount(readRoom('commons'));
  selectViaClick(doc, 'PC8');
  click(doc.querySelector('#inspector-status-grid [data-status="not-applicable"]'));
  const st = readState(window);
  assert(st['TEST_PC8']?.inspectionState === 'not-applicable', `expected not-applicable, got ${JSON.stringify(st['TEST_PC8'])}`);
  assert(st['TEST_PC8']?.condition == null, 'not-applicable should carry no condition');
  assert(doc.querySelector('[data-id="PC8"]').dataset.status === 'not-applicable', 'device chip should reflect not-applicable');
});

await test('"Not Checked" resets a device to unchecked but preserves its note', async () => {
  const { doc, window } = await mount(readRoom('commons'));
  selectViaClick(doc, 'PC7');
  click(doc.querySelector('#inspector-status-grid [data-status="major"]'));
  const notes = doc.getElementById('inspector-notes');
  notes.focus();
  notes.value = 'keep this note';
  input(notes);
  notes.blur();
  click(doc.querySelector('#inspector-status-grid [data-status="unchecked"]'));
  const st = readState(window);
  assert(st['TEST_PC7']?.inspectionState === 'unchecked', `expected unchecked, got ${JSON.stringify(st['TEST_PC7'])}`);
  assert(st['TEST_PC7']?.notes === 'keep this note', 'resetting to Not Checked should not discard the note');
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
    JSON.stringify({ ...before, 'WORKSHOP_PC3': { inspectionState: 'checked', condition: 'major', notes: 'from the other tab' } }));
  selectViaClick(doc, 'PC2');
  click(doc.querySelector('#inspector-status-grid [data-status="working"]'));
  const st = readState(window);
  assert(st['TEST_PC2']?.condition === 'working', 'this tab failed to save');
  assert(st['WORKSHOP_PC3']?.condition === 'major', 'the other tab\'s save was wiped out');
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
  assert(st['TEST_PRINTER2']?.condition === 'major',
    `PRINTER2 status landed under the wrong key: ${JSON.stringify(st)}`);
  assert(!st['TEST_PRINTER'], 'marking PRINTER2 also wrote PRINTER');
});

await test('printer inspector offers Working/Not Working plus Not Applicable/Not Checked, not the full PC grid', async () => {
  const { doc } = await mount(readRoom('commons'));
  click(doc.querySelector('[data-id="PRINTER"]'));
  const options = [...doc.querySelectorAll('#inspector-status-grid .status-btn')].map(b => b.dataset.status);
  assert(options.join(',') === 'working,major,not-applicable,unchecked',
    `expected exactly working,major,not-applicable,unchecked — got ${options.join(',')}`);
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

await test('Inspection Mode\'s toggle button stays visible and switches to its pressed look while armed — it never disappears with no trace of how to get back to it', async () => {
  const { doc } = await mount(readRoom('commons'));
  const toggle = doc.getElementById('btn-mode-toggle');
  const sidebarMode = doc.getElementById('sidebar-mode');
  assert(!toggle.hidden, 'the toggle button should be visible when Inspection Mode is off');
  assert(toggle.getAttribute('aria-pressed') === 'false', 'the toggle should not read pressed when off');
  assert(sidebarMode.hidden, 'the sidebar\'s Mark-as picker/banner should not be visible when Inspection Mode is off');

  click(toggle);
  assert(!toggle.hidden, 'the toggle button must stay visible once armed, not disappear');
  assert(toggle.getAttribute('aria-pressed') === 'true', 'the toggle should read pressed once Inspection Mode is armed');
  assert(!sidebarMode.hidden, 'the sidebar\'s Mark-as picker/banner should appear once Inspection Mode is armed');
  assert(doc.querySelector('#mode-group [data-mode-status="working"]').getAttribute('aria-pressed') === 'true',
    'clicking the toggle button should arm Working by default');
});

await test('clicking the toggle button again while armed exits Inspection Mode, since it now behaves as a real pressed/unpressed toggle', async () => {
  const { doc } = await mount(readRoom('commons'));
  const toggle = doc.getElementById('btn-mode-toggle');
  click(toggle);
  assert(toggle.getAttribute('aria-pressed') === 'true', 'fixture assumption: mode should be armed after the first click');
  click(toggle);
  assert(toggle.getAttribute('aria-pressed') === 'false', 'clicking the toggle again should exit Inspection Mode');
  assert(doc.getElementById('sidebar-mode').hidden, 'the sidebar\'s picker/banner should collapse once exited via the toggle');
});

await test('Inspection Mode\'s active UI (picker + banner) renders inside the inspector sidebar, replacing the normal inspector content while armed', async () => {
  const { doc } = await mount(readRoom('commons'));
  const panel = doc.getElementById('inspector-panel');
  const sidebarMode = doc.getElementById('sidebar-mode');
  const inspectorNormal = doc.getElementById('inspector-normal');
  assert(panel.contains(sidebarMode), 'the Inspection Mode UI should live inside the inspector sidebar');
  assert(panel.contains(doc.getElementById('mode-group')), 'the Mark-as picker should be inside the sidebar');
  assert(panel.contains(doc.getElementById('mode-banner')), 'the mode banner should be inside the sidebar');
  assert(!inspectorNormal.hidden, 'the normal inspector content should be showing before Inspection Mode is armed');

  click(doc.getElementById('btn-mode-toggle'));
  assert(!sidebarMode.hidden, 'the sidebar\'s Mode UI should be visible once armed');
  assert(inspectorNormal.hidden, 'the normal inspector content should be hidden while Inspection Mode is armed');

  click(doc.getElementById('btn-mode-toggle'));
  assert(sidebarMode.hidden, 'the sidebar\'s Mode UI should hide again once exited');
  assert(!inspectorNormal.hidden, 'the normal inspector content should return once Inspection Mode is off');
});

await test('the mode banner carries its own clickable Exit button (not just text mentioning Esc), so Inspection Mode can be entered and exited by mouse/touch alone', async () => {
  const { doc } = await mount(readRoom('commons'));
  click(doc.getElementById('btn-mode-toggle'));
  const sidebarMode = doc.getElementById('sidebar-mode');
  const banner = doc.getElementById('mode-banner');
  const exitBtn = doc.getElementById('btn-mode-exit');
  assert(!sidebarMode.hidden, 'fixture assumption: the sidebar Mode UI should be visible once armed');
  assert(exitBtn, 'expected an Exit button inside the mode banner');
  assert(banner.contains(exitBtn), 'the Exit button should be part of the banner itself');

  click(exitBtn);
  assert(sidebarMode.hidden, 'clicking Exit should hide the sidebar Mode UI');
  assert(doc.querySelector('#mode-group [data-mode-status="working"]').getAttribute('aria-pressed') === 'false', 'clicking Exit should disarm the active status');
  assert(doc.getElementById('btn-mode-toggle').getAttribute('aria-pressed') === 'false', 'the toggle should read unpressed again after Exit');
});

await test('Inspection Mode applies a status in one tap, with no inspector opening', async () => {
  const { doc } = await mount(readRoom('commons'));
  click(doc.getElementById('btn-mode-toggle'));
  const arm = doc.querySelector('#mode-group [data-mode-status="working"]');
  assert(arm, 'no Inspection Mode control in the toolbar');
  assert(arm.getAttribute('aria-pressed') === 'true', 'Inspection Mode did not arm');
  assert(!doc.getElementById('sidebar-mode').hidden, 'the sidebar Mode UI should be visible while armed — the mode must be obvious, not just a pressed button');

  const pc = doc.querySelector('[data-id="PC11"]');
  click(pc);
  assert(doc.getElementById('inspector-content').hidden, 'inspector opened during Inspection Mode instead of applying directly');
  assert(pc.dataset.status === 'working', `status not applied (${pc.dataset.status})`);
  assert(!pc.classList.contains('selected'), 'a device should not become "selected" via an Inspection Mode tap');

  click(arm);
  assert(arm.getAttribute('aria-pressed') === 'false', 'Inspection Mode did not disarm');
  assert(doc.getElementById('sidebar-mode').hidden, 'the sidebar Mode UI should hide once disarmed');
  assert(!doc.getElementById('btn-mode-toggle').hidden, 'disarming should collapse the picker back to the toggle button');
  click(doc.querySelector('[data-id="PC12"]'));
  assert(!doc.getElementById('inspector-content').hidden, 'the inspector should open normally once Inspection Mode is off');
});

await test('Inspection Mode offers a Not Applicable choice but no "Clear" — resetting stays an inspector/keyboard action', async () => {
  const { doc, window } = await mount(readRoom('commons'));
  const statuses = [...doc.querySelectorAll('#mode-group [data-mode-status]')].map(b => b.dataset.modeStatus);
  assert(statuses.join(',') === 'working,minor,major,not-applicable', `expected working,minor,major,not-applicable — got ${statuses.join(',')}`);

  click(doc.getElementById('btn-mode-toggle'));
  click(doc.querySelector('#mode-group [data-mode-status="not-applicable"]'));
  click(doc.querySelector('[data-id="PC10"]'));
  assert(readState(window)['TEST_PC10']?.inspectionState === 'not-applicable', 'Inspection Mode\'s N/A button should mark the clicked device not-applicable');
});

await test('switching between statuses within an already-armed Inspection Mode does not collapse the picker', async () => {
  const { doc } = await mount(readRoom('commons'));
  click(doc.getElementById('btn-mode-toggle')); // arms "working"
  click(doc.querySelector('#mode-group [data-mode-status="minor"]'));
  assert(!doc.getElementById('sidebar-mode').hidden, 'switching to a different status should keep the sidebar picker open');
  assert(doc.querySelector('#mode-group [data-mode-status="minor"]').getAttribute('aria-pressed') === 'true', 'minor should now be armed');
  assert(doc.querySelector('#mode-group [data-mode-status="working"]').getAttribute('aria-pressed') === 'false', 'working should no longer be armed');
});

await test('the Mark-as picker and the Filter row are labelled distinctly even when both are visible at once', async () => {
  const { doc } = await mount(readRoom('commons'));
  click(doc.getElementById('btn-mode-toggle'));
  click(doc.getElementById('btn-filter-toggle'));
  const modeLabel = doc.querySelector('#mode-group .quick-mark-label')?.textContent;
  const filterLabel = doc.querySelector('#filter-row .quick-mark-label')?.textContent;
  assert(modeLabel && filterLabel && modeLabel !== filterLabel,
    `expected two distinct captions when both groups are open, got "${modeLabel}" and "${filterLabel}"`);
});

await test('Escape exits Inspection Mode', async () => {
  const { doc } = await mount(readRoom('commons'));
  click(doc.getElementById('btn-mode-toggle'));
  click(doc.querySelector('#mode-group [data-mode-status="major"]'));
  key(doc, 'Escape');
  assert(doc.querySelector('#mode-group [data-mode-status="major"]').getAttribute('aria-pressed') === 'false',
    'Escape should exit Inspection Mode');
  assert(!doc.getElementById('btn-mode-toggle').hidden, 'Escape should collapse the picker back to the toggle button');
});

/* ── Filter row: collapsed by default, toggled via a "Filter" button ── */

await test('the filter row is collapsed by default and opens/closes via the Filter toggle', async () => {
  const { doc } = await mount(readRoom('commons'));
  const toggle = doc.getElementById('btn-filter-toggle');
  const row = doc.getElementById('filter-row');
  assert(row.hidden, 'the filter row should be collapsed by default');
  assert(toggle.getAttribute('aria-expanded') === 'false', 'the toggle should report collapsed via aria-expanded');

  click(toggle);
  assert(!row.hidden, 'clicking Filter should reveal the filter row');
  assert(toggle.getAttribute('aria-expanded') === 'true', 'the toggle should report expanded via aria-expanded');

  click(toggle);
  assert(row.hidden, 'clicking Filter again should collapse the row');
});

await test('picking a specific filter keeps the row open and updates the toggle\'s own label; picking All collapses it', async () => {
  const { doc } = await mount(readRoom('commons'));
  click(doc.getElementById('btn-filter-toggle'));
  click(doc.querySelector('#filter-row [data-filter="working"]'));
  const toggle = doc.getElementById('btn-filter-toggle');
  assert(!doc.getElementById('filter-row').hidden, 'picking a non-All filter should leave the row open');
  assert(/Working/.test(toggle.textContent), `expected the toggle's own label to name the active filter, got "${toggle.textContent}"`);

  click(doc.querySelector('#filter-row [data-filter="all"]'));
  assert(doc.getElementById('filter-row').hidden, 'picking All should collapse the filter row back down');
  assert(toggle.textContent.trim() === 'Filter', `expected the toggle to reset to a plain "Filter" label, got "${toggle.textContent}"`);
});

/* ── Room actions overflow menu ────────────────────────────────────── */

await test('room actions (Undo/Export/Reset) live behind a single overflow menu that opens, closes on outside click, and closes after choosing an action', async () => {
  const { doc } = await mount(readRoom('commons'));
  const moreBtn = doc.getElementById('btn-more');
  const menu = doc.getElementById('overflow-menu');
  assert(menu.hidden, 'the overflow menu should be closed by default');
  for (const id of ['btn-undo', 'btn-export-room', 'btn-export-all', 'btn-reset']) {
    assert(doc.getElementById(id).closest('#overflow-menu'), `#${id} should live inside the overflow menu`);
  }

  click(moreBtn);
  assert(!menu.hidden, 'clicking the ⋯ button should open the overflow menu');

  click(doc.body);
  assert(menu.hidden, 'clicking outside the overflow menu should close it');

  click(moreBtn);
  click(doc.getElementById('btn-reset'));
  assert(menu.hidden, 'choosing an action from the overflow menu should close it');
  assert(doc.getElementById('reset-overlay').classList.contains('open'), 'the reset action itself should still have run (opened its confirmation)');
});

await test('Escape closes the overflow menu before it would exit Inspection Mode', async () => {
  const { doc } = await mount(readRoom('commons'));
  click(doc.getElementById('btn-more'));
  key(doc, 'Escape');
  assert(doc.getElementById('overflow-menu').hidden, 'Escape should close an open overflow menu');
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

await test('the filter row offers Checked and Not Applicable alongside the per-condition filters', async () => {
  const { doc } = await mount(readRoom('commons'));
  const keys = [...doc.querySelectorAll('#filter-row [data-filter]')].map(b => b.dataset.filter);
  for (const key of ['all', 'unchecked', 'checked', 'not-applicable', 'working', 'minor', 'major', 'notes']) {
    assert(keys.includes(key), `filter row missing "${key}" — got ${keys.join(',')}`);
  }
});

await test('the Not Applicable filter matches only not-applicable devices, and Checked matches any condition', async () => {
  const { doc } = await mount(readRoom('commons'));
  selectViaClick(doc, 'PC1');
  click(doc.querySelector('#inspector-status-grid [data-status="not-applicable"]'));
  selectViaClick(doc, 'PC2');
  click(doc.querySelector('#inspector-status-grid [data-status="working"]'));

  click(doc.querySelector('#filter-row [data-filter="not-applicable"]'));
  assert(!doc.querySelector('[data-id="PC1"]').classList.contains('filtered-out'), 'PC1 (not-applicable) should match the Not Applicable filter');
  assert(doc.querySelector('[data-id="PC2"]').classList.contains('filtered-out'), 'PC2 (working) should not match the Not Applicable filter');

  click(doc.querySelector('#filter-row [data-filter="checked"]'));
  assert(!doc.querySelector('[data-id="PC2"]').classList.contains('filtered-out'), 'PC2 (checked+working) should match the Checked filter');
  assert(doc.querySelector('[data-id="PC1"]').classList.contains('filtered-out'), 'PC1 (not-applicable) should not match the Checked filter');
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

await test('plain wheel scroll over the floor plan does not zoom — it behaves like normal page scroll', async () => {
  const { doc } = await mount(readRoom('commons'));
  const before = doc.getElementById('room').style.transform;
  wheel(doc.getElementById('room-viewport'), { deltaY: -100 });
  assert(doc.getElementById('room').style.transform === before,
    `a plain wheel scroll should not change the zoom transform (was "${before}", now "${doc.getElementById('room').style.transform}")`);
});

await test('Ctrl+wheel zooms the floor plan (Cmd+wheel does too)', async () => {
  const { doc } = await mount(readRoom('commons'));
  const before = doc.getElementById('room').style.transform;
  wheel(doc.getElementById('room-viewport'), { deltaY: -100, ctrlKey: true });
  assert(doc.getElementById('room').style.transform !== before, 'Ctrl+wheel should change the zoom transform');

  const { doc: doc2 } = await mount(readRoom('commons'));
  const before2 = doc2.getElementById('room').style.transform;
  wheel(doc2.getElementById('room-viewport'), { deltaY: -100, metaKey: true });
  assert(doc2.getElementById('room').style.transform !== before2, 'Cmd (metaKey)+wheel should change the zoom transform too');
});

function nextFrame(window) {
  return new Promise(resolve => window.requestAnimationFrame(resolve));
}

await test('the floor plan auto-fits on load without a manual Fit click', async () => {
  const { doc } = await mount(readRoom('commons'));
  assert(doc.getElementById('room').style.transform.includes('scale'),
    '.room should already carry a scale() transform right after mount, before any button is clicked');
});

await test('a deferred re-fit runs one frame after load (correcting a too-early fit once real layout is available)', async () => {
  const { doc, window } = await mount(readRoom('commons'));
  const before = doc.getElementById('room').style.transform;
  await nextFrame(window);
  // jsdom never lays out real content, so the recomputed fit is identical
  // to the first one here — this just proves the deferred call runs
  // without throwing and doesn't leave the view in a broken state.
  assert(doc.getElementById('room').style.transform.includes('scale'),
    `expected a valid scale() transform after the deferred re-fit, got "${doc.getElementById('room').style.transform}" (was "${before}")`);
});

await test('the deferred auto-fit does not fight a ?focus= deep link\'s pan/zoom', async () => {
  const { doc, window } = await mount(readRoom('commons'), {}, null, 'http://localhost/rooms/test.html?focus=SPC3');
  assert(doc.querySelector('[data-id="SPC3"]').classList.contains('selected'),
    'the ?focus= param should select its device immediately, synchronously during load');
  await nextFrame(window);
  assert(doc.querySelector('[data-id="SPC3"]').classList.contains('selected'),
    'the deferred one-frame-later re-fit should not undo a ?focus= deep link\'s selection/pan/zoom');
});

/* ── App-shell layout: floor plan and inspector as distinct regions ── */

await test('the inspector is a distinct region with its own persistent header label, separate from the floor-plan pane', async () => {
  const { doc } = await mount(readRoom('commons'));
  const label = doc.querySelector('#inspector-panel .inspector-panel-label');
  assert(label && /inspector/i.test(label.textContent), 'the inspector panel should carry a persistent "Inspector" header label');
  assert(doc.getElementById('inspector-panel').parentElement === doc.getElementById('workstation'),
    'the inspector panel should be a direct sibling of the floor-plan pane inside .workstation');
  assert(doc.querySelector('.floor-pane').parentElement === doc.getElementById('workstation'),
    'the floor-plan pane should be a direct sibling of the inspector inside .workstation');
});

await test('the inspector\'s scrollable content is nested separately from its persistent label, so the label never scrolls away', async () => {
  const { doc } = await mount(readRoom('commons'));
  const panel = doc.getElementById('inspector-panel');
  const label = panel.querySelector('.inspector-panel-label');
  const scrollArea = panel.querySelector('.inspector-scroll');
  assert(label && scrollArea, 'expected both a persistent label and a separate scrollable content area');
  assert(scrollArea.contains(doc.getElementById('inspector-content')), 'the actual inspector content should live inside the scrollable area, not beside the label');
  assert(!scrollArea.contains(label), 'the persistent label should not be inside the scrollable area');
});

await test('the zoom controls are anchored inside the floor-plan viewport itself, not floating between it and the inspector', async () => {
  const { doc } = await mount(readRoom('commons'));
  const zoomControls = doc.getElementById('zoom-controls');
  const viewport = doc.getElementById('room-viewport');
  assert(zoomControls.parentElement === viewport, 'the zoom controls should be nested inside #room-viewport, not floating in the outer floor-pane');
  assert(viewport.contains(doc.getElementById('room')) && viewport.contains(zoomControls),
    'the pannable/zoomable .room and the zoom controls should both live inside the same viewport');
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
  assert(readState(window)['TEST_PC1']?.condition === 'minor', '"2" should mark the selected device Minor');
  key(doc, '0');
  assert(!readState(window)['TEST_PC1'], '"0" should reset the selected device to Not Checked (and drop its empty entry)');
});

await test('U undoes the most recent status change, regardless of how it was made', async () => {
  const { doc, window } = await mount(readRoom('commons'));
  selectViaClick(doc, 'PC1');
  key(doc, '1');
  assert(readState(window)['TEST_PC1']?.condition === 'working', 'setup: expected PC1 working before undo');
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
