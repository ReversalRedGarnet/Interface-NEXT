/**
 * editor.js — wires the editor.html page together: File System Access API
 * plumbing (the only supported way this editor persists changes — it needs
 * a Chromium browser), the room picker, the tool palette, the properties
 * panel, and the new-room flow that writes all four touch-points a new
 * room needs (see room-scaffold.js) only after validateNewRoomId() passes.
 */
import {
  DEVICE_TYPES, PLACEABLE_SHAPE_TYPES, LAYOUT_SHAPES, shapeDisplayName,
  normalizeRoomData, createBlankRoomData, cloneRoomLayoutOnly, serializeRoomData,
  normalizeAssetsData, serializeAssetsData, generateAssetId, registerAssetId,
  findAssetIdOwner, isLayoutLocked,
} from './schema.js';
import { render } from './canvas-renderer.js';
import { createToolController } from './tools.js';
import {
  roomFileStem, dataUrlForId, generateRoomHtml,
  extractIndexRoomStems, extractIndexSites, patchIndexHtml,
  extractAllRoomsIds, patchExportJs,
  validateNewRoomId,
} from './room-scaffold.js';

/* ── DOM refs ─────────────────────────────────────────────────────── */

const $ = id => document.getElementById(id);

const connectBtn = $('btn-connect');
const connectStatus = $('connect-status');
const editorBody = $('editor-body');
const editorFooter = $('editor-footer');
const roomPicker = $('room-picker');
const newRoomBtn = $('btn-new-room');
const roomStatusRow = $('room-status-row');
const roomStatusBadge = $('room-status-badge');
const markFinalBtn = $('btn-mark-final');
const unlockLayoutBtn = $('btn-unlock-layout');
const unlockOverlay = $('unlock-overlay');
const toolsPanel = $('tools-panel');
const deviceToolsEl = $('device-tools');
const shapeToolsEl = $('shape-tools');
const gridSizeInput = $('grid-size');
const showGridInput = $('show-grid');
const propertiesPanel = $('properties-panel');
const propertiesFields = $('properties-fields');
const deleteSelectedBtn = $('btn-delete-selected');
const saveBtn = $('btn-save');
const dirtyIndicator = $('dirty-indicator');
const statusEl = $('editor-status');
const svg = $('editor-canvas');

const newRoomOverlay = $('new-room-overlay');
const newRoomErrors = $('new-room-errors');
const nrId = $('nr-id');
const nrLabel = $('nr-label');
const nrSite = $('nr-site');
const nrSiteList = $('nr-site-list');
const nrCopyFrom = $('nr-copy-from');
const nrWidth = $('nr-width');
const nrHeight = $('nr-height');

/* ── State ────────────────────────────────────────────────────────── */

let rootHandle = null;

const state = {
  mode: null,          // 'existing' | 'new' | null
  roomId: null,
  roomLabel: null,
  roomCampus: null,
  data: null,           // { canvasWidth, canvasHeight, layout, devices }
  selection: null,       // { kind: 'device'|'shape', index }
  tool: { type: 'select' },
  gridSize: 10,
  showGrid: true,
  dirty: false,
  assets: {},          // data/assets.json — project-wide, loaded once on connect
  assetsDirty: false,
  assetIdWarning: null, // { deviceIndex, message } | null — set by an in-flight/finished project-wide collision check
};

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('editor-status-error', isError);
}

/* ── File System Access helpers ──────────────────────────────────── */

