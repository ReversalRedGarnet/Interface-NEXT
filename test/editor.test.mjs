/**
 * editor.test.mjs — feedback loop for the floor-plan editor's logic:
 * schema.js (load/edit/save a room's data/*.json), room-scaffold.js (the
 * three extra touch-points a brand-new room needs, plus the id collision
 * check that must pass before any of the four files get written), and the
 * geometry/gesture layer in tools.js + canvas-renderer.js (corner-resize
 * math, and the two interchangeable ways to reposition a placed item).
 *
 * The rendering itself (canvas-renderer.js's DOM building) and most of
 * tools.js's browser-only bits (real SVG geometry, File System Access)
 * still aren't covered here — same reason room.js's pixel/CSS behaviour
 * isn't unit-tested beyond the DOM state it produces — but the pointer
 * gesture *state machine* in createToolController is, by dispatching
 * synthetic events through jsdom (see the "dual placement mode" section
 * below): jsdom has no PointerEvent constructor, so a MouseEvent built
 * with the string type 'pointerdown'/'pointermove'/'pointerup' is used
 * instead — dispatch matches listeners by that type string regardless of
 * which constructor built the event, and MouseEvent already carries the
 * clientX/clientY/button tools.js reads.
 *
 * Run: node test/editor.test.mjs
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const results = [];

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/editor.html' });
global.window = dom.window;
global.document = dom.window.document;

const {
  normalizeRoomData, serializeRoomData, createBlankRoomData, cloneRoomLayoutOnly, createShape, createDevice, nextDeviceId, snap,
  LAYOUT_SHAPE_TYPES, PLACEABLE_SHAPE_TYPES, ENTRANCE_WIDTH, shapeDisplayName,
  generateAssetId, registerAssetId, normalizeAssetsData, serializeAssetsData, findAssetIdOwner,
  normalizeRoomStatus, isLayoutLocked,
} = await import('../js/editor/schema.js');
const {
  roomFileStem, dataUrlForId, generateRoomHtml,
  extractIndexRoomStems, extractIndexSites, patchIndexHtml,
  extractAllRoomsIds, patchExportJs, validateNewRoomId,
} = await import('../js/editor/room-scaffold.js');
const { render, clientToSvgPoint } = await import('../js/editor/canvas-renderer.js');
const { createToolController, resizeRect, resizeRectOutline, isAxisAlignedRect4 } = await import('../js/editor/tools.js');

function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function readJson(rel) {
  return JSON.parse(readFile(rel));
}
const crlfToLf = s => s.replace(/\r\n/g, '\n');
// js/build-grid.js's writeFileSync doesn't append a trailing newline, so any
// of the 4 grid-based rooms loses theirs the next time it's regenerated —
// not a schema requirement, so tolerate a missing/extra trailing newline
// when comparing round-tripped JSON.
const normalizeTrailingNewline = s => crlfToLf(s).replace(/\n*$/, '\n');
// Whitespace-only tooling can't reliably preserve trailing spaces on blank
// lines (invisible, no functional effect); ignore them when comparing the
// generated HTML shell against the real, hand-authored one.
const normalizeTrailingWs = s => crlfToLf(s).split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n');

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

const REAL_ROOMS = ['commons', 'annex', 'workshop', 'b2-204', 'b2-210'];

/* ══════════════════════════════════════════════════════════════════
   1. Editing an existing room round-trips correctly
   ══════════════════════════════════════════════════════════════════ */

for (const room of REAL_ROOMS) {
  await test(`round-trip (no edits) reproduces data/${room}.json exactly`, async () => {
    const original = readFile(`data/${room}.json`);
    const parsed = JSON.parse(original);
    const roundTripped = serializeRoomData(normalizeRoomData(parsed));
    assertEqual(normalizeTrailingNewline(roundTripped), normalizeTrailingNewline(original), `data/${room}.json did not round-trip byte-for-byte`);
  });
}

await test('moving a device only changes that device\'s top/left', async () => {
  const original = readJson('data/b2-210.json');
  const data = normalizeRoomData(original);
  const before = JSON.stringify(data.devices.find(d => d.id !== 'PC1'));

  const pc1 = data.devices.find(d => d.id === 'PC1');
  pc1.top = snap(500.4, 10);
  pc1.left = snap(88.2, 10);

  const saved = JSON.parse(serializeRoomData(data));
  const movedBack = saved.devices.find(d => d.id === 'PC1');
  assertEqual(movedBack.top, 500, 'top not snapped/saved correctly');
  assertEqual(movedBack.left, 90, 'left not snapped/saved correctly');

  const untouched = saved.devices.find(d => d.id !== 'PC1' && d.id === original.devices.find(x => x.id !== 'PC1').id);
  assertEqual(JSON.stringify(untouched), before, 'a device that was not touched changed anyway');
  assertEqual(saved.devices.length, original.devices.length, 'device count changed from just moving one device');
});

await test('adding a device assigns a free id and keeps id/type/top/left key order', async () => {
  const data = normalizeRoomData(readJson('data/b2-210.json'));
  const id = nextDeviceId(data.devices, 'pc');
  assertEqual(id, 'PC25', 'expected the next free PC id after PC1..PC24');

  const device = createDevice(data.devices, 'pc', 300, 400);
  data.devices.push(device);

  const saved = JSON.parse(serializeRoomData(data));
  const added = saved.devices[saved.devices.length - 1];
  assertEqual(Object.keys(added).join(','), 'id,type,top,left', 'device key order drifted from the schema');
  assertEqual(added.id, 'PC25', 'new device id was not PC25');
});

await test('a device label is only written when set, and dropped when cleared', async () => {
  const data = normalizeRoomData(readJson('data/workshop.json'));
  const staff = data.devices.find(d => d.id === 'STAFF-PC');
  assert(staff.label === 'Staff', 'fixture assumption changed — STAFF-PC should have a label');

  delete staff.label;
  let saved = JSON.parse(serializeRoomData(data));
  assert(!('label' in saved.devices.find(d => d.id === 'STAFF-PC')), 'label key should be gone once cleared');

  staff.label = 'Front Desk';
  saved = JSON.parse(serializeRoomData(data));
  assertEqual(saved.devices.find(d => d.id === 'STAFF-PC').label, 'Front Desk', 'label not saved after being set again');
});

