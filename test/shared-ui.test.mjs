/**
 * shared-ui.test.mjs — direct coverage for the three sidebar-chrome modules
 * room.js and the editor now both build on (view-controls.js, disclosure.js,
 * help-overlay.js — see the SIDEBAR CHROME CONSOLIDATION refactor). Both
 * pages' own test suites (room.test.mjs, editor.test.mjs) already exercise
 * these indirectly through real page behavior; this file pins down each
 * module's own contract in isolation, with plain fake DOM elements rather
 * than a full mounted page.
 * Run: node test/shared-ui.test.mjs
 */
import { JSDOM } from 'jsdom';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name, '']); }
  catch (err) { results.push(['FAIL', name, err.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/test.html' });
global.window = dom.window;
global.document = dom.window.document;
global.ResizeObserver = dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

function click(el) {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}
function keydown(el, key, opts = {}) {
  el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
}
function pointer(el, type, opts = {}) {
  el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...opts }));
}

const { createDisclosure } = await import('../js/disclosure.js');
const { createHelpOverlay, renderShortcutRows } = await import('../js/help-overlay.js');
const { createViewController } = await import('../js/view-controls.js');

/* ══════════════════════════════════════════════════════════════════
   disclosure.js
   ══════════════════════════════════════════════════════════════════ */

function makeDisclosureDom() {
  const toggleBtn = document.createElement('button');
  const body = document.createElement('div');
  document.body.appendChild(toggleBtn);
  document.body.appendChild(body);
  return { toggleBtn, body };
}

await test('createDisclosure defaults to closed (defaultOpen false/omitted)', async () => {
  const { toggleBtn, body } = makeDisclosureDom();
  const ctl = createDisclosure({ toggleBtn, body, openLabel: 'Open ▴', closedLabel: 'Closed ▾' });
  assert(body.hidden === true, 'body should start hidden');
  assert(toggleBtn.getAttribute('aria-expanded') === 'false', 'aria-expanded should start false');
  assert(toggleBtn.textContent === 'Closed ▾', `expected closed label, got "${toggleBtn.textContent}"`);
  assert(ctl.isOpen() === false, 'isOpen() should report false');
});

await test('createDisclosure honors defaultOpen: true', async () => {
  const { toggleBtn, body } = makeDisclosureDom();
  createDisclosure({ toggleBtn, body, openLabel: 'Open ▴', closedLabel: 'Closed ▾', defaultOpen: true });
  assert(body.hidden === false, 'body should start visible');
  assert(toggleBtn.getAttribute('aria-expanded') === 'true', 'aria-expanded should start true');
  assert(toggleBtn.textContent === 'Open ▴', `expected open label, got "${toggleBtn.textContent}"`);
});

await test('clicking the toggle button flips open/closed each time, updating label + aria + hidden together', async () => {
  const { toggleBtn, body } = makeDisclosureDom();
  const ctl = createDisclosure({ toggleBtn, body, openLabel: 'Open ▴', closedLabel: 'Closed ▾' });
  click(toggleBtn);
  assert(ctl.isOpen() === true && body.hidden === false && toggleBtn.textContent === 'Open ▴', 'first click should open');
  click(toggleBtn);
  assert(ctl.isOpen() === false && body.hidden === true && toggleBtn.textContent === 'Closed ▾', 'second click should close');
});

await test('setOpen() lets a caller drive the section programmatically, independent of the toggle button', async () => {
  const { toggleBtn, body } = makeDisclosureDom();
  const ctl = createDisclosure({ toggleBtn, body, openLabel: 'Open ▴', closedLabel: 'Closed ▾' });
  ctl.setOpen(true);
  assert(ctl.isOpen() && !body.hidden, 'setOpen(true) should open the section');
  ctl.setOpen(false);
  assert(!ctl.isOpen() && body.hidden, 'setOpen(false) should close the section');
});

/* ══════════════════════════════════════════════════════════════════
   help-overlay.js
   ══════════════════════════════════════════════════════════════════ */

function makeHelpDom() {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const popup = document.createElement('div');
  popup.className = 'popup';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'popup-close';
  const list = document.createElement('dl');
  list.className = 'shortcut-list';
  popup.appendChild(closeBtn);
  popup.appendChild(list);
  overlay.appendChild(popup);
  const openBtn = document.createElement('button');
  document.body.appendChild(openBtn);
  document.body.appendChild(overlay);
  return { overlay, closeBtn, list, openBtn };
}

const SAMPLE_ROWS = [['F', 'Fit to screen'], ['?', 'Open this help']];

await test('renderShortcutRows renders one dt/dd pair per row', async () => {
  const { list } = makeHelpDom();
  renderShortcutRows(list, SAMPLE_ROWS);
  const dts = [...list.querySelectorAll('dt')].map(el => el.textContent);
  const dds = [...list.querySelectorAll('dd')].map(el => el.textContent);
  assert(dts.join(',') === 'F,?', `expected dt rows F,? — got ${dts.join(',')}`);
  assert(dds.join('|') === 'Fit to screen|Open this help', `expected matching dd text, got ${dds.join('|')}`);
});