async function hasEntry(dir, name, kind) {
  try {
    if (kind === 'directory') await dir.getDirectoryHandle(name);
    else await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function readTextFile(dirHandle, name) {
  const fh = await dirHandle.getFileHandle(name);
  const file = await fh.getFile();
  return file.text();
}

async function writeTextFile(dirHandle, name, text, { create = false } = {}) {
  const fh = await dirHandle.getFileHandle(name, { create });
  const writable = await fh.createWritable();
  await writable.write(text);
  await writable.close();
}

async function listFileNames(dirHandle) {
  const names = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file') names.push(name);
  }
  return names;
}

/** Everything needed to validate a new room id and populate pickers,
 *  re-read fresh each time so a stale snapshot never gates a write. */
async function gatherRegistry() {
  const dataDir = await rootHandle.getDirectoryHandle('data');
  const roomsDir = await rootHandle.getDirectoryHandle('rooms');
  const jsDir = await rootHandle.getDirectoryHandle('js');

  const [dataFiles, roomFiles, indexHtml, exportJs] = await Promise.all([
    listFileNames(dataDir),
    listFileNames(roomsDir),
    readTextFile(rootHandle, 'index.html'),
    readTextFile(jsDir, 'export.js'),
  ]);

  return {
    dataStems: dataFiles.filter(n => n.endsWith('.json')).map(n => n.replace(/\.json$/i, '').toLowerCase()),
    roomHtmlStems: roomFiles.filter(n => n.endsWith('.html')).map(n => n.replace(/\.html$/i, '').toLowerCase()),
    indexStems: extractIndexRoomStems(indexHtml),
    exportIds: extractAllRoomsIds(exportJs),
    sites: extractIndexSites(indexHtml),
    indexHtml,
    exportJs,
  };
}

/** ALL_ROOMS entries as { id, label, campus } triples, for the room picker. */
function parseAllRoomsEntries(exportJsSource) {
  const re = /\{\s*id:\s*'([^']*)',\s*label:\s*'([^']*)',\s*campus:\s*'([^']*)'\s*\}/g;
  return [...exportJsSource.matchAll(re)].map(m => ({ id: m[1], label: m[2], campus: m[3] }));
}

/* ── Connect ──────────────────────────────────────────────────────── */

async function connect() {
  if (!window.showDirectoryPicker) {
    setStatus('This editor needs a Chromium-based browser (Chrome or Edge) with the File System Access API — it\'s how the editor reads and writes project files directly.', true);
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'interface-next-root', mode: 'readwrite' });
  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus(`Couldn't open the folder: ${err.message}`, true);
    return;
  }

  const looksRight = await hasEntry(handle, 'data', 'directory')
    && await hasEntry(handle, 'rooms', 'directory')
    && await hasEntry(handle, 'js', 'directory')
    && await hasEntry(handle, 'index.html', 'file');

  if (!looksRight) {
    setStatus('That folder doesn\'t look like the Interface-NEXT project root (expected data/, rooms/, js/, and index.html inside it).', true);
    return;
  }

  rootHandle = handle;
  connectStatus.textContent = `Connected: ${rootHandle.name}`;
  editorBody.hidden = false;
  setStatus('');
  await loadAssetsRegistry();
  await refreshRoomPicker();
}

/** data/assets.json is project-wide (not per-room), so it's loaded once
 *  here rather than alongside each room. Missing/unreadable → starts blank;
 *  it's created on the first save that registers an asset id. */
async function loadAssetsRegistry() {
  try {
    const dataDir = await rootHandle.getDirectoryHandle('data');
    const text = await readTextFile(dataDir, 'assets.json');
    state.assets = normalizeAssetsData(JSON.parse(text));
  } catch {
    state.assets = {};
  }
  state.assetsDirty = false;
}

async function refreshRoomPicker() {
  const registry = await gatherRegistry();
  const entries = parseAllRoomsEntries(registry.exportJs);
  roomPicker.innerHTML = '<option value="">— choose —</option>';
  for (const entry of entries) {
    const opt = document.createElement('option');
    opt.value = entry.id;
    opt.textContent = `${entry.label} (${entry.campus})`;
    opt.dataset.label = entry.label;
    opt.dataset.campus = entry.campus;
    roomPicker.appendChild(opt);
  }
}

/* ── Project-wide assetId collision check ─────────────────────────── */

/** Reads every OTHER room's devices from disk. The current room's own
 *  (possibly-unsaved) devices are supplied by the caller from memory
 *  instead — re-reading its own file here could show a stale copy mid-edit. */