await test('deleting a shape removes exactly that entry and nothing else', async () => {
  const data = normalizeRoomData(readJson('data/annex.json'));
  const before = data.layout.length;
  const doorIndex = data.layout.findIndex(s => s.type === 'door');
  data.layout.splice(doorIndex, 1);

  const saved = JSON.parse(serializeRoomData(data));
  assertEqual(saved.layout.length, before - 1, 'layout length did not shrink by exactly one');
  assert(!saved.layout.some(s => s.type === 'door'), 'the door shape is still present');
});

await test('createShape produces the documented key order for every layout shape type', async () => {
  const expectedFields = {
    outline: 'type,points',
    floor: 'type,x,y,width,height',
    room: 'type,label,x,y,width,height',
    entrance: 'type,label,x,y,width,height',
    counter: 'type,x,y,width,height',
    wallrect: 'type,x,y,width,height',
    wall: 'type,x1,y1,x2,y2',
    door: 'type,hinge,jamb',
  };
  for (const type of LAYOUT_SHAPE_TYPES) {
    const data = createBlankRoomData();
    data.layout.push(createShape(type, 10, 20));
    const saved = JSON.parse(serializeRoomData(data));
    assertEqual(Object.keys(saved.layout[0]).join(','), expectedFields[type], `unexpected key order for shape type "${type}"`);
  }
});

/* ══════════════════════════════════════════════════════════════════
   1b. Room status (draft/final) — a separate concept from device
       inspectionState/condition, never touched here
   ══════════════════════════════════════════════════════════════════ */

await test('normalizeRoomStatus defaults anything but the literal string "final" to "draft"', async () => {
  assertEqual(normalizeRoomStatus('final'), 'final', '"final" should normalize to itself');
  assertEqual(normalizeRoomStatus('draft'), 'draft', '"draft" should normalize to itself');
  assertEqual(normalizeRoomStatus(undefined), 'draft', 'a missing status should default to draft, the safe default');
  assertEqual(normalizeRoomStatus(null), 'draft', 'a null status should default to draft');
  assertEqual(normalizeRoomStatus('Final'), 'draft', 'a wrong-case value should not silently pass as final');
  assertEqual(normalizeRoomStatus('published'), 'draft', 'an unrecognized value should default to draft, not throw or pass through');
});

await test('createBlankRoomData starts "draft" — a brand-new room is never immediately visible to the inspection app', async () => {
  const data = createBlankRoomData();
  assertEqual(data.status, 'draft', 'a brand-new room should start draft');
  assertEqual(isLayoutLocked(data), false, 'a draft room\'s layout should not be locked');
  const saved = JSON.parse(serializeRoomData(data));
  assertEqual(saved.status, 'draft', 'status should round-trip through serialization');
  assertEqual(Object.keys(saved)[0], 'status', 'status should be the first key, matching the migrated seed files');
});

await test('cloneRoomLayoutOnly always resets status to "draft", even when copying an already-final room', async () => {
  const source = normalizeRoomData({ status: 'final', canvasWidth: 1200, canvasHeight: 800, layout: [], devices: [] });
  const copy = cloneRoomLayoutOnly(source);
  assertEqual(copy.status, 'draft', 'a duplicated room should start draft regardless of its source\'s status');
  assertEqual(source.status, 'final', 'cloning should not mutate the source\'s own status');
});

await test('the 5 real seed rooms are all migrated to "final"', async () => {
  for (const room of REAL_ROOMS) {
    const data = normalizeRoomData(readJson(`data/${room}.json`));
    assertEqual(data.status, 'final', `data/${room}.json should be status "final"`);
  }
});

await test('isLayoutLocked reflects status exactly, and only ever gates layout — never devices', async () => {
  const draft = { status: 'draft', devices: [{ id: 'PC1' }] };
  const final = { status: 'final', devices: [{ id: 'PC1' }] };
  assertEqual(isLayoutLocked(draft), false, 'a draft room\'s layout should not be locked');
  assertEqual(isLayoutLocked(final), true, 'a final room\'s layout should be locked');
  // isLayoutLocked only ever answers "is the layout locked" — it takes no
  // stance on devices at all, which is the whole point (see schema.js's
  // ROOM_STATUSES comment): the two are entirely separate models.
});

await test('snap() rounds to the nearest grid multiple, and passes through when gridSize is falsy', async () => {
  assertEqual(snap(23, 10), 20, 'snap(23, 10) should be 20');
  assertEqual(snap(27, 10), 30, 'snap(27, 10) should be 30');
  assertEqual(snap(23.7, 0), 23.7, 'snap with gridSize 0 should be a no-op');
});

/* ══════════════════════════════════════════════════════════════════
   2. Creating a new room: all four touch points, no id collision
   ══════════════════════════════════════════════════════════════════ */

await test('generateRoomHtml matches the real page shell byte-for-byte (modulo id/label/campus/dataUrl)', async () => {
  const real = readFile('rooms/b2-210.html');
  const generated = generateRoomHtml({
    id: 'B2-210', label: 'B2-210', campus: 'Northgate Site', dataUrl: '../data/b2-210.json',
  });
  assertEqual(normalizeTrailingWs(generated), normalizeTrailingWs(real), 'generated HTML shell does not match the real rooms/b2-210.html');
});

await test('dataUrlForId / roomFileStem follow the existing lowercase-id convention', async () => {
  assertEqual(roomFileStem('S28-110'), 's28-110', 'file stem should be the lowercased id');
  assertEqual(dataUrlForId('S28-110'), '../data/s28-110.json', 'dataUrl should point at the lowercased data file');
});

await test('patchIndexHtml inserts a room-link into an existing site without touching the rest of the file', async () => {
  const original = readFile('index.html');
  const patched = patchIndexHtml(original, { id: 'B2-999', label: 'B2-999', campus: 'Northgate Site' });

  assert(patched.includes('href="rooms/b2-999.html"'), 'new room-link not inserted');
  assert(patched.indexOf('id="rooms-northgate"') < patched.indexOf('href="rooms/b2-999.html"'), 'new link landed outside the Northgate site list');

  // Every existing room link must still be present, in the same relative
  // order — the new one is inserted mid-list (end of Northgate's site,
  // ahead of Riverside's rooms), so compare with it filtered back out.
  const before = extractIndexRoomStems(original);
  const after = extractIndexRoomStems(patched);
  assertEqual(after.length, before.length + 1, 'expected exactly one new room-link');
  const afterWithoutNew = after.filter(stem => stem !== 'b2-999');
  assertEqual(afterWithoutNew.join(','), before.join(','), 'existing room-link order was disturbed');
});

