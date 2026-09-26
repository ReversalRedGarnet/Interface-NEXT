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
  extractIndexRoomStems, extractIndexSites, patchIndexHtml, removeFromIndexHtml,
  extractAllRoomsIds, patchExportJs, removeFromExportJs, validateNewRoomId,
} = await import('../js/editor/room-scaffold.js');
const { removeRoomFromCampusData, serializeCampusData } = await import('../js/campus-data.js');
const {
  ROOM_TEMPLATES, ROOM_TEMPLATE_DEFAULT_SIZE, ROOM_TEMPLATE_DEFAULT_COUNT,
  templateNeedsCount, generateTemplateRoomData,
} = await import('../js/editor/room-templates.js');
const { render, clientToSvgPoint } = await import('../js/editor/canvas-renderer.js');
const { createToolController, resizeRect, resizeRectOutline, isAxisAlignedRect4 } = await import('../js/editor/tools.js');
const {
  isCorrectPasscode, isSessionUnlocked, markSessionUnlocked,
  loadPasscodeConfig, recordFailedAttempt, resetFailedAttempts, cooldownRemainingMs,
} = await import('../js/editor/passcode-gate.js');

/** A minimal storage stand-in — same shape as sessionStorage's own
 *  getItem/setItem/removeItem — so the passcode gate's storage-backed
 *  functions can be tested without depending on jsdom's sessionStorage or
 *  any real global state. A fresh instance always models a brand-new
 *  browser session. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
  };
}

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

/* ══════════════════════════════════════════════════════════════════
   2b. Room Type templates — generated starting content for New Room
   ══════════════════════════════════════════════════════════════════ */

/** Every template's output must satisfy the exact same contract a
 *  hand-built room's data does: round-trips through serializeRoomData/
 *  normalizeRoomData without losing or reshaping anything, unique device
 *  ids, numeric top/left, and only recognized layout shape types — the
 *  same "valid schema output" a Blank or manually-edited room already has
 *  to satisfy. */
function assertValidSchema(data, label) {
  const reparsed = JSON.parse(serializeRoomData(data));
  assertEqual(reparsed.status, 'draft', `${label}: expected draft status`);
  assert(Array.isArray(reparsed.layout), `${label}: layout should be an array`);
  assert(Array.isArray(reparsed.devices), `${label}: devices should be an array`);

  const normalized = normalizeRoomData(reparsed);
  assertEqual(normalized.devices.length, reparsed.devices.length, `${label}: normalizeRoomData should not drop a device`);
  assertEqual(normalized.layout.length, reparsed.layout.length, `${label}: normalizeRoomData should not drop a layout shape`);

  const ids = reparsed.devices.map(d => d.id);
  assertEqual(new Set(ids).size, ids.length, `${label}: device ids should all be unique`);
  for (const d of reparsed.devices) {
    assert(typeof d.top === 'number' && typeof d.left === 'number', `${label}: device ${d.id} should have numeric top/left`);
    assert(typeof d.id === 'string' && d.id.length > 0, `${label}: every device needs a non-empty id`);
  }
  for (const shape of reparsed.layout) {
    assert(LAYOUT_SHAPE_TYPES.includes(shape.type), `${label}: unrecognized layout shape type "${shape.type}"`);
  }
  return reparsed;
}

await test('ROOM_TEMPLATES/ROOM_TEMPLATE_DEFAULT_SIZE/ROOM_TEMPLATE_DEFAULT_COUNT agree on the four templates the dialog offers', async () => {
  assertEqual(ROOM_TEMPLATES.join(','), 'blank,computer-lab,office,network-room', 'unexpected template id list/order');
  for (const id of ROOM_TEMPLATES) {
    assert(Object.prototype.hasOwnProperty.call(ROOM_TEMPLATE_DEFAULT_SIZE, id), `${id} is missing a default canvas size`);
  }
  assert(templateNeedsCount('computer-lab'), 'Computer Lab should ask for a device count');
  assert(templateNeedsCount('office'), 'Office should ask for a device count');
  assert(!templateNeedsCount('network-room'), 'Network Room has a fixed device set — no count field');
  assert(!templateNeedsCount('blank'), 'Blank never asks for a device count');
});

await test('generateTemplateRoomData throws for "blank" — the New Room flow calls createBlankRoomData directly for it instead, never through here', async () => {
  let threw = false;
  try { generateTemplateRoomData('blank', 1200, 800); } catch { threw = true; }
  assert(threw, 'generateTemplateRoomData("blank", ...) should throw — there is no blank builder in this module');
});

await test('Blank regression: Room Type "blank" still produces exactly createBlankRoomData\'s own empty output, unaffected by templates existing', async () => {
  const size = ROOM_TEMPLATE_DEFAULT_SIZE.blank;
  const blank = createBlankRoomData(size.width, size.height);
  assertEqual(blank.status, 'draft', 'a blank room should start draft');
  assertEqual(blank.layout.length, 0, 'a blank room should start with no layout shapes');
  assertEqual(blank.devices.length, 0, 'a blank room should start with no devices');
  assertEqual(blank.canvasWidth, size.width, 'canvas width should be exactly what was asked for');
  assertEqual(blank.canvasHeight, size.height, 'canvas height should be exactly what was asked for');
});