async function readOtherRoomsDevices(excludeStem) {
  const dataDir = await rootHandle.getDirectoryHandle('data');
  const names = await listFileNames(dataDir);
  const rooms = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const stem = name.replace(/\.json$/i, '');
    if (stem.toLowerCase() === 'assets') continue; // the lookup file, not a room
    if (stem.toLowerCase() === excludeStem.toLowerCase()) continue;
    try {
      const parsed = JSON.parse(await readTextFile(dataDir, name));
      rooms.push({ roomId: stem, devices: Array.isArray(parsed?.devices) ? parsed.devices : [] });
    } catch {
      // unreadable/corrupt file — skip it rather than fail the whole check
    }
  }
  return rooms;
}

/** Fires after typing/generating an assetId; advisory only — never blocks
 *  or reverts the value, just surfaces who else already has it (if anyone),
 *  anywhere in the project. Guards against a slow check finishing after the
 *  user has since selected something else. */
async function runAssetIdCheck(assetId, deviceIndex, deviceId) {
  if (!assetId || !rootHandle || state.mode !== 'existing') return;
  const currentStem = roomFileStem(state.roomId);
  let owner;
  try {
    const otherRooms = await readOtherRoomsDevices(currentStem);
    const rooms = [{ roomId: currentStem, devices: state.data.devices }, ...otherRooms];
    owner = findAssetIdOwner(assetId, rooms, { roomId: currentStem, deviceId });
  } catch {
    return; // advisory feature — a failed scan should never disrupt editing
  }
  if (state.selection?.kind !== 'device' || state.selection.index !== deviceIndex) return; // moved on already
  if (!owner) return; // state.assetIdWarning was already cleared when the check was kicked off
  const message = owner.roomId === currentStem
    ? `${owner.deviceId} already uses this ID.`
    : `${owner.deviceId} in ${owner.roomId} already uses this ID.`;
  state.assetIdWarning = { deviceIndex, message };
  renderProperties();
}

/** Reads and normalizes data/{stem}.json for `id` — shared by loadRoom and
 *  the New Room "copy layout from" option. Throws on read/parse failure;
 *  callers decide how to surface that. */
async function readRoomData(id) {
  const dataDir = await rootHandle.getDirectoryHandle('data');
  const text = await readTextFile(dataDir, `${roomFileStem(id)}.json`);
  return normalizeRoomData(JSON.parse(text));
}

/* ── Loading / saving an existing room ───────────────────────────── */

async function loadRoom(id, label, campus) {
  const stem = roomFileStem(id);
  const dataDir = await rootHandle.getDirectoryHandle('data');
  let text;
  try {
    text = await readTextFile(dataDir, `${stem}.json`);
  } catch (err) {
    setStatus(`Couldn't read data/${stem}.json: ${err.message}`, true);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    setStatus(`data/${stem}.json isn't valid JSON: ${err.message}`, true);
    return;
  }

  state.mode = 'existing';
  state.roomId = id;
  state.roomLabel = label;
  state.roomCampus = campus;
  state.data = normalizeRoomData(parsed);
  state.selection = null;
  state.tool = { type: 'select' };
  state.dirty = false;

  toolsPanel.hidden = false;
  editorFooter.hidden = false;
  setStatus(`Loaded data/${stem}.json`);
  renderAll();
}

async function saveExistingRoom() {
  if (state.mode !== 'existing') return;
  const stem = roomFileStem(state.roomId);
  try {
    const dataDir = await rootHandle.getDirectoryHandle('data');
    await writeTextFile(dataDir, `${stem}.json`, serializeRoomData(state.data));

    const savedAssets = state.assetsDirty;
    if (savedAssets) {
      await writeTextFile(dataDir, 'assets.json', serializeAssetsData(state.assets), { create: true });
      state.assetsDirty = false;
    }

    state.dirty = false;
    updateDirtyUI();
    setStatus(`Saved data/${stem}.json${savedAssets ? ' and data/assets.json' : ''}`);
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, true);
  }
}

/* ── New room flow ────────────────────────────────────────────────── */