await test('patchIndexHtml creates a new site card when the site does not exist yet', async () => {
  const original = readFile('index.html');
  const patched = patchIndexHtml(original, { id: 'NEW1', label: 'New Room', campus: 'Northern Site' });

  assert(patched.includes('<h2 class="site-name">Northern Site</h2>'), 'new site heading not added');
  assert(patched.includes('href="rooms/new1.html"'), 'new room-link not added under the new site');

  const sites = extractIndexSites(patched);
  assertEqual(sites.length, extractIndexSites(original).length + 1, 'expected exactly one new site');
  assert(sites.includes('Northern Site'), 'Northern Site missing from extracted site list');
});

await test('patchExportJs appends to ALL_ROOMS and leaves existing entries untouched', async () => {
  const original = readFile('js/export.js');
  const before = extractAllRoomsIds(original);
  const patched = patchExportJs(original, { id: 'B2-999', label: 'B2-999', campus: 'Northgate Site' });
  const after = extractAllRoomsIds(patched);

  assertEqual(after.length, before.length + 1, 'expected exactly one new ALL_ROOMS entry');
  assert(before.every((id, i) => after[i] === id), 'existing ALL_ROOMS entries were reordered or altered');
  assertEqual(after[after.length - 1], 'B2-999', 'new id not appended to ALL_ROOMS');
  assert(patched.includes("campus: 'Northgate Site'"), 'new entry missing its campus field');
});

await test('validateNewRoomId rejects an id already used anywhere, and accepts a genuinely free one', async () => {
  const registry = {
    dataStems: REAL_ROOMS,
    roomHtmlStems: REAL_ROOMS,
    indexStems: extractIndexRoomStems(readFile('index.html')),
    exportIds: extractAllRoomsIds(readFile('js/export.js')),
  };

  assert(validateNewRoomId('ANNEX', registry).length > 0, 'exact-case collision with an existing room was not caught');
  assert(validateNewRoomId('annex', registry).length > 0, 'case-insensitive collision (Windows filenames) was not caught');
  assert(validateNewRoomId('B2-210', registry).length > 0, 'collision with an existing hyphenated id was not caught');
  assertEqual(validateNewRoomId('B2-999', registry).length, 0, 'a genuinely free id was rejected');
  assertEqual(validateNewRoomId('', registry).length, 1, 'an empty id should produce exactly one problem');
  assert(validateNewRoomId('Room 5', registry).length > 0, 'an id with a space should be rejected (unsafe as filename/URL)');
  assert(validateNewRoomId('room/5', registry).length > 0, 'an id with a slash should be rejected');
});

await test('end-to-end: creating a new room produces four internally-consistent, mutually-agreeing contents', async () => {
  const indexHtml = readFile('index.html');
  const exportJs = readFile('js/export.js');
  const registry = {
    dataStems: REAL_ROOMS,
    roomHtmlStems: REAL_ROOMS,
    indexStems: extractIndexRoomStems(indexHtml),
    exportIds: extractAllRoomsIds(exportJs),
  };

  const room = { id: 'B2-220', label: 'B2-220', campus: 'Northgate Site' };
  assertEqual(validateNewRoomId(room.id, registry).length, 0, 'fixture id unexpectedly collided');

  const dataText = serializeRoomData(createBlankRoomData(1200, 800));
  const roomHtml = generateRoomHtml({ ...room, dataUrl: dataUrlForId(room.id) });
  const newIndexHtml = patchIndexHtml(indexHtml, room);
  const newExportJs = patchExportJs(exportJs, room);

  // 1. data/{id}.json — well-formed and blank.
  const parsedData = JSON.parse(dataText);
  assertEqual(parsedData.devices.length, 0, 'a brand-new room should start with no devices');
  assertEqual(parsedData.layout.length, 0, 'a brand-new room should start with no layout shapes');

  // 2. rooms/{id}.html — ROOM_META agrees with the data file path and the room's own id/label/campus.
  assert(roomHtml.includes(`id:      'B2-220'`), 'ROOM_META.id mismatch');
  assert(roomHtml.includes(`dataUrl: '../data/b2-220.json'`), 'ROOM_META.dataUrl does not point at the generated data file');
  assert(roomHtml.includes(`campus:  'Northgate Site'`), 'ROOM_META.campus mismatch');

  // 3. index.html — links to the same file the HTML shell was generated for.
  assert(newIndexHtml.includes(`href="rooms/${roomFileStem(room.id)}.html"`), 'index.html link does not match the generated room HTML filename');

  // 4. js/export.js — ALL_ROOMS entry matches the same id/label/campus.
  const allRoomsAfter = extractAllRoomsIds(newExportJs);
  assert(allRoomsAfter.includes('B2-220'), 'ALL_ROOMS missing the new id');
  assert(newExportJs.includes("label: 'B2-220', campus: 'Northgate Site'"), 'ALL_ROOMS entry fields do not match the room being created');
});

await test('cloneRoomLayoutOnly copies layout/canvas size but starts with no devices', async () => {
  const source = normalizeRoomData(readJson('data/commons.json'));
  assert(source.devices.length > 0, 'fixture assumption changed — commons.json should have devices');

  const copy = cloneRoomLayoutOnly(source);
  assertEqual(copy.devices.length, 0, 'a layout copy should start with no devices');
  assertEqual(copy.canvasWidth, source.canvasWidth, 'canvasWidth should carry over from the source');
  assertEqual(copy.canvasHeight, source.canvasHeight, 'canvasHeight should carry over from the source');
  assertEqual(JSON.stringify(copy.layout), JSON.stringify(source.layout), 'layout should be copied as-is');
});

await test('cloneRoomLayoutOnly deep-clones layout so editing the copy never mutates the source', async () => {
  const source = normalizeRoomData(readJson('data/commons.json'));
  const outlineBefore = JSON.stringify(source.layout.find(s => s.type === 'outline').points);

  const copy = cloneRoomLayoutOnly(source);
  const copiedOutline = copy.layout.find(s => s.type === 'outline');
  copiedOutline.points[0][0] = 9999; // mutate a nested array in the copy
  copy.layout.find(s => s.type === 'room').x = 9999; // mutate a plain field in the copy

  assertEqual(JSON.stringify(source.layout.find(s => s.type === 'outline').points), outlineBefore, 'mutating the copy\'s outline points changed the source');
  assert(source.layout.find(s => s.type === 'room').x !== 9999, 'mutating the copy\'s shape fields changed the source');
});