await test('Computer Lab: default count, rows of pc devices at the same 120x120 spacing as data/b2-210.json/data/b2-204.json, one staff + one printer', async () => {
  const size = ROOM_TEMPLATE_DEFAULT_SIZE['computer-lab'];
  const data = generateTemplateRoomData('computer-lab', size.width, size.height);
  const reparsed = assertValidSchema(data, 'Computer Lab');

  const pcs = reparsed.devices.filter(d => d.type === 'pc');
  assertEqual(pcs.length, ROOM_TEMPLATE_DEFAULT_COUNT['computer-lab'], 'unexpected default PC count');
  assertEqual(reparsed.devices.filter(d => d.type === 'staff').length, 1, 'expected exactly one staff (teacher) station');
  assertEqual(reparsed.devices.filter(d => d.type === 'printer').length, 1, 'expected exactly one printer');
  assertEqual(reparsed.devices.length, pcs.length + 2, 'unexpected extra devices beyond PCs + staff + printer');

  // Real grid spacing (see js/build-grid.js's b2-210/b2-204 entries): 120
  // apart, both directions, wherever two PCs share a row/column.
  const byRow = new Map();
  for (const pc of pcs) {
    if (!byRow.has(pc.top)) byRow.set(pc.top, []);
    byRow.get(pc.top).push(pc.left);
  }
  const rowTops = [...byRow.keys()].sort((a, b) => a - b);
  for (let i = 1; i < rowTops.length; i++) {
    assertEqual(rowTops[i] - rowTops[i - 1], 120, 'row-to-row spacing should match the real grid rooms\' 120px');
  }
  for (const lefts of byRow.values()) {
    const sorted = [...lefts].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      assertEqual(sorted[i] - sorted[i - 1], 120, 'column-to-column spacing should match the real grid rooms\' 120px');
    }
  }

  const boundaryTypes = reparsed.layout.map(s => s.type);
  assertEqual(boundaryTypes.filter(t => t === 'door').length, 1, 'expected exactly one entrance (door)');
  assertEqual(boundaryTypes.filter(t => t === 'floor').length, 1, 'expected exactly one floor rect');
});

await test('Computer Lab: a custom PC count is honored and still wraps into rows that fit the given width', async () => {
  const data = generateTemplateRoomData('computer-lab', 900, 700, 7);
  const reparsed = assertValidSchema(data, 'Computer Lab (custom count)');
  assertEqual(reparsed.devices.filter(d => d.type === 'pc').length, 7, 'expected exactly 7 PCs');
  const floor = reparsed.layout.find(s => s.type === 'floor');
  for (const d of reparsed.devices.filter(d => d.type === 'pc')) {
    assert(d.left >= floor.x && d.left <= floor.x + floor.width, 'a PC should be placed within the floor bounds horizontally');
    assert(d.top >= floor.y && d.top <= floor.y + floor.height, 'a PC should be placed within the floor bounds vertically');
  }
});

await test('Office: default desk count, that many staff devices (spaced looser than a lab grid) plus one printer and one labeled furniture item', async () => {
  const size = ROOM_TEMPLATE_DEFAULT_SIZE.office;
  const data = generateTemplateRoomData('office', size.width, size.height);
  const reparsed = assertValidSchema(data, 'Office');

  const desks = reparsed.devices.filter(d => d.type === 'staff');
  assertEqual(desks.length, ROOM_TEMPLATE_DEFAULT_COUNT.office, 'unexpected default desk count');
  assert(desks.every(d => typeof d.label === 'string' && d.label.length > 0), 'every desk should carry a label');
  assertEqual(reparsed.devices.filter(d => d.type === 'printer').length, 1, 'expected exactly one printer');
  const furniture = reparsed.devices.filter(d => d.type === 'furniture');
  assertEqual(furniture.length, 1, 'expected exactly one furniture item');
  assertEqual(furniture[0].label, 'Cabinet', 'furniture item should carry a generic label');
  assertEqual(reparsed.devices.length, desks.length + 2, 'unexpected extra devices beyond desks + printer + furniture');
});

await test('Office: a custom desk count is honored', async () => {
  const data = generateTemplateRoomData('office', 900, 600, 3);
  const reparsed = assertValidSchema(data, 'Office (custom count)');
  assertEqual(reparsed.devices.filter(d => d.type === 'staff').length, 3, 'expected exactly 3 desks');
});