async function openNewRoomDialog() {
  const registry = await gatherRegistry();
  nrSiteList.innerHTML = '';
  for (const site of registry.sites) {
    const opt = document.createElement('option');
    opt.value = site;
    nrSiteList.appendChild(opt);
  }
  nrCopyFrom.innerHTML = '<option value="">— start blank —</option>';
  for (const entry of parseAllRoomsEntries(registry.exportJs)) {
    const opt = document.createElement('option');
    opt.value = entry.id;
    opt.textContent = `${entry.label} (${entry.campus})`;
    nrCopyFrom.appendChild(opt);
  }
  nrId.value = '';
  nrLabel.value = '';
  nrSite.value = '';
  nrWidth.value = 1200;
  nrHeight.value = 800;
  nrWidth.disabled = false;
  nrHeight.disabled = false;
  newRoomErrors.textContent = '';
  newRoomOverlay.classList.add('open');
  nrId.focus();
}

/** Picking a source room locks the canvas-size fields to its own
 *  canvasWidth/canvasHeight — copied wall/boundary coordinates are only
 *  meaningful against the canvas they were placed on, so letting the size
 *  fields drift from the source would silently misplace everything. */
async function onCopyFromChange() {
  const sourceId = nrCopyFrom.value;
  if (!sourceId) {
    nrWidth.disabled = false;
    nrHeight.disabled = false;
    return;
  }
  try {
    const source = await readRoomData(sourceId);
    nrWidth.value = source.canvasWidth;
    nrHeight.value = source.canvasHeight;
    nrWidth.disabled = true;
    nrHeight.disabled = true;
  } catch (err) {
    newRoomErrors.textContent = `Couldn't read the layout to copy from: ${err.message}`;
    nrCopyFrom.value = '';
    nrWidth.disabled = false;
    nrHeight.disabled = false;
  }
}

function closeNewRoomDialog() {
  newRoomOverlay.classList.remove('open');
}

async function writeNewRoomFiles({ id, label, campus, roomData }, registry) {
  const stem = roomFileStem(id);
  const dataText = serializeRoomData(roomData);
  const roomHtml = generateRoomHtml({ id, label, campus, dataUrl: dataUrlForId(id) });
  const newIndexHtml = patchIndexHtml(registry.indexHtml, { id, label, campus });
  const newExportJs = patchExportJs(registry.exportJs, { id, label, campus });

  const written = [];
  try {
    const dataDir = await rootHandle.getDirectoryHandle('data');
    await writeTextFile(dataDir, `${stem}.json`, dataText, { create: true });
    written.push(`data/${stem}.json`);

    const roomsDir = await rootHandle.getDirectoryHandle('rooms');
    await writeTextFile(roomsDir, `${stem}.html`, roomHtml, { create: true });
    written.push(`rooms/${stem}.html`);

    await writeTextFile(rootHandle, 'index.html', newIndexHtml);
    written.push('index.html');

    const jsDir = await rootHandle.getDirectoryHandle('js');
    await writeTextFile(jsDir, 'export.js', newExportJs);
    written.push('js/export.js');
  } catch (err) {
    const done = written.length ? written.join(', ') : 'nothing';
    throw new Error(
      `Wrote ${done} before hitting an error on the next file (${err.message}). ` +
      'The remaining touch-points need to be finished by hand, or re-run once the problem is fixed.',
    );
  }
}