/* ══════════════════════════════════════════════════════════════════
   3. Rectangle-lock on boundary shapes, and dual placement mode
   ══════════════════════════════════════════════════════════════════ */

function corners(shape) {
  return {
    nw: [shape.x, shape.y],
    ne: [shape.x + shape.width, shape.y],
    se: [shape.x + shape.width, shape.y + shape.height],
    sw: [shape.x, shape.y + shape.height],
  };
}

await test('dragging a rect-kind corner handle (room/wallrect/etc) only ever resizes, keeping the opposite corner fixed', async () => {
  for (const type of ['room', 'wallrect', 'floor', 'entrance', 'counter']) {
    const shape = createShape(type, 10, 20); // {x:10, y:20, width/height per factory defaults}
    const before = corners(shape);
    const orig = { x: shape.x, y: shape.y, width: shape.width, height: shape.height };

    // Relative to the shape's own size (not a fixed point) so this never
    // accidentally flips through the opposite corner for a small shape
    // like wallrect's default 100x20 — flipping is covered separately below.
    const newX = orig.x - 5, newY = orig.y - 5;
    resizeRect(shape, 'nw', orig, newX, newY);

    assertEqual(shape.width > 0 && shape.height > 0, true, `${type}: resized to a non-positive size`);
    const after = corners(shape);
    assertEqual(after.se[0], before.se[0], `${type}: opposite (SE) corner X moved`);
    assertEqual(after.se[1], before.se[1], `${type}: opposite (SE) corner Y moved`);
    assertEqual(after.nw[0], newX, `${type}: dragged corner did not land at the new X`);
    assertEqual(after.nw[1], newY, `${type}: dragged corner did not land at the new Y`);
    // A shape defined purely by {x,y,width,height} cannot help but stay an
    // axis-aligned rectangle — no independent per-corner coordinates exist
    // to skew — but assert it structurally rather than just trust that.
    assert(isAxisAlignedRect4([after.nw, after.ne, after.se, after.sw]), `${type}: corners no longer form a rectangle`);
  }
});

await test('dragging a rect-kind corner past the opposite corner flips cleanly instead of going negative', async () => {
  const shape = createShape('room', 100, 100); // 160x120, so SE = (260, 220)
  const orig = { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  resizeRect(shape, 'se', orig, 50, 60); // drag SE up-and-left of NW (100,100)
  assert(shape.width >= 1 && shape.height >= 1, 'flipping through the opposite corner produced a non-positive size');
  assertEqual(shape.x, 50, 'x did not follow the flip');
  assertEqual(shape.y, 60, 'y did not follow the flip');
  assertEqual(shape.width, 50, 'width wrong after flip (100 - 50)');
  assertEqual(shape.height, 40, 'height wrong after flip (100 - 60)');
});

await test('dragging a 4-point rectangular outline corner keeps it a rectangle (adjacent edges move, opposite corner fixed)', async () => {
  const shape = createShape('outline', 0, 0); // [[0,0],[200,0],[200,150],[0,150]] — NW,NE,SE,SW
  const orig = { points: shape.points.map(p => [...p]) };

  resizeRectOutline(shape, orig, 0, 30, 40); // drag NW (index 0) to (30, 40)

  assertEqual(JSON.stringify(shape.points[0]), JSON.stringify([30, 40]), 'dragged vertex did not move to the new point');
  assertEqual(JSON.stringify(shape.points[1]), JSON.stringify([200, 40]), 'NE neighbour should inherit the new Y, keep its own X');
  assertEqual(JSON.stringify(shape.points[3]), JSON.stringify([30, 150]), 'SW neighbour should inherit the new X, keep its own Y');
  assertEqual(JSON.stringify(shape.points[2]), JSON.stringify([200, 150]), 'opposite (SE) vertex must stay completely fixed');
  assert(isAxisAlignedRect4(shape.points), 'outline no longer forms a rectangle after the corner drag');
});

await test('isAxisAlignedRect4 does not misclassify a real non-rectangular outline (commons\' L-shape)', async () => {
  const commonsOutline = readJson('data/commons.json').layout.find(s => s.type === 'outline');
  assertEqual(commonsOutline.points.length, 6, 'fixture assumption changed — expected the 6-point L-shaped outline');
  assertEqual(isAxisAlignedRect4(commonsOutline.points), false, 'a 6-point L-shaped outline was misidentified as a lockable rectangle');
});

/** Dispatches a synthetic pointer event of the given type (jsdom has no
 *  PointerEvent constructor, so a MouseEvent is built with that type
 *  string instead — see the file header). */
function pointerEvent(type, clientX, clientY) {
  return new window.MouseEvent(type, { bubbles: true, clientX, clientY, button: 0 });
}

await test('press-drag-release and click-then-click reposition a device to the identical resulting position', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = { canvasWidth: 1200, canvasHeight: 800, layout: [], devices: [] };
  render(svg, data, { selection: null, gridSize: 0, showGrid: false }); // establishes the viewBox clientToSvgPoint reads

  const start = clientToSvgPoint(svg, 10, 10);
  const destination = clientToSvgPoint(svg, 90, 40);
  assert(Math.hypot(destination.x - start.x, destination.y - start.y) > 10, 'fixture start/destination are too close to tell a drag from a click');

  data.devices.push({ id: 'DRAGGED', type: 'pc', top: start.y, left: start.x });
  data.devices.push({ id: 'CLICKED', type: 'pc', top: start.y, left: start.x });
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  const state = { data, tool: { type: 'select' }, gridSize: 0, selection: null };
  createToolController(svg, () => state, patch => Object.assign(state, patch));

  const dragged = svg.querySelector('[data-kind="device"][data-index="0"]');
  const clicked = svg.querySelector('[data-kind="device"][data-index="1"]');

  // Method A: press-drag-release, grabbed at its exact top-left (zero offset).
  dragged.dispatchEvent(pointerEvent('pointerdown', 10, 10));
  svg.dispatchEvent(pointerEvent('pointermove', 90, 40));
  window.dispatchEvent(pointerEvent('pointerup', 90, 40));

  // Method B: a plain click (no movement) selects + arms move-pending;
  // the next click anywhere is read as the destination.
  clicked.dispatchEvent(pointerEvent('pointerdown', 5, 5));
  window.dispatchEvent(pointerEvent('pointerup', 5, 5));
  svg.dispatchEvent(pointerEvent('pointerdown', 90, 40));
  window.dispatchEvent(pointerEvent('pointerup', 90, 40));

  const a = data.devices.find(d => d.id === 'DRAGGED');
  const b = data.devices.find(d => d.id === 'CLICKED');
  assertEqual(a.left, destination.x, 'drag did not land the device exactly at the destination');
  assertEqual(a.top, destination.y, 'drag did not land the device exactly at the destination');
  assertEqual(b.left, a.left, 'click-then-click produced a different X than press-drag-release');
  assertEqual(b.top, a.top, 'click-then-click produced a different Y than press-drag-release');
});