await test('Network Room: smaller default canvas, exactly one server/switch/router/ups clustered together, no count field applies', async () => {
  const size = ROOM_TEMPLATE_DEFAULT_SIZE['network-room'];
  assert(size.width < ROOM_TEMPLATE_DEFAULT_SIZE.blank.width, 'Network Room should default smaller than a lab/blank room');
  assert(size.height < ROOM_TEMPLATE_DEFAULT_SIZE.blank.height, 'Network Room should default smaller than a lab/blank room');

  const data = generateTemplateRoomData('network-room', size.width, size.height);
  const reparsed = assertValidSchema(data, 'Network Room');

  for (const type of ['server', 'switch', 'router', 'ups']) {
    assertEqual(reparsed.devices.filter(d => d.type === type).length, 1, `expected exactly one ${type}`);
  }
  assertEqual(reparsed.devices.length, 4, 'expected exactly four devices total');

  // "Clustered together... rather than spread across open floor space" —
  // every device should sit close to every other one.
  for (const a of reparsed.devices) {
    for (const b of reparsed.devices) {
      assert(Math.abs(a.top - b.top) <= 100 && Math.abs(a.left - b.left) <= 100, `${a.id} and ${b.id} should be clustered close together`);
    }
  }
});

await test('every template registers through the exact same createNewRoom()/room-scaffold.js path as Blank does — same four touch-points', async () => {
  const indexHtml = readFile('index.html');
  const exportJs = readFile('js/export.js');
  const registry = {
    dataStems: REAL_ROOMS,
    roomHtmlStems: REAL_ROOMS,
    indexStems: extractIndexRoomStems(indexHtml),
    exportIds: extractAllRoomsIds(exportJs),
  };

  for (const templateId of ['computer-lab', 'office', 'network-room']) {
    const size = ROOM_TEMPLATE_DEFAULT_SIZE[templateId];
    const room = { id: `TPL-${templateId}`, label: `Test ${templateId}`, campus: 'Northgate Site' };
    assertEqual(validateNewRoomId(room.id, registry).length, 0, `fixture id for ${templateId} unexpectedly collided`);

    const roomData = generateTemplateRoomData(templateId, size.width, size.height, ROOM_TEMPLATE_DEFAULT_COUNT[templateId]);
    const dataText = serializeRoomData(roomData);
    const roomHtml = generateRoomHtml({ ...room, dataUrl: dataUrlForId(room.id) });
    const newIndexHtml = patchIndexHtml(indexHtml, room);
    const newExportJs = patchExportJs(exportJs, room);

    const parsedData = JSON.parse(dataText);
    assertEqual(parsedData.status, 'draft', `${templateId}: should register as a draft room, same as Blank`);
    assert(parsedData.devices.length > 0, `${templateId}: expected generated devices, unlike Blank`);

    assert(roomHtml.includes(`id:      '${room.id}'`), `${templateId}: ROOM_META.id mismatch`);
    assert(newIndexHtml.includes(`href="rooms/${roomFileStem(room.id)}.html"`), `${templateId}: index.html link missing`);
    assert(extractAllRoomsIds(newExportJs).includes(room.id), `${templateId}: ALL_ROOMS missing the new id`);
  }
});

/* ══════════════════════════════════════════════════════════════════
   1b. Delete Room — the reverse of createNewRoom()
   ══════════════════════════════════════════════════════════════════ */

await test('removeFromExportJs removes exactly the matching ALL_ROOMS entry and leaves the rest untouched', async () => {
  const original = readFile('js/export.js');
  const before = extractAllRoomsIds(original);
  const removed = removeFromExportJs(original, 'ANNEX');
  const after = extractAllRoomsIds(removed);

  assertEqual(after.length, before.length - 1, 'expected exactly one fewer ALL_ROOMS entry');
  assert(!after.includes('ANNEX'), 'ANNEX should be gone from ALL_ROOMS');
  assert(before.filter(id => id !== 'ANNEX').every((id, i) => after[i] === id), 'the remaining entries were reordered or altered');
});

await test('removeFromExportJs is a no-op for an id that was never there', async () => {
  const original = readFile('js/export.js');
  assertEqual(removeFromExportJs(original, 'DOES-NOT-EXIST'), original, 'removing an absent id should return the source unchanged');
});

await test('removeFromIndexHtml removes only the matching room-link, leaving sibling rooms in the same site untouched', async () => {
  const original = readFile('index.html');
  const updated = removeFromIndexHtml(original, 'B2-210');
  assert(!updated.includes('href="rooms/b2-210.html"'), 'B2-210\'s link should be gone');
  assert(updated.includes('href="rooms/b2-204.html"'), 'B2-204 (same site) should be untouched');
  assert(updated.includes('href="rooms/commons.html"'), 'Commons (same site) should be untouched');
});

await test('removeFromIndexHtml removes the whole site-card when that was its last room', async () => {
  const indexHtml = readFile('index.html');
  const room = { id: 'ZZ-TEMP', label: 'ZZ Temp', campus: 'Solo Test Site' };
  const withRoom = patchIndexHtml(indexHtml, room);
  assert(withRoom.includes('Solo Test Site'), 'fixture setup: the new site card should exist before removal');

  const withoutRoom = removeFromIndexHtml(withRoom, room.id);
  assert(!withoutRoom.includes('href="rooms/zz-temp.html"'), 'the room-link should be gone');
  assert(!withoutRoom.includes('Solo Test Site'), 'a site-card with no rooms left in it should be removed entirely, not left empty');
  assertEqual(withoutRoom, indexHtml, 'removing the only room just added should exactly restore the original index.html');
});