async function createNewRoom() {
  const id = nrId.value.trim();
  const label = nrLabel.value.trim() || id;
  const campus = nrSite.value.trim();
  const canvasWidth = Number(nrWidth.value) || 1200;
  const canvasHeight = Number(nrHeight.value) || 800;
  const copyFromId = nrCopyFrom.value;

  const problems = [];
  if (!campus) problems.push('Site is required.');

  const registry = await gatherRegistry();
  problems.push(...validateNewRoomId(id, registry));

  if (problems.length) {
    newRoomErrors.textContent = problems.join(' ');
    return;
  }

  let roomData;
  if (copyFromId) {
    try {
      roomData = cloneRoomLayoutOnly(await readRoomData(copyFromId));
    } catch (err) {
      newRoomErrors.textContent = `Couldn't read the layout to copy from: ${err.message}`;
      return;
    }
  } else {
    roomData = createBlankRoomData(canvasWidth, canvasHeight);
  }

  try {
    await writeNewRoomFiles({ id, label, campus, roomData }, registry);
    closeNewRoomDialog();
    await refreshRoomPicker();

    state.mode = 'existing'; // it's a real room on disk now — edits save the same way
    state.roomId = id;
    state.roomLabel = label;
    state.roomCampus = campus;
    state.data = roomData;
    state.selection = null;
    state.tool = { type: 'select' };
    state.dirty = false;
    roomPicker.value = id;
    toolsPanel.hidden = false;
    editorFooter.hidden = false;
    setStatus(`Created ${id}: data/${roomFileStem(id)}.json, rooms/${roomFileStem(id)}.html, index.html, and js/export.js.`);
    renderAll();
  } catch (err) {
    newRoomErrors.textContent = err.message;
  }
}

/* ── Rendering ────────────────────────────────────────────────────── */

function renderAll() {
  if (!state.data) return;
  const locked = isLayoutLocked(state.data);
  render(svg, state.data, { selection: state.selection, gridSize: state.gridSize, showGrid: showGridInput.checked, locked });
  renderProperties();
  renderRoomStatus();
  updatePaletteLockState(locked);
  updateDirtyUI();
}

/* ── Room status: draft/final badge + Mark as Final / Unlock Layout ──
   "Final" locks the room's LAYOUT (layout[] — walls/doors/entrance/
   boundary) against further edits; devices/furniture (devices[]) stay
   freely editable either way — see schema.js's ROOM_STATUSES comment.
   Unlocking requires an explicit confirmation (see unlockOverlay below)
   since it re-opens something a checker may already be relying on staying
   put; marking final doesn't, since it's the safe direction (it only ever
   restricts, never loses data). */

function renderRoomStatus() {
  const has = !!state.data;
  roomStatusRow.hidden = !has;
  if (!has) return;
  const locked = isLayoutLocked(state.data);
  roomStatusBadge.textContent = locked ? 'Final' : 'Draft';
  roomStatusBadge.className = `summary-pill ${locked ? 'working' : 'unchecked'}`;
  markFinalBtn.hidden = locked;
  unlockLayoutBtn.hidden = !locked;
}

function markAsFinal() {
  if (!state.data || isLayoutLocked(state.data)) return;
  state.data.status = 'final';
  state.dirty = true;
  setStatus('Marked Final — the layout (walls/doors/entrance/boundary) is now locked. Devices stay editable.');
  renderAll();
}

function openUnlockConfirm() {
  if (!state.data || !isLayoutLocked(state.data)) return;
  unlockOverlay.classList.add('open');
}
function closeUnlockConfirm() {
  unlockOverlay.classList.remove('open');
}
function confirmUnlock() {
  state.data.status = 'draft';
  state.dirty = true;
  closeUnlockConfirm();
  setStatus('Layout unlocked — walls, doors, entrance, and the room boundary are editable again.');
  renderAll();
}

/* ── Locked-layout feedback (onLockedAttempt from tools.js) ──
   Fires whenever placing/dragging/resizing a layout shape is blocked
   because the room is final — never silent, per the spec. */
function onLockedAttempt() {
  setStatus('Layout is locked — Unlock Layout (in the Room panel) to edit walls, doors, the entrance, or the room boundary. Devices are still editable.', true);
}

/** Shape-placement tools only — device tools stay enabled regardless of
 *  lock status, so disabling has to target shapeToolsEl specifically. */
function updatePaletteLockState(locked) {
  shapeToolsEl.querySelectorAll('.editor-tool-btn').forEach(btn => {
    btn.disabled = locked;
    btn.title = locked ? 'Layout is locked — Unlock Layout to place walls/shapes.' : '';
  });
  if (locked && state.tool?.type === 'add-shape') state.tool = { type: 'select' };
}

function updateDirtyUI() {
  dirtyIndicator.textContent = state.dirty ? 'Unsaved changes' : 'Saved';
  dirtyIndicator.classList.toggle('editor-dirty-active', state.dirty);
  saveBtn.disabled = !state.dirty;
}