await test('a plain click does not get misread as a zero-distance drag (no movement happens without a destination click)', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = { canvasWidth: 1200, canvasHeight: 800, layout: [], devices: [{ id: 'PC1', type: 'pc', top: 40, left: 60 }] };
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  const state = { data, tool: { type: 'select' }, gridSize: 0, selection: null };
  createToolController(svg, () => state, patch => Object.assign(state, patch));

  const node = svg.querySelector('[data-kind="device"][data-index="0"]');
  node.dispatchEvent(pointerEvent('pointerdown', 5, 5));
  window.dispatchEvent(pointerEvent('pointerup', 5, 5));

  assertEqual(data.devices[0].top, 40, 'a plain click alone moved the device');
  assertEqual(data.devices[0].left, 60, 'a plain click alone moved the device');
  assertEqual(state.selection?.kind, 'device', 'a plain click should still select the device');
});

/* ══════════════════════════════════════════════════════════════════
   3b. Geometry locking — a "final" room's layout[] is protected against
       placement/move/resize/delete; devices[] never are
   ══════════════════════════════════════════════════════════════════ */

function lockedRoomWithWall() {
  return {
    status: 'final',
    canvasWidth: 1200, canvasHeight: 800,
    layout: [{ type: 'wall', x1: 100, y1: 100, x2: 300, y2: 100 }],
    devices: [{ id: 'PC1', type: 'pc', top: 400, left: 400 }],
  };
}

await test('placing a new shape is blocked on a locked room, and calls onLockedAttempt', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = lockedRoomWithWall();
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  const state = { data, tool: { type: 'add-shape', shapeType: 'wall' }, gridSize: 0, selection: null };
  let lockedCalls = 0;
  createToolController(svg, () => state, patch => Object.assign(state, patch), () => { lockedCalls++; });

  svg.dispatchEvent(pointerEvent('pointerdown', 50, 50));
  assertEqual(data.layout.length, 1, 'a new shape should not have been added to a locked room\'s layout');
  assertEqual(lockedCalls, 1, 'onLockedAttempt should fire exactly once for the blocked placement');
  assertEqual(state.tool.type, 'select', 'the add-shape tool should disarm back to select after being blocked');
});

await test('placing a new shape still works on a draft room (unaffected by the lock)', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = { ...lockedRoomWithWall(), status: 'draft' };
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  const state = { data, tool: { type: 'add-shape', shapeType: 'wall' }, gridSize: 0, selection: null };
  let lockedCalls = 0;
  createToolController(svg, () => state, patch => Object.assign(state, patch), () => { lockedCalls++; });

  svg.dispatchEvent(pointerEvent('pointerdown', 50, 50));
  assertEqual(data.layout.length, 2, 'a new shape should be added on a draft room');
  assertEqual(lockedCalls, 0, 'onLockedAttempt should never fire on a draft room');
});

await test('press-drag-release does not move a locked room\'s existing shape, and calls onLockedAttempt once', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = lockedRoomWithWall();
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  const state = { data, tool: { type: 'select' }, gridSize: 0, selection: null };
  let lockedCalls = 0;
  createToolController(svg, () => state, patch => Object.assign(state, patch), () => { lockedCalls++; });

  const wallLine = svg.querySelector('[data-kind="shape"][data-index="0"] .ed-hit-line');
  const before = JSON.stringify(data.layout[0]);
  wallLine.dispatchEvent(pointerEvent('pointerdown', 10, 10));
  svg.dispatchEvent(pointerEvent('pointermove', 90, 90));
  window.dispatchEvent(pointerEvent('pointerup', 90, 90));

  assertEqual(JSON.stringify(data.layout[0]), before, 'a locked wall should not have moved');
  assertEqual(lockedCalls, 1, 'onLockedAttempt should fire exactly once per blocked drag gesture, not on every pointermove tick');
  assertEqual(state.selection?.kind, 'shape', 'the shape should still become selected (viewable), even though it can\'t be dragged');
});

await test('click-then-click does not move a locked room\'s existing shape', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = lockedRoomWithWall();
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  const state = { data, tool: { type: 'select' }, gridSize: 0, selection: null };
  let lockedCalls = 0;
  createToolController(svg, () => state, patch => Object.assign(state, patch), () => { lockedCalls++; });

  const wallLine = svg.querySelector('[data-kind="shape"][data-index="0"] .ed-hit-line');
  const before = JSON.stringify(data.layout[0]);
  wallLine.dispatchEvent(pointerEvent('pointerdown', 10, 10));
  window.dispatchEvent(pointerEvent('pointerup', 10, 10));
  svg.dispatchEvent(pointerEvent('pointerdown', 90, 90));
  window.dispatchEvent(pointerEvent('pointerup', 90, 90));

  assertEqual(JSON.stringify(data.layout[0]), before, 'a locked wall should not have moved via click-then-click either');
  assert(lockedCalls >= 1, 'onLockedAttempt should fire for the blocked click-then-click destination click');
});

await test('a locked shape\'s resize handle does not resize it', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = { ...lockedRoomWithWall(), layout: [createShape('room', 100, 100)] };
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  const state = { data, tool: { type: 'select' }, gridSize: 0, selection: null };
  let lockedCalls = 0;
  createToolController(svg, () => state, patch => Object.assign(state, patch), () => { lockedCalls++; });

  const before = JSON.stringify(data.layout[0]);
  const handle = svg.querySelector('[data-kind="shape-point"][data-point="se"]');
  assert(handle, 'expected an SE resize handle on the rect-kind shape');
  handle.dispatchEvent(pointerEvent('pointerdown', 10, 10));
  svg.dispatchEvent(pointerEvent('pointermove', 90, 90));
  window.dispatchEvent(pointerEvent('pointerup', 90, 90));

  assertEqual(JSON.stringify(data.layout[0]), before, 'a locked shape should not have resized via its handle');
  assertEqual(lockedCalls, 1, 'onLockedAttempt should fire once for the blocked resize');
});