await test('removeFromIndexHtml is a no-op for a room that was never there', async () => {
  const original = readFile('index.html');
  assertEqual(removeFromIndexHtml(original, 'DOES-NOT-EXIST'), original, 'removing an absent room should return index.html unchanged');
});

await test('end-to-end: create then delete a room exactly restores index.html and js/export.js', async () => {
  const indexHtml = readFile('index.html');
  const exportJs = readFile('js/export.js');
  const room = { id: 'B2-221', label: 'B2-221', campus: 'Northgate Site' };

  const createdIndex = patchIndexHtml(indexHtml, room);
  const createdExport = patchExportJs(exportJs, room);
  assert(createdIndex !== indexHtml && createdExport !== exportJs, 'fixture setup: creating should actually change both files');

  const restoredIndex = removeFromIndexHtml(createdIndex, room.id);
  const restoredExport = removeFromExportJs(createdExport, room.id);
  assertEqual(restoredIndex, indexHtml, 'index.html should be byte-for-byte restored after create+delete');
  assertEqual(restoredExport, exportJs, 'js/export.js should be byte-for-byte restored after create+delete');
});

await test('removeRoomFromCampusData unlinks a room from its building/floor and reports which one', async () => {
  const campusData = JSON.parse(readFile('data/campus.json'));
  const { data, removed } = removeRoomFromCampusData(campusData, 'commons');

  assertEqual(removed.length, 1, 'commons should be referenced exactly once in campus.json');
  assertEqual(removed[0].buildingLabel, 'Commons Hall', 'wrong building reported for commons');
  const commonsHall = data.buildings.find(b => b.id === 'commons-hall');
  assert(!commonsHall, 'a building left with no floors after removal should be dropped entirely, not kept empty');
});

await test('removeRoomFromCampusData only removes the matching floor, keeping a building\'s other floors intact', async () => {
  const campusData = JSON.parse(readFile('data/campus.json'));
  const { data, removed } = removeRoomFromCampusData(campusData, 'b2-210');

  assertEqual(removed.length, 1, 'b2-210 should be referenced exactly once');
  const tower = data.buildings.find(b => b.id === 'northgate-tower');
  assert(tower, 'northgate-tower should still exist — it has another floor (b2-204)');
  assertEqual(tower.floors.length, 1, 'only b2-210\'s floor should be removed');
  assertEqual(tower.floors[0].roomId, 'b2-204', 'b2-204 should be the one floor left');
});

await test('removeRoomFromCampusData is a no-op (same data reference) for a room campus.json never referenced', async () => {
  const campusData = JSON.parse(readFile('data/campus.json'));
  const result = removeRoomFromCampusData(campusData, 'gpl'); // an imported draft room, never placed
  assertEqual(result.removed.length, 0, 'gpl was never placed in campus.json');
  assert(result.data === campusData, 'a no-op should return the exact same object, not a needless copy');
});

await test('serializeCampusData round-trips data/campus.json exactly (unedited)', async () => {
  const original = readFile('data/campus.json');
  const roundTripped = serializeCampusData(JSON.parse(original));
  assertEqual(normalizeTrailingNewline(roundTripped), normalizeTrailingNewline(original), 'data/campus.json did not round-trip byte-for-byte');
});