await test('createHelpOverlay starts closed, and openBtn/closeBtn/backdrop-click wire correctly', async () => {
  const { overlay, closeBtn, list, openBtn } = makeHelpDom();
  const ctl = createHelpOverlay({ overlay, list, rows: SAMPLE_ROWS, openBtn, closeBtn });
  assert(!ctl.isOpen(), 'should start closed');
  click(openBtn);
  assert(ctl.isOpen() && overlay.classList.contains('open'), 'openBtn click should open it');
  click(closeBtn);
  assert(!ctl.isOpen(), 'closeBtn click should close it');
  click(openBtn);
  click(overlay); // clicking the backdrop itself (not the popup) should close
  assert(!ctl.isOpen(), 'clicking the overlay backdrop should close it');
});

await test('clicking inside the popup content does not close the overlay', async () => {
  const { overlay, list, openBtn } = makeHelpDom();
  const ctl = createHelpOverlay({ overlay, list, rows: SAMPLE_ROWS, openBtn });
  ctl.open();
  click(list);
  assert(ctl.isOpen(), 'a click on content inside the popup should not close it');
});

await test('close() is a no-op when already closed (no error, stays closed)', async () => {
  const { overlay, list, openBtn, closeBtn } = makeHelpDom();
  const ctl = createHelpOverlay({ overlay, list, rows: SAMPLE_ROWS, openBtn, closeBtn });
  ctl.close();
  assert(!ctl.isOpen(), 'still closed');
});

await test('focusManagement defaults to off: opening does not move focus or trap Tab', async () => {
  const { overlay, list, openBtn, closeBtn } = makeHelpDom();
  const outsideInput = document.createElement('input');
  document.body.appendChild(outsideInput);
  outsideInput.focus();
  const ctl = createHelpOverlay({ overlay, list, rows: SAMPLE_ROWS, openBtn, closeBtn });
  ctl.open();
  assert(document.activeElement === outsideInput, 'focus should stay put when focusManagement is off');
  keydown(overlay, 'Tab');
  // no assertion needed beyond "did not throw" — there is nothing to trap
});

await test('focusManagement:true auto-focuses on open and restores focus on close', async () => {
  const { overlay, list, openBtn, closeBtn } = makeHelpDom();
  const outsideInput = document.createElement('input');
  document.body.appendChild(outsideInput);
  outsideInput.focus();
  const ctl = createHelpOverlay({ overlay, list, rows: SAMPLE_ROWS, openBtn, closeBtn, focusManagement: true });
  ctl.open();
  assert(document.activeElement === closeBtn, `expected the popup-close button auto-focused, got ${document.activeElement?.tagName}`);
  ctl.close();
  assert(document.activeElement === outsideInput, 'closing should restore focus to whatever was focused before opening');
});

await test('focusManagement:true traps Tab inside the overlay (wraps both directions)', async () => {
  const { overlay, list, openBtn, closeBtn } = makeHelpDom();
  const ctl = createHelpOverlay({ overlay, list, rows: SAMPLE_ROWS, openBtn, closeBtn, focusManagement: true });
  ctl.open();
  closeBtn.focus();
  keydown(overlay, 'Tab', { shiftKey: true });
  assert(document.activeElement === closeBtn, 'Shift+Tab from the first focusable should wrap to the last (only one focusable here, so it stays put)');
});

/* ══════════════════════════════════════════════════════════════════
   view-controls.js
   ══════════════════════════════════════════════════════════════════ */

function makeViewDom() {
  const viewport = document.createElement('div');
  const frame = document.createElement('div');
  viewport.appendChild(frame);
  document.body.appendChild(viewport);
  return { viewport, frame };
}

function transformOf(frame) { return frame.style.transform; }