await test('devices stay fully draggable and placeable on a locked (final) room', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = lockedRoomWithWall();
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  const state = { data, tool: { type: 'select' }, gridSize: 0, selection: null };
  let lockedCalls = 0;
  createToolController(svg, () => state, patch => Object.assign(state, patch), () => { lockedCalls++; });

  const deviceNode = svg.querySelector('[data-kind="device"][data-index="0"]');
  deviceNode.dispatchEvent(pointerEvent('pointerdown', 10, 10));
  svg.dispatchEvent(pointerEvent('pointermove', 90, 40));
  window.dispatchEvent(pointerEvent('pointerup', 90, 40));

  assert(data.devices[0].left !== 400 || data.devices[0].top !== 400, 'a device should still be draggable when the room\'s layout is locked');
  assertEqual(lockedCalls, 0, 'moving a device should never trigger the layout-locked feedback');

  // Placing a brand-new device should work too.
  const state2 = { data, tool: { type: 'add-device', deviceType: 'pc' }, gridSize: 0, selection: null };
  createToolController(svg, () => state2, patch => Object.assign(state2, patch), () => { lockedCalls++; });
  svg.dispatchEvent(pointerEvent('pointerdown', 5, 5));
  assertEqual(data.devices.length, 2, 'a new device should still be placeable on a locked room');
  assertEqual(lockedCalls, 0, 'placing a device should never trigger the layout-locked feedback');
});

/* ══════════════════════════════════════════════════════════════════
   4. Grid controls actually render, pillar is gone, door merges into
      entrance
   ══════════════════════════════════════════════════════════════════ */

await test('Show Grid on draws a fill="url(#...)" pattern rect; off draws a plain background rect', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = { canvasWidth: 400, canvasHeight: 300, layout: [], devices: [] };

  render(svg, data, { selection: null, gridSize: 10, showGrid: true });
  const gridRect = svg.querySelector('rect.ed-grid-bg');
  assert(gridRect, 'no grid rect rendered when Show Grid is on');
  assert(/^url\(#.+\)$/.test(gridRect.getAttribute('fill')), `grid rect's fill attribute should reference the pattern, got "${gridRect.getAttribute('fill')}"`);
  assert(svg.querySelector('pattern'), 'no <pattern> defined when Show Grid is on');

  render(svg, data, { selection: null, gridSize: 10, showGrid: false });
  assert(!svg.querySelector('rect.ed-grid-bg'), 'grid rect still present after turning Show Grid off');
  assert(svg.querySelector('rect.ed-canvas-bg'), 'no plain background rect rendered when Show Grid is off');
});

await test('grid size visibly changes the pattern spacing (and nothing else)', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = { canvasWidth: 400, canvasHeight: 300, layout: [], devices: [] };

  render(svg, data, { selection: null, gridSize: 10, showGrid: true });
  assertEqual(svg.querySelector('pattern').getAttribute('width'), '10', 'pattern width should match gridSize');

  render(svg, data, { selection: null, gridSize: 40, showGrid: true });
  assertEqual(svg.querySelector('pattern').getAttribute('width'), '40', 'changing grid size did not change the pattern spacing');
  assertEqual(svg.querySelector('pattern').getAttribute('height'), '40', 'changing grid size did not change the pattern spacing');
});

await test('grid size is the same number used for drag snapping', async () => {
  // Regression for the size input only reaching the renderer, not tools.js's
  // snap calls (state.gridSize is the single value both read).
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = { canvasWidth: 1200, canvasHeight: 800, layout: [], devices: [{ id: 'PC1', type: 'pc', top: 0, left: 0 }] };
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  const state = { data, tool: { type: 'select' }, gridSize: 25, selection: null };
  createToolController(svg, () => state, patch => Object.assign(state, patch));

  const node = svg.querySelector('[data-kind="device"][data-index="0"]');
  const p0 = clientToSvgPoint(svg, 0, 0);
  const p1 = clientToSvgPoint(svg, 1, 1); // an arbitrary small move, snapped against gridSize=25
  node.dispatchEvent(pointerEvent('pointerdown', 0, 0));
  svg.dispatchEvent(pointerEvent('pointermove', 1, 1));
  window.dispatchEvent(pointerEvent('pointerup', 1, 1));

  assertEqual(data.devices[0].left, snap(p1.x - p0.x, 25), 'device did not snap using state.gridSize');
});

await test('pillar is gone: not a schema type, not placeable, and createShape rejects it', async () => {
  assert(!LAYOUT_SHAPE_TYPES.includes('pillar'), 'pillar is still a recognized schema type');
  assert(!PLACEABLE_SHAPE_TYPES.includes('pillar'), 'pillar is still offered as a placeable shape');
  let threw = false;
  try { createShape('pillar', 0, 0); } catch { threw = true; }
  assert(threw, 'createShape("pillar", ...) should throw now that it is removed');
});

await test('canvas-renderer no longer draws a pillar for a stray pillar-typed shape in old data', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = { canvasWidth: 400, canvasHeight: 300, layout: [{ type: 'pillar', cx: 50, cy: 50, r: 16 }], devices: [] };
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });
  assert(!svg.querySelector('.ed-pillar, .ed-pillar-mark'), 'a pillar shape was still rendered');
});

await test('door merges into entrance: fixed at ENTRANCE_WIDTH, displayed as "entrance", not placeable as the old rect style', async () => {
  assertEqual(ENTRANCE_WIDTH, 90, 'expected the standard entrance width to be 90 (the most common real door width)');
  assertEqual(shapeDisplayName('door'), 'entrance', 'the "door" shape type should be labelled "entrance" everywhere in the UI');

  const shape = createShape('door', 100, 200);
  const dx = shape.jamb[0] - shape.hinge[0], dy = shape.jamb[1] - shape.hinge[1];
  assertEqual(Math.hypot(dx, dy), ENTRANCE_WIDTH, 'a newly-placed entrance should be exactly ENTRANCE_WIDTH wide');

  // Only one creatable "entrance" now — the legacy rect-style `entrance`
  // (data/commons.json's) is still recognized (loads/renders/saves fine)
  // but isn't offered for new placement any more.
  assert(PLACEABLE_SHAPE_TYPES.includes('door'), 'the fixed-width entrance (JSON type "door") should still be placeable');
  assert(!PLACEABLE_SHAPE_TYPES.includes('entrance'), 'the legacy resizable-rect entrance should no longer be placeable');
  assert(LAYOUT_SHAPE_TYPES.includes('entrance'), 'the legacy rect-style entrance should still be a recognized schema type (data/commons.json has one)');
});