/* ── Properties panel ─────────────────────────────────────────────── */

function field(labelText, inputEl) {
  const wrap = document.createElement('label');
  wrap.className = 'editor-field';
  const span = document.createElement('span');
  span.textContent = labelText;
  wrap.appendChild(span);
  wrap.appendChild(inputEl);
  return wrap;
}

function numberInput(value, onCommit) {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = 'any';
  input.value = value ?? 0;
  input.addEventListener('change', () => onCommit(Number(input.value) || 0));
  return input;
}

function textInput(value, onCommit) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value ?? '';
  input.addEventListener('change', () => onCommit(input.value));
  return input;
}

/** Free text with autocomplete suggestions, not a locked enum — `type` is
 *  any string; DEVICE_TYPES/`listId` just seeds the dropdown with common
 *  examples so pc/staff/printer (the three room.js renders specially)
 *  stay one click away without forcing every device into that set. */
function autocompleteInput(value, listId, onCommit) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value ?? '';
  input.setAttribute('list', listId);
  input.addEventListener('change', () => onCommit(input.value.trim()));
  return input;
}

function markDirtyRerender() {
  state.dirty = true;
  renderAll();
}

/** Adds `assetId` to state.assets with a blank record if it isn't already
 *  a known key — never overwrites an existing record. Marks assets.json
 *  dirty only when it actually added something. */
function registerNewAsset(assetId) {
  const { assets, added } = registerAssetId(state.assets, assetId);
  if (added) {
    state.assets = assets;
    state.assetsDirty = true;
  }
}

function assetIdField(device, index) {
  const wrap = document.createElement('label');
  wrap.className = 'editor-field';
  const span = document.createElement('span');
  span.textContent = 'Asset ID (optional)';
  wrap.appendChild(span);

  const row = document.createElement('div');
  row.className = 'editor-assetid-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = device.assetId || '';
  input.placeholder = 'e.g. AST-4K9QXZ';

  function setAssetId(v) {
    if (v) { device.assetId = v; registerNewAsset(v); } else delete device.assetId;
    state.assetIdWarning = null; // clear any stale result before re-checking
    markDirtyRerender();
    if (v) runAssetIdCheck(v, index, device.id);
  }

  input.addEventListener('change', () => setAssetId(input.value.trim()));

  const genBtn = document.createElement('button');
  genBtn.type = 'button';
  genBtn.className = 'editor-btn-inline';
  genBtn.textContent = 'Generate';
  genBtn.title = 'Fill in an auto-generated, unused asset id';
  genBtn.addEventListener('click', () => {
    const id = generateAssetId(state.assets);
    input.value = id;
    setAssetId(id);
  });

  row.appendChild(input);
  row.appendChild(genBtn);
  wrap.appendChild(row);

  // Non-blocking — informational only, and never reverts the value; see
  // runAssetIdCheck. Persisted in state (not a local closure) so it
  // survives renderProperties() rebuilding this field from scratch.
  const warning = document.createElement('p');
  warning.className = 'editor-field-warning';
  const current = state.assetIdWarning;
  if (current && current.deviceIndex === index) {
    warning.textContent = current.message;
  } else {
    warning.hidden = true;
  }
  wrap.appendChild(warning);

  return wrap;
}

/** A locked shape's geometry as plain read-only text rows — same field()
 *  layout the editable version uses, just no input to type into, so a
 *  locked shape's properties panel still shows exactly what it always did,
 *  it just can't be changed from here. */
function readOnlyField(labelText, value) {
  const p = document.createElement('p');
  p.textContent = String(value);
  return field(labelText, p);
}

