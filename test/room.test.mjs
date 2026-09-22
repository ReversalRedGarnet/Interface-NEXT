/**
 * room.test.mjs — feedback loop for the room page.
 *
 * Drives the real js/room.js inside jsdom and asserts on the DOM an intern
 * would actually touch. Run:  node test/room.test.mjs
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

/** Fresh jsdom + fresh module instance, room rendered. */
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
    id: 'TEST', label: 'Test Room', campus: 'Test Campus', back: '../index.html',
    ...meta, ...data,
  };
  initRoomPage(cfg);
  return { dom, window, doc: window.document, cfg };
}

function click(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
}
function key(doc, k) {
  doc.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: k, bubbles: true }));
}
function readState(window) {
  return JSON.parse(window.localStorage.getItem('it-room-monitor-v1') || '{}');
}

async function test(name, fn) {
  try { await fn(); results.push(['PASS', name, '']); }
  catch (err) { results.push(['FAIL', name, err.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* ── Regressions: behaviour that must keep working ─────────────── */

await test('renders every device from the data file', async () => {
  const data = readRoom('library');
  const { doc } = await mount(data);
  const nodes = doc.querySelectorAll('[data-id]');
  assert(nodes.length === data.devices.length,
    `expected ${data.devices.length} device nodes, got ${nodes.length}`);
});

await test('popup save writes ROOMID_DEVICEID and repaints that device', async () => {
  const { doc, window } = await mount(readRoom('library'));
  const pc = doc.querySelector('[data-id="PC7"]');
  click(pc);
  click(doc.querySelector('#pc-overlay [data-status="major"]'));
  doc.getElementById('pc-notes').value = 'no power';
  click(doc.getElementById('pc-save'));
  const st = readState(window);
  assert(st['TEST_PC7']?.status === 'major', `state was ${JSON.stringify(st)}`);
  assert(st['TEST_PC7']?.notes === 'no power', 'notes not saved');
  assert(pc.dataset.status === 'major', `node status was ${pc.dataset.status}`);
});

await test('summary counts reflect saved statuses', async () => {
  const { doc } = await mount(readRoom('library'));
  for (const [id, status] of [['PC1', 'working'], ['PC2', 'working'], ['PC3', 'minor']]) {
    click(doc.querySelector(`[data-id="${id}"]`));
    click(doc.querySelector(`#pc-overlay [data-status="${status}"]`));
    click(doc.getElementById('pc-save'));
  }
  assert(doc.getElementById('count-working').textContent.startsWith('2'), 'working count wrong');
  assert(doc.getElementById('count-minor').textContent.startsWith('1'), 'minor count wrong');
});

await test('reset clears this room only', async () => {
  const { doc, window } = await mount(readRoom('library'), {}, { 'GPL_PC1': { status: 'major' } });
  click(doc.querySelector('[data-id="PC1"]'));
  click(doc.querySelector('#pc-overlay [data-status="major"]'));
  click(doc.getElementById('pc-save'));
  click(doc.getElementById('btn-reset'));
  click(doc.getElementById('reset-confirm'));
  const st = readState(window);
  assert(!st['TEST_PC1'], 'room state not cleared');
  assert(st['GPL_PC1'], 'other room state was destroyed');
});

await test('a save does not clobber writes made in another tab', async () => {
  // Intern has two room tabs open. Tab B saves; tab A must not roll it back.
  const { doc, window } = await mount(readRoom('library'));
  const before = readState(window);
  window.localStorage.setItem('it-room-monitor-v1',
    JSON.stringify({ ...before, 'MTL_PC3': { status: 'major', notes: 'from the other tab' } }));
  click(doc.querySelector('[data-id="PC2"]'));
  click(doc.querySelector('#pc-overlay [data-status="working"]'));
  click(doc.getElementById('pc-save'));
  const st = readState(window);
  assert(st['TEST_PC2']?.status === 'working', 'this tab failed to save');
  assert(st['MTL_PC3']?.status === 'major', 'the other tab\'s save was wiped out');
});

/* ── Intern-interface symptoms ─────────────────────────────────── */

await test('every device is keyboard-operable', async () => {
  const { doc } = await mount(readRoom('library'));
  const bad = [...doc.querySelectorAll('[data-id]')].filter(el => {
    const focusable = el.tagName === 'BUTTON' || el.tabIndex >= 0;
    return !focusable;
  });
  assert(bad.length === 0,
    `${bad.length} devices unreachable by keyboard (e.g. ${bad[0]?.dataset.id})`);
});

await test('every device has an accessible name carrying its status', async () => {
  const { doc } = await mount(readRoom('library'));
  const pc = doc.querySelector('[data-id="PC5"]');
  const name = pc.getAttribute('aria-label') || '';
  assert(/PC5/.test(name), `aria-label missing device id: "${name}"`);
  assert(/unknown|not checked/i.test(name), `aria-label missing status: "${name}"`);
});

await test('opening a device popup moves focus in, closing restores it', async () => {
  const { doc } = await mount(readRoom('library'));
  const pc = doc.querySelector('[data-id="PC9"]');
  pc.focus?.();
  click(pc);
  assert(doc.getElementById('pc-overlay').contains(doc.activeElement),
    `focus stayed on <${doc.activeElement?.tagName}> outside the dialog`);
  key(doc, 'Escape');
  assert(doc.activeElement === pc, 'focus not returned to the device after close');
});

await test('a second printer keeps its own status', async () => {
  const data = readRoom('library');
  data.devices = [...data.devices, { id: 'PRINTER2', type: 'printer', top: 172, left: 720 }];
  const { doc, window } = await mount(data);
  const p2 = doc.querySelector('[data-id="PRINTER2"]');
  assert(p2, 'second printer not rendered');
  click(p2);
  const overlay = doc.querySelector('#printer-overlay.open') || doc.querySelector('#pc-overlay.open');
  assert(overlay, 'clicking the second printer opened nothing');
  click(overlay.querySelector('[data-status="major"]'));
  click(overlay.querySelector('.btn-primary'));
  const st = readState(window);
  assert(st['TEST_PRINTER2']?.status === 'major',
    `PRINTER2 status landed under the wrong key: ${JSON.stringify(st)}`);
  assert(!st['TEST_PRINTER'], 'marking PRINTER2 also wrote PRINTER');
});

await test('long device labels get the wide chip so text is not clipped', async () => {
  const { doc } = await mount(readRoom('mtl'));
  const staff = doc.querySelector('[data-id="STAFF-PC"]');
  assert(staff, 'STAFF-PC not rendered');
  const label = (staff.textContent || '').trim();
  assert(staff.classList.contains('staff') || staff.classList.contains('wide') || label.length <= 5,
    `"${label}" (${label.length} chars) rendered in the narrow 42px chip`);
});

await test('device labels are HTML-escaped', async () => {
  const data = readRoom('library');
  data.devices = [{ id: 'X1', type: 'pc', top: 10, left: 10, label: '<img src=x onerror=1>' }];
  const { doc } = await mount(data);
  assert(!doc.querySelector('#room img'), 'device label was injected as markup');
});

await test('progress is visible: how many devices are still unchecked', async () => {
  const data = readRoom('library');
  const { doc } = await mount(data);
  const el = doc.getElementById('count-unchecked');
  assert(el, 'no #count-unchecked indicator on the page');
  assert(el.textContent.includes(String(data.devices.length)),
    `expected all ${data.devices.length} unchecked, got "${el.textContent}"`);
});

await test('devices carrying notes are flagged on the map', async () => {
  const { doc } = await mount(readRoom('library'));
  const pc = doc.querySelector('[data-id="PC4"]');
  click(pc);
  click(doc.querySelector('#pc-overlay [data-status="minor"]'));
  doc.getElementById('pc-notes').value = 'mouse missing';
  click(doc.getElementById('pc-save'));
  assert(pc.dataset.hasNotes === 'true', 'no data-has-notes flag after saving a note');
  assert(/mouse missing/.test(pc.getAttribute('aria-label') || pc.getAttribute('title') || ''),
    'note text not surfaced on the device');
});

await test('quick-mark applies a status in one tap, no popup', async () => {
  const { doc } = await mount(readRoom('library'));
  const arm = doc.querySelector('#quick-mark [data-status="working"]');
  assert(arm, 'no #quick-mark control in the toolbar');
  click(arm);
  assert(arm.getAttribute('aria-pressed') === 'true', 'quick-mark did not arm');
  const pc = doc.querySelector('[data-id="PC11"]');
  click(pc);
  assert(!doc.querySelector('#pc-overlay.open'), 'popup opened during quick-mark');
  assert(pc.dataset.status === 'working', `status not applied (${pc.dataset.status})`);
  click(arm);
  assert(arm.getAttribute('aria-pressed') === 'false', 'quick-mark did not disarm');
  click(doc.querySelector('[data-id="PC12"]'));
  assert(doc.querySelector('#pc-overlay.open'), 'popup no longer opens once disarmed');
});

/* ── Report ────────────────────────────────────────────────────── */

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