await test('serializeCampusData keeps every OTHER building/floor\'s exact formatting after one is removed — no whole-file reformat', async () => {
  const original = readFile('data/campus.json');
  const { data } = removeRoomFromCampusData(JSON.parse(original), 'commons');
  const rewritten = serializeCampusData(data);

  // northgate-tower and riverside-block never referenced "commons" — their
  // own lines (compact single-line shape/floor objects, matching the
  // file's existing hand-authored style) should appear completely
  // untouched, not expanded/reformatted just because something elsewhere
  // in the same file changed.
  assert(rewritten.includes('"shape": { "x": 380, "y": 60, "width": 200, "height": 340 },'), 'northgate-tower\'s shape line should be untouched');
  assert(rewritten.includes('{ "roomId": "b2-210", "label": "B2-210" },'), 'b2-210\'s floor line should be untouched');
  assert(rewritten.includes('{ "roomId": "annex", "label": "Annex Lab" },'), 'annex\'s floor line should be untouched');
  assert(!rewritten.includes('commons-hall'), 'commons-hall (now empty) should be gone');
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

/* ── Drag-to-resize for every OTHER shape type: rect-kind corner-resize
   (room/wallrect/floor/entrance/counter) and the rect-outline-4 case were
   already covered above via the pure resizeRect/resizeRectOutline
   functions directly — these drive the same resize through the actual
   pointer controller (movePoint) for the two shape kinds that weren't
   exercised that way yet: wall endpoints and a genuinely non-rectangular
   outline's free vertices. `door` is deliberately excluded — unlike every
   other layout shape, it renders no resize handle at all (see
   canvas-renderer.js's renderDoor and the "no per-point resize handles"
   test above it in this file) — a fixed ENTRANCE_WIDTH with no
   per-instance resizing, by design. ── */

await test('dragging a wall endpoint handle resizes it (changes its length/angle) through the actual pointer controller', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = { canvasWidth: 1200, canvasHeight: 800, layout: [{ type: 'wall', x1: 100, y1: 100, x2: 300, y2: 100 }], devices: [] };
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  const state = { data, tool: { type: 'select' }, gridSize: 0, selection: null };
  createToolController(svg, () => state, patch => Object.assign(state, patch));

  const handle = svg.querySelector('[data-kind="shape-point"][data-point="x2y2"]');
  assert(handle, 'expected an x2y2 endpoint handle on the wall');
  const p0 = clientToSvgPoint(svg, 10, 10);
  const p1 = clientToSvgPoint(svg, 60, 40);
  handle.dispatchEvent(pointerEvent('pointerdown', 10, 10));
  svg.dispatchEvent(pointerEvent('pointermove', 60, 40));
  window.dispatchEvent(pointerEvent('pointerup', 60, 40));

  assertEqual(data.layout[0].x1, 100, 'the un-dragged endpoint (x1y1) should stay fixed');
  assertEqual(data.layout[0].y1, 100, 'the un-dragged endpoint (x1y1) should stay fixed');
  assertEqual(data.layout[0].x2, 300 + (p1.x - p0.x), 'the dragged endpoint did not land at the new X');
  assertEqual(data.layout[0].y2, 100 + (p1.y - p0.y), 'the dragged endpoint did not land at the new Y');
});

await test('a wall endpoint resize snaps to the grid, same as placement/move already do', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = { canvasWidth: 1200, canvasHeight: 800, layout: [{ type: 'wall', x1: 100, y1: 100, x2: 300, y2: 100 }], devices: [] };
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  const state = { data, tool: { type: 'select' }, gridSize: 25, selection: null };
  createToolController(svg, () => state, patch => Object.assign(state, patch));

  const handle = svg.querySelector('[data-kind="shape-point"][data-point="x2y2"]');
  const p0 = clientToSvgPoint(svg, 0, 0);
  const p1 = clientToSvgPoint(svg, 1, 1); // an arbitrary small move, snapped against gridSize=25
  handle.dispatchEvent(pointerEvent('pointerdown', 0, 0));
  svg.dispatchEvent(pointerEvent('pointermove', 1, 1));
  window.dispatchEvent(pointerEvent('pointerup', 1, 1));

  assertEqual(data.layout[0].x2, snap(300 + (p1.x - p0.x), 25), 'wall endpoint resize did not snap using state.gridSize');
  assertEqual(data.layout[0].y2, snap(100 + (p1.y - p0.y), 25), 'wall endpoint resize did not snap using state.gridSize');
});

await test('a locked wall\'s endpoint handle does not resize it, same as a locked rect shape\'s corner handle', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = lockedRoomWithWall();
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  const state = { data, tool: { type: 'select' }, gridSize: 0, selection: null };
  let lockedCalls = 0;
  createToolController(svg, () => state, patch => Object.assign(state, patch), () => { lockedCalls++; });

  const before = JSON.stringify(data.layout[0]);
  const handle = svg.querySelector('[data-kind="shape-point"][data-point="x2y2"]');
  handle.dispatchEvent(pointerEvent('pointerdown', 10, 10));
  svg.dispatchEvent(pointerEvent('pointermove', 90, 90));
  window.dispatchEvent(pointerEvent('pointerup', 90, 90));

  assertEqual(JSON.stringify(data.layout[0]), before, 'a locked wall should not have resized via its endpoint handle');
  assertEqual(lockedCalls, 1, 'onLockedAttempt should fire once for the blocked resize');
});

await test('dragging a free (genuinely non-rectangular) outline vertex resizes just that vertex, snapped to the grid', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const sourceOutline = readJson('data/commons.json').layout.find(s => s.type === 'outline');
  assert(!isAxisAlignedRect4(sourceOutline.points), 'fixture assumption: commons\' outline should be a genuine (non-rect-4) polygon');
  const data = {
    canvasWidth: 1200, canvasHeight: 800,
    layout: [{ type: 'outline', points: sourceOutline.points.map(p => [...p]) }],
    devices: [],
  };
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  const state = { data, tool: { type: 'select' }, gridSize: 25, selection: null };
  createToolController(svg, () => state, patch => Object.assign(state, patch));

  const handle = svg.querySelector('[data-kind="shape-point"][data-point="0"]');
  assert(handle, 'expected a per-vertex handle at index 0');
  const otherPointsBefore = data.layout[0].points.slice(1).map(p => [...p]);
  const p0 = clientToSvgPoint(svg, 0, 0);
  const p1 = clientToSvgPoint(svg, 1, 1);
  handle.dispatchEvent(pointerEvent('pointerdown', 0, 0));
  svg.dispatchEvent(pointerEvent('pointermove', 1, 1));
  window.dispatchEvent(pointerEvent('pointerup', 1, 1));

  assertEqual(data.layout[0].points[0][0], snap(sourceOutline.points[0][0] + (p1.x - p0.x), 25), 'dragged vertex did not land at the new (snapped) X');
  assertEqual(data.layout[0].points[0][1], snap(sourceOutline.points[0][1] + (p1.y - p0.y), 25), 'dragged vertex did not land at the new (snapped) Y');
  assertEqual(JSON.stringify(data.layout[0].points.slice(1)), JSON.stringify(otherPointsBefore), 'every other vertex should stay exactly where it was');
});

