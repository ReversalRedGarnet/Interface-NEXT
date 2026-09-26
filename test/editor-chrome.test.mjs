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
function change(el, value) {
  el.value = value;
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('change', { bubbles: true }));
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

/* ── Room Type templates — the Room Type ↔ count field ↔ copy-from
   interaction is wired unconditionally at script load (openNewRoomDialog
   itself needs File System Access to populate the copy-from list, but the
   change-listener that reacts to Room Type does not), so it's testable here
   the same way tool-arming is: no loaded room or rootHandle needed. ── */

await test('the New Room dialog offers the five Room Type options (Blank, the 3 templates, and Trace from Photo)', async () => {
  const { doc } = await mountEditor();
  const options = [...doc.getElementById('nr-room-type').options].map(o => o.value);
  assert(options.join(',') === 'blank,computer-lab,office,network-room,trace-photo', `unexpected Room Type options: ${options.join(',')}`);
});

await test('picking Computer Lab reveals the device-count field (defaulted to 24) and disables Copy layout from', async () => {
  const { doc } = await mountEditor();
  change(doc.getElementById('nr-room-type'), 'computer-lab');
  assert(!doc.getElementById('nr-count-field').hidden, 'the count field should appear for Computer Lab');
  assert(doc.getElementById('nr-count').value === '24', 'expected the documented default PC count');
  assert(doc.getElementById('nr-copy-from').disabled, 'Copy layout from and a template are mutually exclusive');
  assert(!doc.getElementById('nr-template-hint').hidden, 'a non-blank template should show the template hint');
});

await test('picking Office reveals the device-count field defaulted to 5', async () => {
  const { doc } = await mountEditor();
  change(doc.getElementById('nr-room-type'), 'office');
  assert(!doc.getElementById('nr-count-field').hidden, 'the count field should appear for Office');
  assert(doc.getElementById('nr-count').value === '5', 'expected the documented default desk count');
});

await test('picking Network Room hides the count field (fixed device set) but still disables Copy layout from', async () => {
  const { doc } = await mountEditor();
  change(doc.getElementById('nr-room-type'), 'network-room');
  assert(doc.getElementById('nr-count-field').hidden, 'Network Room has a fixed device set — no count field');
  assert(doc.getElementById('nr-copy-from').disabled, 'Copy layout from and a template are mutually exclusive');
});

await test('switching back to Blank hides the count field/hint and re-enables Copy layout from', async () => {
  const { doc } = await mountEditor();
  const roomType = doc.getElementById('nr-room-type');
  change(roomType, 'computer-lab');
  change(roomType, 'blank');
  assert(doc.getElementById('nr-count-field').hidden, 'Blank should not show a count field');
  assert(doc.getElementById('nr-template-hint').hidden, 'Blank should not show the template hint');
  assert(!doc.getElementById('nr-copy-from').disabled, 'Blank should leave Copy layout from usable again');
});

/* ── Trace from Photo — the outline-tracing dialog itself needs a real
   2D canvas context (no jsdom substitute without the optional `canvas`
   npm package this project deliberately doesn't depend on — see
   getTracePhotoCtx() in editor.js), so actual point-tracing/redraw isn't
   exercised here, same convention canvas-renderer.js's own pixel output
   already isn't. What IS testable without a canvas context: the Room Type
   wiring (count/hint/copy-from/width-height), the trace popup's static
   markup, and that it reuses the same overlay pattern as every other
   editor dialog. ── */

await test('picking Trace from Photo hides the count field, shows the trace status block, disables Copy layout from and the canvas-size fields', async () => {
  const { doc } = await mountEditor();
  change(doc.getElementById('nr-room-type'), 'trace-photo');
  assert(doc.getElementById('nr-count-field').hidden, 'Trace from Photo has no device count to ask for');
  assert(doc.getElementById('nr-template-hint').hidden, 'Trace from Photo shows its own status line instead of the generic template hint');
  assert(!doc.getElementById('nr-trace-field').hidden, 'expected the trace status/button block to appear');
  assert(doc.getElementById('nr-trace-status').textContent === 'No photo traced yet.', 'expected the initial untraced status');
  assert(doc.getElementById('nr-copy-from').disabled, 'Copy layout from and a template are mutually exclusive');
  assert(doc.getElementById('nr-width').disabled, 'canvas size should be locked until a photo is traced (its size comes from the photo)');
  assert(doc.getElementById('nr-height').disabled, 'canvas size should be locked until a photo is traced (its size comes from the photo)');
});

await test('switching away from Trace from Photo re-enables the canvas-size fields and resets the trace status', async () => {
  const { doc } = await mountEditor();
  const roomType = doc.getElementById('nr-room-type');
  change(roomType, 'trace-photo');
  change(roomType, 'blank');
  assert(doc.getElementById('nr-trace-field').hidden, 'Blank should not show the trace block');
  assert(!doc.getElementById('nr-width').disabled, 'Blank should leave the canvas-size fields usable again');
  assert(!doc.getElementById('nr-height').disabled, 'Blank should leave the canvas-size fields usable again');
});

await test('the Trace from Photo popup reuses the shared overlay pattern and starts in its empty, nothing-loaded state', async () => {
  const { doc } = await mountEditor();
  const overlay = doc.getElementById('trace-photo-overlay');
  assert(overlay && overlay.classList.contains('overlay'), 'expected #trace-photo-overlay using the shared .overlay style');
  assert(overlay.querySelector('.popup'), 'expected the same .popup shape every other editor dialog uses');
  assert(doc.getElementById('trace-photo-canvas'), 'expected the tracing canvas element');
  assert(!doc.getElementById('trace-photo-empty').hidden, 'expected the "load a photo" empty state to show by default');
  assert(doc.getElementById('btn-trace-undo-point').disabled, 'undo should start disabled with no points yet');
  assert(doc.getElementById('btn-trace-cancel-shape').disabled, 'clear should start disabled with no points yet');
  assert(doc.getElementById('btn-trace-use-outline').disabled, 'Use This Outline needs at least 3 points');
});

await test('Escape closes the Trace from Photo popup without also closing the New Room dialog behind it', async () => {
  const { doc } = await mountEditor();
  const newRoomOverlay = doc.getElementById('new-room-overlay');
  const traceOverlay = doc.getElementById('trace-photo-overlay');
  newRoomOverlay.classList.add('open');
  traceOverlay.classList.add('open');
  key(doc, 'Escape');
  assert(!traceOverlay.classList.contains('open'), 'Escape should close the trace popup (the topmost dialog)');
  assert(newRoomOverlay.classList.contains('open'), 'the New Room dialog underneath should stay open');
});

/* ── Report ────────────────────────────────────────────────────────── */
const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
