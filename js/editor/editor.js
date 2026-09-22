/**
 * editor.js — wires the editor.html page together: File System Access API
 * plumbing (the only supported way this editor persists changes — it needs
 * a Chromium browser), the room picker, the tool palette, the properties
 * panel, and the new-room flow that writes all four touch-points a new
 * room needs (see room-scaffold.js) only after validateNewRoomId() passes.
 */
import {
  DEVICE_TYPES, PLACEABLE_SHAPE_TYPES, LAYOUT_SHAPES, shapeDisplayName,
  normalizeRoomData, createBlankRoomData, serializeRoomData,
} from './schema.js';
import { render } from './canvas-renderer.js';
import { createToolController } from './tools.js';
import {
  roomFileStem, dataUrlForId, generateRoomHtml,
  extractIndexRoomStems, extractIndexCampuses, patchIndexHtml,
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
const nrCampus = $('nr-campus');
const nrCampusList = $('nr-campus-list');
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
    campuses: extractIndexCampuses(indexHtml),
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
  await refreshRoomPicker();
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
    state.dirty = false;
    updateDirtyUI();
    setStatus(`Saved data/${stem}.json`);
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, true);
  }
}

/* ── New room flow ────────────────────────────────────────────────── */

async function openNewRoomDialog() {
  const registry = await gatherRegistry();
  nrCampusList.innerHTML = '';
  for (const campus of registry.campuses) {
    const opt = document.createElement('option');
    opt.value = campus;
    nrCampusList.appendChild(opt);
  }
  nrId.value = '';
  nrLabel.value = '';
  nrCampus.value = '';
  nrWidth.value = 1200;
  nrHeight.value = 800;
  newRoomErrors.textContent = '';
  newRoomOverlay.classList.add('open');
  nrId.focus();
}

function closeNewRoomDialog() {
  newRoomOverlay.classList.remove('open');
}

async function writeNewRoomFiles({ id, label, campus, canvasWidth, canvasHeight }, registry) {
  const stem = roomFileStem(id);
  const roomData = createBlankRoomData(canvasWidth, canvasHeight);
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

  return roomData;
}

async function createNewRoom() {
  const id = nrId.value.trim();
  const label = nrLabel.value.trim() || id;
  const campus = nrCampus.value.trim();
  const canvasWidth = Number(nrWidth.value) || 1200;
  const canvasHeight = Number(nrHeight.value) || 800;

  const problems = [];
  if (!campus) problems.push('Campus is required.');

  const registry = await gatherRegistry();
  problems.push(...validateNewRoomId(id, registry));

  if (problems.length) {
    newRoomErrors.textContent = problems.join(' ');
    return;
  }

  try {
    const roomData = await writeNewRoomFiles({ id, label, campus, canvasWidth, canvasHeight }, registry);
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
  render(svg, state.data, { selection: state.selection, gridSize: state.gridSize, showGrid: showGridInput.checked });
  renderProperties();
  updateDirtyUI();
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

function selectInput(options, value, onCommit) {
  const select = document.createElement('select');
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    if (opt === value) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener('change', () => onCommit(select.value));
  return select;
}

function markDirtyRerender() {
  state.dirty = true;
  renderAll();
}

function renderProperties() {
  const has = !!state.selection;
  propertiesPanel.hidden = !has;
  deleteSelectedBtn.hidden = !has;
  propertiesFields.innerHTML = '';
  if (!has) return;

  const { kind, index } = state.selection;

  if (kind === 'device') {
    const device = state.data.devices[index];
    if (!device) { state.selection = null; return; }
    propertiesFields.appendChild(field('Id', textInput(device.id, v => { device.id = v; markDirtyRerender(); })));
    propertiesFields.appendChild(field('Type', selectInput(DEVICE_TYPES, device.type, v => { device.type = v; markDirtyRerender(); })));
    propertiesFields.appendChild(field('Top', numberInput(device.top, v => { device.top = v; markDirtyRerender(); })));
    propertiesFields.appendChild(field('Left', numberInput(device.left, v => { device.left = v; markDirtyRerender(); })));
    propertiesFields.appendChild(field('Label (optional)', textInput(device.label || '', v => {
      if (v) device.label = v; else delete device.label;
      markDirtyRerender();
    })));
    return;
  }

  const shape = state.data.layout[index];
  if (!shape) { state.selection = null; return; }
  const spec = LAYOUT_SHAPES[shape.type];

  const typeLabel = document.createElement('p');
  typeLabel.className = 'editor-shape-type';
  typeLabel.textContent = shapeDisplayName(shape.type);
  propertiesFields.appendChild(typeLabel);

  if (spec?.kind === 'rect') {
    for (const f of ['x', 'y', 'width', 'height']) {
      propertiesFields.appendChild(field(f, numberInput(shape[f], v => { shape[f] = v; markDirtyRerender(); })));
    }
  } else if (spec?.kind === 'line') {
    for (const f of ['x1', 'y1', 'x2', 'y2']) {
      propertiesFields.appendChild(field(f, numberInput(shape[f], v => { shape[f] = v; markDirtyRerender(); })));
    }
  } else if (spec?.kind === 'circle') {
    for (const f of ['cx', 'cy', 'r']) {
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
  if (kind === 'device') state.data.devices.splice(index, 1);
  else state.data.layout.splice(index, 1);
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
});

connectBtn.addEventListener('click', connect);

roomPicker.addEventListener('change', () => {
  const opt = roomPicker.selectedOptions[0];
  if (!opt || !opt.value) return;
  loadRoom(opt.value, opt.dataset.label, opt.dataset.campus);
});

newRoomBtn.addEventListener('click', () => { if (rootHandle) openNewRoomDialog(); });
$('new-room-close').addEventListener('click', closeNewRoomDialog);
$('new-room-cancel').addEventListener('click', closeNewRoomDialog);
$('new-room-create').addEventListener('click', createNewRoom);
newRoomOverlay.addEventListener('click', e => { if (e.target === newRoomOverlay) closeNewRoomDialog(); });

deleteSelectedBtn.addEventListener('click', deleteSelected);
saveBtn.addEventListener('click', saveExistingRoom);

gridSizeInput.addEventListener('input', () => {
  state.gridSize = Number(gridSizeInput.value) || 0;
  renderAll();
});
showGridInput.addEventListener('change', renderAll);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (newRoomOverlay.classList.contains('open')) { closeNewRoomDialog(); return; }
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