function renderProperties() {
  const has = !!state.selection;
  propertiesPanel.hidden = !has;
  propertiesFields.innerHTML = '';
  if (!has) { deleteSelectedBtn.hidden = true; return; }

  const { kind, index } = state.selection;
  const shapeLocked = kind === 'shape' && isLayoutLocked(state.data);
  deleteSelectedBtn.hidden = shapeLocked;

  if (kind === 'device') {
    const device = state.data.devices[index];
    if (!device) { state.selection = null; return; }
    propertiesFields.appendChild(field('Id', textInput(device.id, v => { device.id = v; markDirtyRerender(); })));
    propertiesFields.appendChild(field('Type', autocompleteInput(device.type, 'device-type-list', v => { if (v) { device.type = v; markDirtyRerender(); } })));
    propertiesFields.appendChild(field('Top', numberInput(device.top, v => { device.top = v; markDirtyRerender(); })));
    propertiesFields.appendChild(field('Left', numberInput(device.left, v => { device.left = v; markDirtyRerender(); })));
    propertiesFields.appendChild(field('Label (optional)', textInput(device.label || '', v => {
      if (v) device.label = v; else delete device.label;
      markDirtyRerender();
    })));
    propertiesFields.appendChild(assetIdField(device, index));
    return;
  }

  const shape = state.data.layout[index];
  if (!shape) { state.selection = null; return; }
  const spec = LAYOUT_SHAPES[shape.type];

  const typeLabel = document.createElement('p');
  typeLabel.className = 'editor-shape-type';
  typeLabel.textContent = shapeDisplayName(shape.type);
  propertiesFields.appendChild(typeLabel);

  if (shapeLocked) {
    const notice = document.createElement('p');
    notice.className = 'editor-hint editor-locked-notice';
    notice.textContent = 'Layout is locked — Unlock Layout (in the Room panel) to edit this.';
    propertiesFields.appendChild(notice);
    if (spec?.kind === 'rect') {
      for (const f of ['x', 'y', 'width', 'height']) propertiesFields.appendChild(readOnlyField(f, shape[f]));
    } else if (spec?.kind === 'line') {
      for (const f of ['x1', 'y1', 'x2', 'y2']) propertiesFields.appendChild(readOnlyField(f, shape[f]));
    } else if (spec?.kind === 'hinge') {
      propertiesFields.appendChild(readOnlyField('hinge', shape.hinge.join(', ')));
      propertiesFields.appendChild(readOnlyField('jamb', shape.jamb.join(', ')));
    } else if (spec?.kind === 'polygon') {
      propertiesFields.appendChild(readOnlyField('points', shape.points.map(p => p.join(',')).join(' / ')));
    }
    if (spec?.label) propertiesFields.appendChild(readOnlyField('label', shape.label || ''));
    return;
  }

  if (spec?.kind === 'rect') {
    for (const f of ['x', 'y', 'width', 'height']) {
      propertiesFields.appendChild(field(f, numberInput(shape[f], v => { shape[f] = v; markDirtyRerender(); })));
    }
  } else if (spec?.kind === 'line') {
    for (const f of ['x1', 'y1', 'x2', 'y2']) {
      propertiesFields.appendChild(field(f, numberInput(shape[f], v => { shape[f] = v; markDirtyRerender(); })));
    }
  } else if (spec?.kind === 'hinge') {
    // Fixed standard width, no per-instance size fields — drag (or
    // click-then-click) to reposition it as a whole.
    const note = document.createElement('p');
    note.className = 'editor-hint';
    note.textContent = 'Standard-width entrance — drag to reposition, no resizing.';
    propertiesFields.appendChild(note);
  } else if (spec?.kind === 'polygon') {
    const textarea = document.createElement('textarea');
    textarea.rows = Math.min(8, shape.points.length + 1);
    textarea.value = shape.points.map(p => p.join(',')).join('\n');
    textarea.addEventListener('change', () => {
      const points = textarea.value.split('\n').map(l => l.trim()).filter(Boolean)
        .map(l => l.split(',').map(n => Number(n.trim())));
      if (points.every(p => p.length === 2 && p.every(Number.isFinite))) {
        shape.points = points;
        markDirtyRerender();
      }
    });
    propertiesFields.appendChild(field('Points (x,y per line)', textarea));
  }

  if (spec?.label) {
    propertiesFields.appendChild(field('Label', textInput(shape.label || '', v => { shape.label = v; markDirtyRerender(); })));
  }
}