await test('a placed entrance has no per-point resize handles — whole-shape move only', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = { canvasWidth: 400, canvasHeight: 300, layout: [createShape('door', 50, 50)], devices: [] };
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  assert(svg.querySelector('[data-kind="shape"][data-index="0"]'), 'the entrance itself should still be selectable/draggable as a whole');
  assert(!svg.querySelector('[data-kind="shape-point"]'), 'an entrance should not expose any per-point (resize) handles');
});

await test('commons.json\'s existing rect-style entrance still round-trips (backward compatibility)', async () => {
  const data = normalizeRoomData(readJson('data/commons.json'));
  const entrance = data.layout.find(s => s.type === 'entrance');
  assert(entrance, 'fixture assumption changed — commons.json should still have a rect-style entrance');
  const saved = JSON.parse(serializeRoomData(data));
  const savedEntrance = saved.layout.find(s => s.type === 'entrance');
  assertEqual(JSON.stringify(savedEntrance), JSON.stringify(entrance), 'the legacy entrance shape changed shape on an untouched round-trip');
});

/* ══════════════════════════════════════════════════════════════════
   5. Phase 2 — device.assetId + data/assets.json
   ══════════════════════════════════════════════════════════════════ */

await test('a device without an assetId still round-trips cleanly (no assetId key appears)', async () => {
  const data = normalizeRoomData({
    canvasWidth: 400, canvasHeight: 300, layout: [],
    devices: [{ id: 'PC1', type: 'pc', top: 10, left: 20 }],
  });
  const saved = JSON.parse(serializeRoomData(data)).devices[0];
  assert(!('assetId' in saved), 'a device with no assetId should not gain one on save');
  assertEqual(Object.keys(saved).join(','), 'id,type,top,left', 'key order should be unaffected by the new optional field');
});

await test('setting an assetId persists correctly, in the documented key order', async () => {
  const withAssetOnly = normalizeRoomData({
    canvasWidth: 400, canvasHeight: 300, layout: [],
    devices: [{ id: 'PC1', type: 'pc', top: 10, left: 20, assetId: 'AST-4K9QXZ' }],
  });
  const saved1 = JSON.parse(serializeRoomData(withAssetOnly)).devices[0];
  assertEqual(saved1.assetId, 'AST-4K9QXZ', 'assetId value should persist through load/save');
  assertEqual(Object.keys(saved1).join(','), 'id,type,top,left,assetId', 'assetId should be the last key when label is absent');

  const withBoth = normalizeRoomData({
    canvasWidth: 400, canvasHeight: 300, layout: [],
    devices: [{ id: 'PC2', type: 'staff', top: 1, left: 2, label: 'Staff 1', assetId: 'AST-000001' }],
  });
  const saved2 = JSON.parse(serializeRoomData(withBoth)).devices[0];
  assertEqual(Object.keys(saved2).join(','), 'id,type,top,left,label,assetId', 'assetId should come after label when both are present');
});

await test('clearing assetId (blank string) drops the key on save, like clearing a label does', async () => {
  const data = normalizeRoomData({
    canvasWidth: 400, canvasHeight: 300, layout: [],
    devices: [{ id: 'PC1', type: 'pc', top: 10, left: 20, assetId: '' }],
  });
  const saved = JSON.parse(serializeRoomData(data)).devices[0];
  assert(!('assetId' in saved), 'an explicitly blank assetId should not be written out');
});

await test('generateAssetId matches the documented AST-XXXXXX format', async () => {
  const id = generateAssetId({});
  assert(/^AST-[0-9A-Z]{6}$/.test(id), `unexpected id format: ${id}`);
});

await test('generateAssetId retries past a collision instead of returning a duplicate', async () => {
  // Force the first 6-character draw to land on "000000" (rand() → 0 every
  // time picks alphabet index 0), which is pre-seeded as already taken;
  // the next 6 draws are 0 except the last, which is pushed to the top
  // end of the alphabet, so the retry must land on a different id.
  const seeded = { 'AST-000000': { type: '', manufacturer: '', serial: '', notes: '' } };
  const values = [0, 0, 0, 0, 0, 0, /* retry → */ 0, 0, 0, 0, 0, 0.999999];
  let i = 0;
  const rand = () => values[i++];
  const id = generateAssetId(seeded, rand);
  assertEqual(id, 'AST-00000Z', 'should have retried past the seeded collision to the next candidate');
});

await test('registerAssetId adds a blank 4-field record for a brand-new id', async () => {
  const { assets, added } = registerAssetId({}, 'AST-NEW001');
  assert(added, 'should report that it added a new record');
  assertEqual(
    JSON.stringify(assets['AST-NEW001']),
    JSON.stringify({ type: '', manufacturer: '', serial: '', notes: '' }),
    'a new asset should start with all four fields blank',
  );
});

await test('registerAssetId never overwrites an already-registered record', async () => {
  const existing = { 'AST-1': { type: 'Laptop', manufacturer: 'Dell', serial: 'SN123', notes: 'spare' } };
  const { assets, added } = registerAssetId(existing, 'AST-1');
  assert(!added, 'should report nothing was added — the id already existed');
  assertEqual(JSON.stringify(assets['AST-1']), JSON.stringify(existing['AST-1']), 'an already-registered asset\'s data must not be reset to blank');
});

await test('registerAssetId is a no-op for a blank/falsy id', async () => {
  const { assets, added } = registerAssetId({ a: 1 }, '');
  assert(!added, 'a blank id should never be registered');
  assertEqual(Object.keys(assets).length, 1, 'assetsData should be unchanged');
});

await test('normalizeAssetsData tolerates a missing/malformed file, same as normalizeRoomData does', async () => {
  assertEqual(JSON.stringify(normalizeAssetsData(undefined)), '{}', 'a missing file should normalize to an empty lookup');
  assertEqual(JSON.stringify(normalizeAssetsData(null)), '{}', 'null should normalize to an empty lookup');
  assertEqual(JSON.stringify(normalizeAssetsData([1, 2, 3])), '{}', 'an array should normalize to an empty lookup');
  assertEqual(JSON.stringify(normalizeAssetsData('nope')), '{}', 'a string should normalize to an empty lookup');
});

