/**
 * rooms.smoke.mjs — renders every real room and checks the basics:
 * no exceptions, every device present, labelled, and inside the canvas.
 * Run:  node test/rooms.smoke.mjs
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const ROOMS = [
  ['LIBRARY', 'library'], ['S28-107', 's28-107'], ['S28-104', 's28-104'],
  ['GPL', 'gpl'], ['MTL', 'mtl'],
];
const CHIP = { pc: 42, staff: 52, wide: 64, printer: 88 };
let problems = 0;
let bust = 0;

for (const [id, file] of ROOMS) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${file}.json`), 'utf8'));
  const dom = new JSDOM('<!doctype html><body><div id="room-root"></div></body>',
    { url: 'http://localhost/', pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  global.ResizeObserver = dom.window.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };

  const { initRoomPage } = await import(`../js/room.js?s=${bust++}`);
  initRoomPage({ id, label: id, campus: 'x', back: '../index.html', ...data });

  const doc = dom.window.document;
  const nodes = [...doc.querySelectorAll('#room [data-id]')];
  const W = data.canvasWidth, H = data.canvasHeight;
  const issues = [];

  if (nodes.length !== data.devices.length) issues.push(`${nodes.length}/${data.devices.length} rendered`);
  nodes.forEach(el => {
    if (!el.getAttribute('aria-label')) issues.push(`${el.dataset.id}: no aria-label`);
    if (el.tagName !== 'BUTTON') issues.push(`${el.dataset.id}: not a button`);
  });
  data.devices.forEach(d => {
    const cls = d.type === 'printer' ? 'printer'
      : (d.label || d.id).length > 5 ? 'wide' : d.type === 'staff' ? 'staff' : 'pc';
    const w = CHIP[cls], h = d.type === 'printer' ? 44 : 42;
    if (d.left < 0 || d.top < 0 || d.left + w > W || d.top + h > H) {
      issues.push(`${d.id}: chip spills the ${W}x${H} canvas (${d.left},${d.top} +${w}x${h})`);
    }
  });

  const unchecked = doc.getElementById('count-unchecked')?.textContent;
  console.log(`${issues.length ? 'FAIL' : ' ok '}  ${id.padEnd(8)} ${nodes.length} devices · "${unchecked}"`);
  issues.forEach(i => console.log(`        → ${i}`));
  problems += issues.length;
}

console.log(problems ? `\n${problems} problem(s)` : '\nall rooms clean');
process.exit(problems ? 1 : 0);