function deleteSelected() {
  if (!state.selection) return;
  const { kind, index } = state.selection;
  if (kind === 'device') {
    state.data.devices.splice(index, 1);
  } else {
    if (isLayoutLocked(state.data)) { onLockedAttempt(); return; }
    state.data.layout.splice(index, 1);
  }
  state.selection = null;
  markDirtyRerender();
}

/* ── Tool palette ─────────────────────────────────────────────────── */

function armTool(tool, btn) {
  const alreadyArmed = state.tool.type === tool.type
    && state.tool.deviceType === tool.deviceType
    && state.tool.shapeType === tool.shapeType;
  state.tool = alreadyArmed ? { type: 'select' } : tool;
  // Clear across both palettes, not just the clicked button's own group —
  // otherwise arming a device tool leaves a previously-armed shape button
  // (or vice versa) looking active while it no longer is.
  document.querySelectorAll('.editor-tool-btn.armed').forEach(b => b.classList.remove('armed'));
  if (!alreadyArmed) btn.classList.add('armed');
}

function buildDeviceTypeList() {
  const list = $('device-type-list');
  DEVICE_TYPES.forEach(type => {
    const opt = document.createElement('option');
    opt.value = type;
    list.appendChild(opt);
  });
}

function buildPalette() {
  DEVICE_TYPES.forEach(type => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toolbar-btn editor-tool-btn';
    btn.textContent = type;
    btn.addEventListener('click', () => armTool({ type: 'add-device', deviceType: type }, btn));
    deviceToolsEl.appendChild(btn);
  });

  PLACEABLE_SHAPE_TYPES.forEach(type => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toolbar-btn editor-tool-btn';
    btn.textContent = shapeDisplayName(type);
    btn.addEventListener('click', () => armTool({ type: 'add-shape', shapeType: type }, btn));
    shapeToolsEl.appendChild(btn);
  });
}

/* ── Wiring ───────────────────────────────────────────────────────── */

createToolController(svg, () => state, patch => {
  Object.assign(state, patch);
  renderAll();
}, onLockedAttempt);

connectBtn.addEventListener('click', connect);

roomPicker.addEventListener('change', () => {
  const opt = roomPicker.selectedOptions[0];
  if (!opt || !opt.value) return;
  loadRoom(opt.value, opt.dataset.label, opt.dataset.campus);
});

newRoomBtn.addEventListener('click', () => { if (rootHandle) openNewRoomDialog(); });
nrCopyFrom.addEventListener('change', onCopyFromChange);
$('new-room-close').addEventListener('click', closeNewRoomDialog);
$('new-room-cancel').addEventListener('click', closeNewRoomDialog);
$('new-room-create').addEventListener('click', createNewRoom);
newRoomOverlay.addEventListener('click', e => { if (e.target === newRoomOverlay) closeNewRoomDialog(); });

deleteSelectedBtn.addEventListener('click', deleteSelected);
saveBtn.addEventListener('click', saveExistingRoom);

markFinalBtn.addEventListener('click', markAsFinal);
unlockLayoutBtn.addEventListener('click', openUnlockConfirm);
$('unlock-confirm').addEventListener('click', confirmUnlock);
$('unlock-cancel').addEventListener('click', closeUnlockConfirm);
unlockOverlay.addEventListener('click', e => { if (e.target === unlockOverlay) closeUnlockConfirm(); });

gridSizeInput.addEventListener('input', () => {
  state.gridSize = Number(gridSizeInput.value) || 0;
  renderAll();
});
showGridInput.addEventListener('change', renderAll);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (newRoomOverlay.classList.contains('open')) { closeNewRoomDialog(); return; }
    if (unlockOverlay.classList.contains('open')) { closeUnlockConfirm(); return; }
    state.tool = { type: 'select' };
    document.querySelectorAll('.editor-tool-btn.armed').forEach(b => b.classList.remove('armed'));
  }
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (e.key === 'Delete' && state.selection && !typing) {
    deleteSelected();
  }
});

window.addEventListener('beforeunload', e => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

buildPalette();
buildDeviceTypeList();