await test('a locked room\'s outline vertex handle does not resize it', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const outline = createShape('outline', 0, 0);
  const data = { status: 'final', canvasWidth: 1200, canvasHeight: 800, layout: [outline], devices: [] };
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  const state = { data, tool: { type: 'select' }, gridSize: 0, selection: null };
  let lockedCalls = 0;
  createToolController(svg, () => state, patch => Object.assign(state, patch), () => { lockedCalls++; });

  const before = JSON.stringify(data.layout[0]);
  const handle = svg.querySelector('[data-kind="shape-point"][data-point="0"]');
  handle.dispatchEvent(pointerEvent('pointerdown', 10, 10));
  svg.dispatchEvent(pointerEvent('pointermove', 90, 90));
  window.dispatchEvent(pointerEvent('pointerup', 90, 90));

  assertEqual(JSON.stringify(data.layout[0]), before, 'a locked outline should not have resized via a vertex handle');
  assertEqual(lockedCalls, 1, 'onLockedAttempt should fire once for the blocked resize');
});

await test('devices/furniture render no resize handle at all — they stay move-only, unaffected by shape resize', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = {
    canvasWidth: 1200, canvasHeight: 800, layout: [],
    devices: [
      { id: 'PC1', type: 'pc', top: 0, left: 0 },
      { id: 'FURN1', type: 'furniture', top: 0, left: 100, label: 'Cabinet' },
    ],
  };
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });
  assertEqual(svg.querySelectorAll('.ed-device .ed-handle').length, 0, 'no device (including furniture) should render a resize handle');
  assertEqual(svg.querySelectorAll('.ed-device [data-kind="shape-point"]').length, 0, 'no device (including furniture) should have a resize hit-target');
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

/* ── Sticky tool placement ────────────────────────────────────────────
   A placement tool used to disarm back to Select after a single
   placement (tools.js's own onChange patch used to include
   `tool: { type: 'select' }`); it's now sticky — the tool stays whatever
   editor.js's armTool() set it to, so repeated clicks place repeated
   items without re-arming. Toggling off / switching tools / Escape are
   editor.js-level UI behavior (armTool, the Escape handler) — see
   editor-chrome.test.mjs for those; these tests cover tools.js's own
   half: that a successful placement never touches `state.tool` itself. */

await test('an armed add-device tool stays armed after placing — repeated clicks place repeated devices', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = { status: 'draft', canvasWidth: 1200, canvasHeight: 800, layout: [], devices: [] };
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  const state = { data, tool: { type: 'add-device', deviceType: 'pc' }, gridSize: 0, selection: null };
  createToolController(svg, () => state, patch => Object.assign(state, patch), () => {});

  svg.dispatchEvent(pointerEvent('pointerdown', 10, 10));
  svg.dispatchEvent(pointerEvent('pointerdown', 40, 40));
  svg.dispatchEvent(pointerEvent('pointerdown', 70, 70));

  assertEqual(data.devices.length, 3, 'three clicks with a still-armed add-device tool should place three devices');
  assertEqual(state.tool.type, 'add-device', 'the tool should still be armed after multiple placements');
  assertEqual(state.tool.deviceType, 'pc', 'the armed tool\'s own device type should be unchanged');
});

await test('an armed add-shape tool stays armed after placing on a draft room — repeated clicks place repeated shapes', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = { status: 'draft', canvasWidth: 1200, canvasHeight: 800, layout: [], devices: [] };
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  const state = { data, tool: { type: 'add-shape', shapeType: 'wall' }, gridSize: 0, selection: null };
  createToolController(svg, () => state, patch => Object.assign(state, patch), () => {});

  svg.dispatchEvent(pointerEvent('pointerdown', 10, 10));
  svg.dispatchEvent(pointerEvent('pointerdown', 40, 40));

  assertEqual(data.layout.length, 2, 'two clicks with a still-armed add-shape tool should place two shapes');
  assertEqual(state.tool.type, 'add-shape', 'the tool should still be armed after multiple placements');
});