await test('normalizeAssetsData preserves extra/unrecognized fields on a record', async () => {
  const raw = { 'AST-1': { type: 'PC', manufacturer: 'Dell', serial: 'X', notes: '', location: 'Rack 3' } };
  const normalized = normalizeAssetsData(raw);
  assertEqual(normalized['AST-1'].location, 'Rack 3', 'a hand-added field should not be dropped, same as any other unrecognized field would ride along untouched');
});

await test('data/assets.json is created/updated correctly as new assetIds get registered (simulated editor Save flow)', async () => {
  // Starting point: no data/assets.json on disk yet — loadAssetsRegistry()
  // in editor.js falls back to normalizeAssetsData(undefined) in that case.
  let assets = normalizeAssetsData(undefined);
  assertEqual(JSON.stringify(assets), '{}', 'starting from no file should behave like starting from {}');

  // First device: clicks "Generate", then Save.
  const id1 = generateAssetId(assets);
  let result = registerAssetId(assets, id1);
  assert(result.added, 'a brand-new generated id should be registered');
  assets = result.assets;

  const afterFirstSave = JSON.parse(serializeAssetsData(assets));
  assert(id1 in afterFirstSave, 'the first registered id should be present in the serialized file');
  assertEqual(
    JSON.stringify(afterFirstSave[id1]),
    JSON.stringify({ type: '', manufacturer: '', serial: '', notes: '' }),
    'a freshly-registered asset should start blank',
  );

  // Re-selecting the same device (or another device pointing at the same
  // physical asset) must not re-add or reset it.
  result = registerAssetId(assets, id1);
  assert(!result.added, 're-registering the same id a second time should be a no-op');

  // A second device gets its own new id.
  const id2 = generateAssetId(assets);
  assert(id2 !== id1, 'two Generate clicks against the same assets registry should never collide');
  result = registerAssetId(assets, id2);
  assert(result.added, 'a second, different generated id should also be registered');
  assets = result.assets;

  const afterSecondSave = JSON.parse(serializeAssetsData(assets));
  assertEqual(
    Object.keys(afterSecondSave).sort().join(','),
    [id1, id2].sort().join(','),
    'both registered ids should be present after a second save, with nothing dropped',
  );
});

/* ══════════════════════════════════════════════════════════════════
   6. Duplicate-assetId warning (project-wide, non-blocking)
   ══════════════════════════════════════════════════════════════════ */

// findAssetIdOwner is the pure decision logic behind editor.js's warning —
// it never touches disk itself (that's runAssetIdCheck/readOtherRoomsDevices
// in editor.js, browser-only File System Access glue not covered here, same
// boundary as every other FS-reading part of the editor). What's tested
// here is exactly what decides whether the warning appears and what it says.

await test('findAssetIdOwner reports nothing when the id is unused', async () => {
  const rooms = [{ roomId: 'b2-210', devices: [{ id: 'PC1', assetId: 'AST-AAAAAA' }] }];
  const owner = findAssetIdOwner('AST-ZZZZZZ', rooms, { roomId: 'b2-210', deviceId: 'PC2' });
  assertEqual(owner, null, 'an id nobody else has should not be reported as a collision');
});

await test('findAssetIdOwner catches a duplicate within the same room', async () => {
  const rooms = [{ roomId: 'b2-210', devices: [
    { id: 'PC1', assetId: 'AST-AAAAAA' },
    { id: 'PC7', assetId: 'AST-ZZZZZZ' },
  ] }];
  const owner = findAssetIdOwner('AST-ZZZZZZ', rooms, { roomId: 'b2-210', deviceId: 'PC1' });
  assertEqual(JSON.stringify(owner), JSON.stringify({ roomId: 'b2-210', deviceId: 'PC7' }), 'PC7 already has this id in the same room');
});

await test('findAssetIdOwner catches a duplicate in a DIFFERENT room — the case most worth catching', async () => {
  const rooms = [
    { roomId: 'b2-210', devices: [{ id: 'PC1', assetId: null }] },
    { roomId: 'annex', devices: [{ id: 'PC7', assetId: 'AST-ZZZZZZ' }] },
  ];
  const owner = findAssetIdOwner('AST-ZZZZZZ', rooms, { roomId: 'b2-210', deviceId: 'PC1' });
  assertEqual(JSON.stringify(owner), JSON.stringify({ roomId: 'annex', deviceId: 'PC7' }), 'a cross-room duplicate (same device-id numbering reused elsewhere) should still be found');
});

await test('findAssetIdOwner never reports a device against its own current value', async () => {
  const rooms = [{ roomId: 'b2-210', devices: [{ id: 'PC1', assetId: 'AST-ZZZZZZ' }] }];
  const owner = findAssetIdOwner('AST-ZZZZZZ', rooms, { roomId: 'b2-210', deviceId: 'PC1' });
  assertEqual(owner, null, 'the device being edited should never collide with its own already-set value');
});

await test('findAssetIdOwner is a no-op for a blank id', async () => {
  const rooms = [{ roomId: 'b2-210', devices: [{ id: 'PC1', assetId: '' }] }];
  const owner = findAssetIdOwner('', rooms, { roomId: 'b2-210', deviceId: 'PC2' });
  assertEqual(owner, null, 'a blank id has nothing to collide with');
});

await test('a duplicate assetId is never blocked at the persistence layer — both devices keep it on save', async () => {
  // This is the "warn, don't block" contract: nothing in schema.js
  // validates assetId against other devices, so a user proceeding past the
  // warning always succeeds — there is no rejection path to bypass.
  const data = normalizeRoomData({
    canvasWidth: 400, canvasHeight: 300, layout: [],
    devices: [
      { id: 'PC1', type: 'pc', top: 10, left: 20, assetId: 'AST-SAME01' },
      { id: 'PC7', type: 'pc', top: 30, left: 40, assetId: 'AST-SAME01' },
    ],
  });
  const saved = JSON.parse(serializeRoomData(data)).devices;
  assertEqual(saved[0].assetId, 'AST-SAME01', 'the first device should keep the id it was given');
  assertEqual(saved[1].assetId, 'AST-SAME01', 'the second device should keep the duplicate id too — proceeding anyway must not be silently reverted');
});

/* ── Report ────────────────────────────────────────────────────────── */

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
