/**
 * editor-chrome.test.mjs — DOM-level coverage for editor.js's tool-palette
 * chrome (armTool, and the Escape handler's tool-clearing branch) that
 * doesn't require a loaded room or the File System Access API: arming a
 * tool, toggling it off by clicking it again, switching to a different
 * tool, and Escape clearing back to Select. tools.js's own half of sticky
 * placement (that a successful placement never resets `state.tool`) is
 * covered directly in editor.test.mjs; loading/saving an actual room needs
 * a Chromium-only browser API with no jsdom substitute, so — same
 * limitation editor.test.mjs's own header documents — this deliberately
 * never goes further than arming/toggling tools, which is also the only
 * part of the tool palette that doesn't need a loaded room to begin with.
 * Run: node test/editor-chrome.test.mjs
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const results = [];
let bust = 0;

async function mountEditor() {
  const html = fs.readFileSync(path.join(ROOT, 'editor.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/editor.html', pretendToBeVisual: true });
  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.sessionStorage = window.sessionStorage;
  global.HTMLElement = window.HTMLElement;
  global.Element = window.Element;
  global.Node = window.Node;
  global.getComputedStyle = window.getComputedStyle.bind(window);
  global.ResizeObserver = window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  // Skip the passcode prompt — not what this file is testing.
  window.sessionStorage.setItem('gridkeep-editor-unlocked', 'true');
  await import(`../js/editor/editor.js?b=${bust++}`);
  return { window, doc: window.document };
}

function click(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
}
function key(doc, k) {
  doc.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: k, bubbles: true }));
}

async function test(name, fn) {
  try { await fn(); results.push(['PASS', name, '']); }
  catch (err) { results.push(['FAIL', name, err.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function deviceToolButtons(doc) {
  return [...doc.querySelectorAll('#device-tools .editor-tool-btn')];
}

await test('clicking a device tool arms it (visually pressed)', async () => {
  const { doc } = await mountEditor();
  const [firstBtn] = deviceToolButtons(doc);
  assert(firstBtn, 'expected at least one device tool button');
  click(firstBtn);
  assert(firstBtn.classList.contains('armed'), 'first click should arm the tool (visually pressed)');
});

await test('clicking the already-armed tool again disarms it (toggle off)', async () => {
  const { doc } = await mountEditor();
  const [firstBtn] = deviceToolButtons(doc);
  click(firstBtn);
  assert(firstBtn.classList.contains('armed'), 'sanity check: armed after first click');
  click(firstBtn);
  assert(!firstBtn.classList.contains('armed'), 'clicking the already-armed tool again should disarm it');
});

await test('clicking a different tool switches the armed button, not just adds to it', async () => {
  const { doc } = await mountEditor();
  const [firstBtn, secondBtn] = deviceToolButtons(doc);
  assert(firstBtn && secondBtn, 'expected at least two device tool buttons');
  click(firstBtn);
  click(secondBtn);
  assert(!firstBtn.classList.contains('armed'), 'the previous tool should no longer look armed');
  assert(secondBtn.classList.contains('armed'), 'the newly clicked tool should look armed');
  assert(doc.querySelectorAll('.editor-tool-btn.armed').length === 1, 'exactly one tool button should ever look armed at a time');
});

await test('arming a shape tool and then a device tool clears the shape tool\'s armed look too (cross-palette)', async () => {
  const { doc } = await mountEditor();
  const deviceBtn = doc.querySelector('#device-tools .editor-tool-btn');
  const shapeBtn = doc.querySelector('#shape-tools .editor-tool-btn');
  assert(deviceBtn && shapeBtn, 'expected at least one button in each palette');
  click(shapeBtn);
  assert(shapeBtn.classList.contains('armed'), 'sanity check: shape tool armed');
  click(deviceBtn);
  assert(!shapeBtn.classList.contains('armed'), 'arming a device tool should clear a previously-armed shape tool');
  assert(deviceBtn.classList.contains('armed'), 'the device tool should now be armed');
});

await test('Escape clears the armed tool back to Select', async () => {
  const { doc } = await mountEditor();
  const [firstBtn] = deviceToolButtons(doc);
  click(firstBtn);
  assert(firstBtn.classList.contains('armed'), 'sanity check: armed before Escape');
  key(doc, 'Escape');
  assert(!firstBtn.classList.contains('armed'), 'Escape should clear the armed tool');
});

await test('Escape with no tool armed is a harmless no-op', async () => {
  const { doc } = await mountEditor();
  key(doc, 'Escape');
  assert(doc.querySelectorAll('.editor-tool-btn.armed').length === 0, 'nothing should be armed');
});

/* ── Delete Room — static wiring only; the actual delete flow needs a
   loaded room (File System Access, no jsdom substitute — see
   editor.test.mjs's own header), so its logic is covered there via the
   pure room-scaffold.js/campus-data.js reversal functions instead. ── */

await test('the Room section has a Delete Room trigger, hidden until a room is loaded', async () => {
  const { doc } = await mountEditor();
  const btn = doc.getElementById('btn-delete-room');
  assert(btn, 'expected #btn-delete-room in the Room section');
  assert(doc.getElementById('sidebar-room').contains(btn), 'Delete Room should live in the Room section');
  assert(btn.hidden, 'Delete Room should stay hidden until a room is loaded, same as Mark Final/Unlock Layout');
});

await test('the Delete Room confirmation reuses the existing overlay/popup pattern, with a hidden-by-default Final warning', async () => {
  const { doc } = await mountEditor();
  const overlay = doc.getElementById('delete-room-overlay');
  assert(overlay && overlay.classList.contains('overlay'), 'expected #delete-room-overlay using the shared .overlay style');
  assert(overlay.querySelector('.popup.popup-sm'), 'expected the same .popup.popup-sm shape Unlock Layout\'s dialog uses');
  assert(doc.getElementById('delete-room-confirm')?.classList.contains('btn-danger'), 'the confirm action should be styled as destructive');
  const warning = doc.getElementById('delete-room-final-warning');
  assert(warning, 'expected a Final-room warning element');
  assert(warning.hidden, 'the Final warning should be hidden by default (only a final room\'s confirmation shows it)');
});

/* ── Report ────────────────────────────────────────────────────────── */
const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