await test('a re-armed add-shape tool on a locked room still refuses every placement attempt under the sticky model, never placing anything', async () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const data = lockedRoomWithWall();
  render(svg, data, { selection: null, gridSize: 0, showGrid: false });

  const state = { data, tool: { type: 'add-shape', shapeType: 'wall' }, gridSize: 0, selection: null };
  let lockedCalls = 0;
  createToolController(svg, () => state, patch => Object.assign(state, patch), () => { lockedCalls++; });

  svg.dispatchEvent(pointerEvent('pointerdown', 50, 50));
  assertEqual(data.layout.length, 1, 'blocked — no shape should have been added');
  assertEqual(state.tool.type, 'select', 'a blocked placement still disarms back to select, same as before sticky placement');

  // Sticky re-arming (as the palette button would do if clicked again)
  // must not let a second attempt slip past the lock either.
  state.tool = { type: 'add-shape', shapeType: 'wall' };
  svg.dispatchEvent(pointerEvent('pointerdown', 90, 90));
  assertEqual(data.layout.length, 1, 'still blocked on a second, re-armed attempt — sticky re-arming does not bypass the lock');
  assertEqual(lockedCalls, 2, 'onLockedAttempt should fire once per blocked attempt');
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

/* ══════════════════════════════════════════════════════════════════
   Passcode gate — locked by default, wrong code rejected, correct code
   unlocks + persists for the session, a fresh session re-locks
   ══════════════════════════════════════════════════════════════════ */

await test('a brand-new session (no unlock flag written yet) is locked', async () => {
  assertEqual(isSessionUnlocked(fakeStorage()), false, 'a fresh session with no stored flag should read as locked');
});

await test('the wrong code is rejected', async () => {
  assertEqual(isCorrectPasscode('0000', '1234'), false, 'an arbitrary wrong code should be rejected');
  assertEqual(isCorrectPasscode('', '1234'), false, 'an empty code should be rejected');
  assertEqual(isCorrectPasscode('123', '1234'), false, 'a partial/near-miss code should be rejected');
  assertEqual(isCorrectPasscode(' 1234', '1234'), false, 'the comparison should not tolerate incidental whitespace either');
});

await test('the correct code is accepted', async () => {
  assertEqual(isCorrectPasscode('1234', '1234'), true, 'a code matching the configured passcode should be accepted');
});

await test('isCorrectPasscode never accepts anything when no passcode is configured', async () => {
  assertEqual(isCorrectPasscode('1234', null), false, 'a null configured passcode (config failed to load) should reject every input');
  assertEqual(isCorrectPasscode('', undefined), false, 'an undefined configured passcode should reject every input, including an empty guess');
});

await test('marking a session unlocked persists for that same storage/session', async () => {
  const storage = fakeStorage();
  assertEqual(isSessionUnlocked(storage), false, 'setup: should start locked');
  markSessionUnlocked(storage);
  assertEqual(isSessionUnlocked(storage), true, 'should read as unlocked immediately after marking it so');
  // A second, independent read of the same storage — mirrors a page
  // reload within the same browser session/tab.
  assertEqual(isSessionUnlocked(storage), true, 'should still read as unlocked on a later check within the same session');
});

await test('a fresh session (a different storage instance) is locked again, even after another session was unlocked', async () => {
  const oldSession = fakeStorage();
  markSessionUnlocked(oldSession);
  assertEqual(isSessionUnlocked(oldSession), true, 'setup: the old session should be unlocked');

  const newSession = fakeStorage(); // a new tab/browser session never shares sessionStorage
  assertEqual(isSessionUnlocked(newSession), false, 'a fresh session should never inherit another session\'s unlock flag');
});

await test('isSessionUnlocked fails locked (not open) if storage access itself throws', async () => {
  const brokenStorage = { getItem() { throw new Error('storage disabled'); } };
  assertEqual(isSessionUnlocked(brokenStorage), false, 'a storage read failure should read as locked, never as unlocked');
});

/* ══════════════════════════════════════════════════════════════════
   Per-deployment passcode config — loaded from js/editor/passcode.config.js
   (gitignored) via an injectable importer, so a missing/malformed file
   never falls back to a default passcode
   ══════════════════════════════════════════════════════════════════ */

await test('loadPasscodeConfig resolves the configured passcode when the module loads correctly', async () => {
  const result = await loadPasscodeConfig(async () => ({ EDITOR_PASSCODE: 'secret-code' }));
  assertEqual(result.ok, true, 'a well-formed config module should resolve ok');
  assertEqual(result.passcode, 'secret-code', 'the resolved passcode should be exactly what the module exported');
});

await test('loadPasscodeConfig fails closed (ok:false) when the config file does not exist', async () => {
  const missingFile = async () => { throw new Error('Cannot find module'); };
  const result = await loadPasscodeConfig(missingFile);
  assertEqual(result.ok, false, 'a missing config file must never be treated as configured');
  assert(result.error instanceof Error, 'the failure should carry the underlying error for diagnostics');
});

await test('loadPasscodeConfig fails closed when the config module exists but has no usable passcode', async () => {
  const noExport = await loadPasscodeConfig(async () => ({}));
  assertEqual(noExport.ok, false, 'a module missing EDITOR_PASSCODE entirely should fail closed');

  const emptyString = await loadPasscodeConfig(async () => ({ EDITOR_PASSCODE: '' }));
  assertEqual(emptyString.ok, false, 'an empty-string passcode should fail closed rather than accept a blank guess');

  const wrongType = await loadPasscodeConfig(async () => ({ EDITOR_PASSCODE: 1234 }));
  assertEqual(wrongType.ok, false, 'a non-string passcode (e.g. a bare number) should fail closed');
});

/* ══════════════════════════════════════════════════════════════════
   Failed-attempt backoff — a mild, sessionStorage-scoped deterrent, not a
   real lockout: 3 consecutive failures before any cooldown, then an
   increasing/capped wait, reset by a successful unlock or a new session
   ══════════════════════════════════════════════════════════════════ */

await test('the first two failures never trigger a cooldown', async () => {
  const storage = fakeStorage();
  const now = 1_000_000;
  recordFailedAttempt(storage, now);
  assertEqual(cooldownRemainingMs(storage, now), 0, 'a single failure should not throttle anything');
  recordFailedAttempt(storage, now);
  assertEqual(cooldownRemainingMs(storage, now), 0, 'a second consecutive failure should still not throttle anything');
});

await test('the 3rd consecutive failure starts a 5s cooldown that counts down and then lapses', async () => {
  const storage = fakeStorage();
  const now = 1_000_000;
  recordFailedAttempt(storage, now);
  recordFailedAttempt(storage, now);
  recordFailedAttempt(storage, now);
  assertEqual(cooldownRemainingMs(storage, now), 5000, 'the 3rd failure should start exactly a 5s cooldown');
  assertEqual(cooldownRemainingMs(storage, now + 4000), 1000, 'the remaining time should count down as the clock advances');
  assertEqual(cooldownRemainingMs(storage, now + 5000), 0, 'the cooldown should be fully lapsed once its full duration has passed');
  assertEqual(cooldownRemainingMs(storage, now + 9000), 0, 'the cooldown should never go negative once well past its duration');
});

await test('cooldowns increase with further consecutive failures, then cap', async () => {
  const storage = fakeStorage();
  const now = 2_000_000;
  for (let i = 0; i < 3; i++) recordFailedAttempt(storage, now);
  assertEqual(cooldownRemainingMs(storage, now), 5000, 'the 3rd failure should be the 5s tier');

  recordFailedAttempt(storage, now); // 4th
  assertEqual(cooldownRemainingMs(storage, now), 15000, 'the 4th failure should step up to the 15s tier');

  recordFailedAttempt(storage, now); // 5th
  assertEqual(cooldownRemainingMs(storage, now), 30000, 'the 5th failure should step up to the 30s tier');

  recordFailedAttempt(storage, now); // 6th
  assertEqual(cooldownRemainingMs(storage, now), 30000, 'a 6th failure should stay capped at 30s, not keep increasing');
});

await test('a successful unlock resets the failure count back to no cooldown', async () => {
  const storage = fakeStorage();
  const now = 3_000_000;
  for (let i = 0; i < 5; i++) recordFailedAttempt(storage, now);
  assert(cooldownRemainingMs(storage, now) > 0, 'setup: a cooldown should be active after 5 failures');

  markSessionUnlocked(storage);
  assertEqual(cooldownRemainingMs(storage, now), 0, 'unlocking should clear any active cooldown immediately');

  recordFailedAttempt(storage, now);
  recordFailedAttempt(storage, now);
  assertEqual(cooldownRemainingMs(storage, now), 0, 'the failure count should have reset to zero, not merely be under threshold by coincidence');
});

await test('resetFailedAttempts on its own also clears an active cooldown', async () => {
  const storage = fakeStorage();
  const now = 4_000_000;
  for (let i = 0; i < 3; i++) recordFailedAttempt(storage, now);
  assert(cooldownRemainingMs(storage, now) > 0, 'setup: a cooldown should be active');
  resetFailedAttempts(storage);
  assertEqual(cooldownRemainingMs(storage, now), 0, 'resetting should clear the cooldown the same way a successful unlock does');
});

await test('a fresh session never inherits another session\'s failure count or cooldown', async () => {
  const oldSession = fakeStorage();
  const now = 5_000_000;
  for (let i = 0; i < 5; i++) recordFailedAttempt(oldSession, now);
  assert(cooldownRemainingMs(oldSession, now) > 0, 'setup: the old session should be under cooldown');

  const newSession = fakeStorage();
  assertEqual(cooldownRemainingMs(newSession, now), 0, 'a new session/tab never shares sessionStorage, so it should start with no cooldown');
});

await test('recordFailedAttempt and cooldownRemainingMs fail toward "no lockout" if storage access throws', async () => {
  const brokenStorage = {
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('storage disabled'); },
    removeItem() { throw new Error('storage disabled'); },
  };
  assertEqual(recordFailedAttempt(brokenStorage, 1000), 0, 'a storage failure while recording should report no count, not throw');
  assertEqual(cooldownRemainingMs(brokenStorage, 1000), 0, 'a storage failure while checking should degrade to "no cooldown", the opposite direction of isSessionUnlocked\'s fail-locked default');
});

/* ── Report ────────────────────────────────────────────────────────── */

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