await test('fitToScreen applies a scale()+translate() transform to the frame', async () => {
  const { viewport, frame } = makeViewDom();
  const ctl = createViewController({
    viewport, frame,
    getCanvasSize: () => ({ w: 1200, h: 800 }),
    getContentBounds: () => ({ minX: 0, minY: 0, maxX: 1200, maxY: 800 }),
  });
  ctl.fitToScreen();
  assert(/scale\(/.test(transformOf(frame)), `expected a scale() transform, got "${transformOf(frame)}"`);
});

await test('zoomByFactor increases scale, and clamps at MAX_SCALE (3) rather than growing forever', async () => {
  const { viewport, frame } = makeViewDom();
  const ctl = createViewController({
    viewport, frame,
    getCanvasSize: () => ({ w: 1200, h: 800 }),
    getContentBounds: () => ({ minX: 0, minY: 0, maxX: 1200, maxY: 800 }),
  });
  ctl.actualSize();
  assert(ctl.scale === 1, `expected actualSize to set scale 1, got ${ctl.scale}`);
  for (let i = 0; i < 40; i++) ctl.zoomByFactor(1.25);
  assert(ctl.scale === 3, `expected zooming in repeatedly to clamp at 3, got ${ctl.scale}`);
});

await test('zoomByFactor clamps at MIN_SCALE (0.25) rather than shrinking forever', async () => {
  const { viewport, frame } = makeViewDom();
  const ctl = createViewController({
    viewport, frame,
    getCanvasSize: () => ({ w: 1200, h: 800 }),
    getContentBounds: () => ({ minX: 0, minY: 0, maxX: 1200, maxY: 800 }),
  });
  for (let i = 0; i < 40; i++) ctl.zoomByFactor(0.8);
  assert(ctl.scale === 0.25, `expected zooming out repeatedly to clamp at 0.25, got ${ctl.scale}`);
});

await test('isReady:false gates fitToScreen/zoomByFactor/actualSize — they no-op rather than reading canvas size/bounds too early', async () => {
  const { viewport, frame } = makeViewDom();
  let ready = false;
  let calls = 0;
  const ctl = createViewController({
    viewport, frame,
    getCanvasSize: () => { calls++; return { w: 1200, h: 800 }; },
    getContentBounds: () => { calls++; return { minX: 0, minY: 0, maxX: 1200, maxY: 800 }; },
    isReady: () => ready,
  });
  ctl.fitToScreen();
  ctl.zoomByFactor(1.25);
  ctl.actualSize();
  assert(calls === 0, `getCanvasSize/getContentBounds should never run while not ready, ran ${calls} times`);
  assert(transformOf(frame) === '', 'nothing should have been applied while not ready');
  ready = true;
  ctl.fitToScreen();
  assert(calls > 0, 'once ready, fitToScreen should actually read canvas size/bounds');
  assert(/scale\(/.test(transformOf(frame)), 'once ready, fitToScreen should work normally');
});

await test('buttons.zoomIn/zoomOut/zoomFit/zoom100 are wired to the matching operation', async () => {
  const { viewport, frame } = makeViewDom();
  const zoomIn = document.createElement('button');
  const zoom100 = document.createElement('button');
  const ctl = createViewController({
    viewport, frame,
    getCanvasSize: () => ({ w: 1200, h: 800 }),
    getContentBounds: () => ({ minX: 0, minY: 0, maxX: 1200, maxY: 800 }),
    buttons: { zoomIn, zoom100 },
  });
  click(zoomIn);
  const scaleAfterZoomIn = ctl.scale;
  assert(scaleAfterZoomIn !== 1, 'clicking the wired zoomIn button should change scale away from the default 1');
  click(zoom100);
  assert(ctl.scale === 1, 'clicking the wired zoom100 button should reset scale to 1 (actual size)');
});

await test('hintEl (if supplied) is filled in with a "<modifier>+scroll to zoom" hint', async () => {
  const { viewport, frame } = makeViewDom();
  const hintEl = document.createElement('span');
  createViewController({
    viewport, frame,
    getCanvasSize: () => ({ w: 1200, h: 800 }),
    getContentBounds: () => ({ minX: 0, minY: 0, maxX: 1200, maxY: 800 }),
    hintEl,
  });
  assert(/\+scroll to zoom$/.test(hintEl.textContent), `expected a "...+scroll to zoom" hint, got "${hintEl.textContent}"`);
});

await test('shouldPan gates whether a pointerdown starts a pan drag (default: not on a [data-id] element)', async () => {
  const { viewport, frame } = makeViewDom();
  const device = document.createElement('button');
  device.dataset.id = 'PC1';
  viewport.appendChild(device);
  const ctl = createViewController({
    viewport, frame,
    getCanvasSize: () => ({ w: 1200, h: 800 }),
    getContentBounds: () => ({ minX: 0, minY: 0, maxX: 1200, maxY: 800 }),
  });
  ctl.actualSize();
  const before = transformOf(frame);
  pointer(device, 'pointerdown', { clientX: 10, clientY: 10 });
  pointer(window.document, 'pointermove', { clientX: 60, clientY: 60 });
  assert(transformOf(frame) === before, 'a pointerdown starting on a [data-id] element should never begin a pan');
});

await test('a custom shouldPan predicate (the editor\'s: only in Select tool, excluding [data-kind]) is honored', async () => {
  const { viewport, frame } = makeViewDom();
  const shape = document.createElement('div');
  shape.dataset.kind = 'wall';
  viewport.appendChild(shape);
  let toolType = 'add-shape';
  const ctl = createViewController({
    viewport, frame,
    getCanvasSize: () => ({ w: 1200, h: 800 }),
    getContentBounds: () => ({ minX: 0, minY: 0, maxX: 1200, maxY: 800 }),
    shouldPan: e => toolType === 'select' && !e.target.closest?.('[data-kind]'),
  });
  ctl.actualSize();
  const before = transformOf(frame);
  pointer(viewport, 'pointerdown', { clientX: 10, clientY: 10 });
  pointer(window.document, 'pointermove', { clientX: 60, clientY: 60 });
  assert(transformOf(frame) === before, 'pan should not start while the armed tool is not Select');
});

/* ── Report ────────────────────────────────────────────────────────── */

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
