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
  findAssetIdOwner, isLayoutLocked, deviceBoxSize,
} from './schema.js';
import { render, renderDevice } from './canvas-renderer.js';
import { createToolController } from './tools.js';
import {
  roomFileStem, dataUrlForId, generateRoomHtml,
  extractIndexRoomStems, extractIndexSites, patchIndexHtml, removeFromIndexHtml,
  extractAllRoomsIds, patchExportJs, removeFromExportJs,
  validateNewRoomId,
} from './room-scaffold.js';
import { removeRoomFromCampusData, serializeCampusData } from '../campus-data.js';
import {
  ROOM_TEMPLATE_DEFAULT_SIZE, ROOM_TEMPLATE_DEFAULT_COUNT, templateNeedsCount,
  generateTemplateRoomData,
} from './room-templates.js';
import { toImageCoords, loadPhotoFile, drawPolygon } from '../photo-trace.js';
import { computeContentBounds, zoomModifierLabel } from '../room-logic.js';
import { createViewController } from '../view-controls.js';
import { createDisclosure } from '../disclosure.js';
import { createHelpOverlay } from '../help-overlay.js';
import {
  isCorrectPasscode, isSessionUnlocked, markSessionUnlocked,
  loadPasscodeConfig, recordFailedAttempt, cooldownRemainingMs,
} from './passcode-gate.js';

/* ── DOM refs ─────────────────────────────────────────────────────── */

const $ = id => document.getElementById(id);

/* ── Passcode gate ────────────────────────────────────────────────────
   Runs first, before anything else below touches the DOM: #editor-app
   starts `hidden` in editor.html itself, so even a script error further
   down in this file leaves the real editor unreachable rather than failing
   open. See passcode-gate.js for why this is deliberately casual. */

const editorApp = $('editor-app');
const lockScreen = $('editor-lock');
const lockForm = $('editor-lock-form');
const lockInput = $('editor-lock-input');
const lockError = $('editor-lock-error');
const lockCooldown = $('editor-lock-cooldown');
const lockSubmit = $('editor-lock-submit');

function revealEditor() {
  lockScreen.hidden = true;
  editorApp.hidden = false;
}

/* Holds this deployment's real passcode once loadPasscodeConfig() resolves
 * (see below) — stays null if the config is missing/malformed, which keeps
 * the form permanently disabled (fails closed) rather than accepting any
 * input at all. */
let configuredPasscode = null;
let cooldownTimer = null;

function setLockControlsDisabled(disabled) {
  lockInput.disabled = disabled;
  lockSubmit.disabled = disabled;
}

/** Reflects the current cooldown (if any) into the lock screen: disables
 *  the form and counts down while one is active, re-enables it the moment
 *  it lapses. Safe to call repeatedly/redundantly (after every failed
 *  attempt, and on a tick while a cooldown is running). */
function updateCooldownUI() {
  const remainingMs = cooldownRemainingMs();
  if (remainingMs <= 0) {
    if (cooldownTimer) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
    lockCooldown.textContent = '';
    if (configuredPasscode !== null) setLockControlsDisabled(false);
    return;
  }
  setLockControlsDisabled(true);
  const seconds = Math.ceil(remainingMs / 1000);
  lockCooldown.textContent = `Too many incorrect attempts — try again in ${seconds}s.`;
  if (!cooldownTimer) {
    cooldownTimer = setInterval(updateCooldownUI, 250);
  }
}

if (isSessionUnlocked()) {
  revealEditor();
} else {
  // Fails closed by default (disabled) until the config load below either
  // supplies a real passcode or reports it can't — never briefly "open" in
  // between, and never falls back to accepting anything.
  setLockControlsDisabled(true);
  loadPasscodeConfig().then(result => {
    if (!result.ok) {
      lockError.textContent = 'This deployment has no editor passcode configured — copy '
        + 'js/editor/passcode.config.example.js to js/editor/passcode.config.js, set a '
        + 'passcode, and reload.';
      return;
    }
    configuredPasscode = result.passcode;
    updateCooldownUI();
    lockInput.focus();
  });
}

lockForm.addEventListener('submit', e => {
  e.preventDefault();
  if (configuredPasscode === null || cooldownRemainingMs() > 0) return;
  if (isCorrectPasscode(lockInput.value, configuredPasscode)) {
    markSessionUnlocked();
    lockError.textContent = '';
    revealEditor();
  } else {
    recordFailedAttempt();
    lockError.textContent = 'Incorrect code. Try again.';
    lockInput.value = '';
    updateCooldownUI();
    if (cooldownRemainingMs() <= 0) lockInput.focus();
  }
});

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
const deleteRoomBtn = $('btn-delete-room');
const deleteRoomOverlay = $('delete-room-overlay');
const deleteRoomFinalWarning = $('delete-room-final-warning');
const toolsPanel = $('tools-panel');
const deviceToolsEl = $('device-tools');
const shapeToolsEl = $('shape-tools');
const gridSizeInput = $('grid-size');
const showGridInput = $('show-grid');
const propertiesPanel = $('properties-panel');
const propertiesEmpty = $('properties-empty');
const propertiesFields = $('properties-fields');
const deleteSelectedBtn = $('btn-delete-selected');
const saveBtn = $('btn-save');
const dirtyIndicator = $('dirty-indicator');
const statusEl = $('editor-status');
const svg = $('editor-canvas');
const canvasViewport = $('canvas-viewport');
const canvasFrame = $('canvas-frame');

const sidebarViewSection = $('sidebar-view');
const sidebarLegendSection = $('sidebar-legend');
const sidebarHelpSection = $('sidebar-help');

const edZoomOutBtn = $('ed-zoom-out');
const edZoomInBtn = $('ed-zoom-in');
const edZoomFitBtn = $('ed-zoom-fit');
const edZoom100Btn = $('ed-zoom-100');
const edZoomFullscreenBtn = $('ed-zoom-fullscreen');
const edZoomHint = $('ed-zoom-hint');

const viewToggleBtn = $('btn-editor-view-toggle');
const viewBody = $('editor-view-body');

const legendToggleBtn = $('btn-editor-legend-toggle');
const legendBody = $('editor-legend-body');
const deviceLegendEl = $('editor-device-legend');

const editorHelpBtn = $('btn-editor-help');
const editorHelpOverlay = $('editor-help-overlay');
const editorHelpCloseBtn = $('editor-help-close');
const editorShortcutList = $('editor-shortcut-list');

const newRoomOverlay = $('new-room-overlay');
const newRoomErrors = $('new-room-errors');
const nrId = $('nr-id');
const nrLabel = $('nr-label');
const nrSite = $('nr-site');
const nrSiteList = $('nr-site-list');
const nrRoomType = $('nr-room-type');
const nrCountField = $('nr-count-field');
const nrCountLabel = $('nr-count-label');
const nrCount = $('nr-count');
const nrTemplateHint = $('nr-template-hint');
const nrTraceField = $('nr-trace-field');
const nrTraceStatus = $('nr-trace-status');
const btnTracePhoto = $('btn-trace-photo');
const nrCopyFrom = $('nr-copy-from');
const nrWidth = $('nr-width');
const nrHeight = $('nr-height');

const tracePhotoOverlay = $('trace-photo-overlay');
const tracePhotoCloseBtn = $('trace-photo-close');
const tracePhotoCancelBtn = $('trace-photo-cancel');
const tracePhotoInput = $('trace-photo-input');
const tracePhotoLoadStatus = $('trace-photo-load-status');
const tracePhotoCanvas = $('trace-photo-canvas');
const tracePhotoEmpty = $('trace-photo-empty');
const tracePhotoPointsCount = $('trace-photo-points-count');
const btnTraceUndoPoint = $('btn-trace-undo-point');
const btnTraceCancelShape = $('btn-trace-cancel-shape');
const btnTraceUseOutline = $('btn-trace-use-outline');

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

/** Deletes `name` from `dirHandle` if it's there; a no-op (not an error) if
 *  it's already gone — Delete Room should degrade gracefully on an
 *  already-deleted room rather than failing the whole operation over one
 *  missing file. */
async function removeEntryIfExists(dirHandle, name) {
  try {
    await dirHandle.removeEntry(name);
  } catch (err) {
    if (err.name !== 'NotFoundError') throw err;
  }
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

  showRoomSections();
  editorFooter.hidden = false;
  setStatus(`Loaded data/${stem}.json`);
  renderAll();
  viewCtl.resetView();
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
  nrRoomType.value = 'blank';
  nrRoomType.disabled = false;
  nrCopyFrom.disabled = false;
  onRoomTypeChange();
  nrWidth.disabled = false;
  nrHeight.disabled = false;
  newRoomErrors.textContent = '';
  newRoomOverlay.classList.add('open');
  nrId.focus();
}

const NR_COUNT_LABELS = { 'computer-lab': 'How many PCs?', office: 'How many desks?' };

/** Set the moment "Use This Outline" is clicked in the trace dialog — the
 *  traced point list plus the reference photo's own natural pixel size (a
 *  room's canvasWidth/canvasHeight, same as any other room). Cleared
 *  whenever Room Type switches away from "trace-photo" (see
 *  onRoomTypeChange) so a stale trace can never silently get used after
 *  switching to a different creation method and back. */
let tracedOutline = null;

/** Room Type and "Copy layout from" are two different, mutually exclusive
 *  ways to seed a new room's starting content — picking a template here
 *  resets/disables Copy-from (see onCopyFromChange for the reverse
 *  direction), and each template gets its own default canvas size (see
 *  ROOM_TEMPLATE_DEFAULT_SIZE) and, for the two that ask for one, its own
 *  device-count field and default. Blank leaves everything exactly as it
 *  behaved before Room Type existed. "Trace from Photo" is handled here too
 *  — its own canvas size comes from the traced photo, not a fixed default,
 *  so its width/height fields stay disabled until a photo's actually been
 *  traced (see btnTraceUseOutline below), the same reasoning Copy-from's
 *  own lock already uses. */
function onRoomTypeChange() {
  const templateId = nrRoomType.value;
  const needsCount = templateNeedsCount(templateId);
  nrCountField.hidden = !needsCount;
  if (needsCount) {
    nrCountLabel.textContent = NR_COUNT_LABELS[templateId];
    nrCount.value = ROOM_TEMPLATE_DEFAULT_COUNT[templateId];
  }
  nrTemplateHint.hidden = templateId === 'blank' || templateId === 'trace-photo';
  nrTraceField.hidden = templateId !== 'trace-photo';
  if (templateId !== 'trace-photo') {
    tracedOutline = null;
    nrTraceStatus.textContent = 'No photo traced yet.';
  }

  nrCopyFrom.disabled = templateId !== 'blank';
  if (templateId !== 'blank') nrCopyFrom.value = '';

  // Exactly one place decides the canvas-size fields' enabled state and
  // value, regardless of which template was previously selected — trace-photo
  // locks them (there's no sensible default before a photo's traced; see
  // btnTraceUseOutline below), every other template/Blank releases
  // copy-from's own lock (see onCopyFromChange) and applies its own default.
  if (templateId === 'trace-photo') {
    nrWidth.disabled = true;
    nrHeight.disabled = true;
  } else {
    nrWidth.disabled = false;
    nrHeight.disabled = false;
    if (!nrCopyFrom.value) {
      const size = ROOM_TEMPLATE_DEFAULT_SIZE[templateId] || ROOM_TEMPLATE_DEFAULT_SIZE.blank;
      nrWidth.value = size.width;
      nrHeight.value = size.height;
    }
  }
}

/** Picking a source room locks the canvas-size fields to its own
 *  canvasWidth/canvasHeight — copied wall/boundary coordinates are only
 *  meaningful against the canvas they were placed on, so letting the size
 *  fields drift from the source would silently misplace everything. Also
 *  forces Room Type back to Blank (see onRoomTypeChange for the reverse
 *  direction) — copying a layout and generating a template are two
 *  different ways to seed the same field, never both at once. */
async function onCopyFromChange() {
  const sourceId = nrCopyFrom.value;
  if (!sourceId) {
    nrWidth.disabled = false;
    nrHeight.disabled = false;
    nrRoomType.disabled = false;
    return;
  }
  try {
    const source = await readRoomData(sourceId);
    nrWidth.value = source.canvasWidth;
    nrHeight.value = source.canvasHeight;
    nrWidth.disabled = true;
    nrHeight.disabled = true;
    nrRoomType.value = 'blank';
    nrRoomType.disabled = true;
    onRoomTypeChange();
  } catch (err) {
    newRoomErrors.textContent = `Couldn't read the layout to copy from: ${err.message}`;
    nrCopyFrom.value = '';
    nrWidth.disabled = false;
    nrHeight.disabled = false;
    nrRoomType.disabled = false;
  }
}

function closeNewRoomDialog() {
  newRoomOverlay.classList.remove('open');
}

/* ── Trace Walls from Photo ───────────────────────────────────────────
   A second, small overlay layered on top of the New Room dialog — reuses
   js/photo-trace.js's shared click-trace mechanic (also used by
   admin/trace.html) for a room's `outline` layout shape instead of a
   campus building's bounding box. The reference photo is decoded straight
   onto the canvas and never persisted anywhere (see photo-trace.js's
   loadPhotoFile) — same guarantee admin/trace.html already makes. */

let traceImage = null;       // the loaded <img>, drawn as the canvas background
let tracePoints = [];        // in-progress outline, in native photo-pixel space
let tracePhotoCtx = null;    // fetched lazily — see getTracePhotoCtx()

/** Deferred rather than fetched at module load: jsdom's 2D canvas context
 *  needs the optional `canvas` npm package this project deliberately
 *  doesn't depend on (dev-only jsdom is the only test dependency — see
 *  package.json), so calling getContext() eagerly would break every test
 *  that merely mounts editor.js, not just ones that touch this feature.
 *  Actual pixel drawing here isn't unit-tested for the same reason
 *  canvas-renderer.js's SVG output isn't — only real browser use exercises
 *  it, same convention this project already follows throughout. */
function getTracePhotoCtx() {
  return tracePhotoCtx || (tracePhotoCtx = tracePhotoCanvas.getContext('2d'));
}

function updateTracePointsUI() {
  tracePhotoPointsCount.textContent = `${tracePoints.length} point${tracePoints.length === 1 ? '' : 's'}`;
  btnTraceUndoPoint.disabled = tracePoints.length === 0;
  btnTraceCancelShape.disabled = tracePoints.length === 0;
  btnTraceUseOutline.disabled = tracePoints.length < 3;
}

function redrawTraceCanvas() {
  if (!traceImage) return;
  const ctx = getTracePhotoCtx();
  ctx.clearRect(0, 0, tracePhotoCanvas.width, tracePhotoCanvas.height);
  ctx.drawImage(traceImage, 0, 0);
  if (tracePoints.length) {
    drawPolygon(ctx, tracePhotoCanvas.width, tracePoints, {
      stroke: '#4dff88', fill: tracePoints.length >= 3 ? 'rgba(77,255,136,0.15)' : null, closed: false,
    });
  }
}

function openTracePhotoDialog() {
  traceImage = null;
  tracePoints = [];
  tracePhotoInput.value = '';
  tracePhotoLoadStatus.textContent = 'No photo loaded.';
  tracePhotoEmpty.hidden = false;
  updateTracePointsUI();
  tracePhotoOverlay.classList.add('open');
}

function closeTracePhotoDialog() {
  tracePhotoOverlay.classList.remove('open');
}

tracePhotoInput.addEventListener('change', async () => {
  const file = tracePhotoInput.files[0];
  if (!file) return;
  try {
    const img = await loadPhotoFile(file);
    traceImage = img;
    tracePhotoCanvas.width = img.naturalWidth;
    tracePhotoCanvas.height = img.naturalHeight;
    tracePoints = [];
    updateTracePointsUI();
    redrawTraceCanvas();
    tracePhotoEmpty.hidden = true;
    tracePhotoLoadStatus.textContent = `${file.name} — ${img.naturalWidth}×${img.naturalHeight}px`;
  } catch (err) {
    tracePhotoLoadStatus.textContent = err.message;
  }
});

tracePhotoCanvas.addEventListener('click', evt => {
  if (!traceImage) return;
  tracePoints.push(toImageCoords(tracePhotoCanvas, evt.clientX, evt.clientY));
  updateTracePointsUI();
  redrawTraceCanvas();
});

btnTraceUndoPoint.addEventListener('click', () => {
  tracePoints.pop();
  updateTracePointsUI();
  redrawTraceCanvas();
});

btnTraceCancelShape.addEventListener('click', () => {
  tracePoints = [];
  updateTracePointsUI();
  redrawTraceCanvas();
});

/** Walls/outline only, by design — no device tracing here (see this
 *  feature's own spec: templates already established "layout only, devices
 *  placed manually after", and a drone/aerial photo doesn't show devices
 *  anyway). Keeps the FULL traced point list (unlike admin/trace.html's own
 *  export, which reduces a shape to its bounding box for campus.json) since
 *  a room's `outline` schema shape supports a real polygon. */
btnTraceUseOutline.addEventListener('click', () => {
  if (tracePoints.length < 3) return;
  tracedOutline = {
    points: tracePoints.map(p => [...p]),
    canvasWidth: traceImage.naturalWidth,
    canvasHeight: traceImage.naturalHeight,
  };
  nrWidth.value = tracedOutline.canvasWidth;
  nrHeight.value = tracedOutline.canvasHeight;
  nrTraceStatus.textContent = `Outline traced — ${tracedOutline.points.length} points, ${tracedOutline.canvasWidth}×${tracedOutline.canvasHeight}.`;
  closeTracePhotoDialog();
});

btnTracePhoto.addEventListener('click', openTracePhotoDialog);
tracePhotoCloseBtn.addEventListener('click', closeTracePhotoDialog);
tracePhotoCancelBtn.addEventListener('click', closeTracePhotoDialog);
tracePhotoOverlay.addEventListener('click', e => { if (e.target === tracePhotoOverlay) closeTracePhotoDialog(); });

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
  const templateId = nrRoomType.value;

  const problems = [];
  if (!campus) problems.push('Site is required.');
  if (!copyFromId && templateId === 'trace-photo' && !tracedOutline) {
    problems.push('Trace a photo first, or choose a different Room type.');
  }

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
  } else if (templateId === 'trace-photo') {
    // Walls/outline only — same "layout only, devices placed manually
    // after" pattern the Room Type templates already use; see
    // btnTraceUseOutline above for where tracedOutline gets set.
    roomData = {
      ...createBlankRoomData(canvasWidth, canvasHeight),
      layout: [{ type: 'outline', points: tracedOutline.points.map(p => [...p]) }],
    };
  } else if (templateId && templateId !== 'blank') {
    const count = templateNeedsCount(templateId) ? Number(nrCount.value) : undefined;
    roomData = generateTemplateRoomData(templateId, canvasWidth, canvasHeight, count);
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
    showRoomSections();
    editorFooter.hidden = false;
    setStatus(`Created ${id}: data/${roomFileStem(id)}.json, rooms/${roomFileStem(id)}.html, index.html, and js/export.js.`);
    renderAll();
    viewCtl.resetView();
  } catch (err) {
    newRoomErrors.textContent = err.message;
  }
}

/* ── Rendering ────────────────────────────────────────────────────── */

/** Tools/Properties/View/Legend/Help all stay hidden until a room is
 *  actually loaded or created — same gating `toolsPanel` alone used to have,
 *  just applied to every section that's meaningless against an empty
 *  canvas. */
function showRoomSections() {
  toolsPanel.hidden = false;
  propertiesPanel.hidden = false;
  sidebarViewSection.hidden = false;
  sidebarLegendSection.hidden = false;
  sidebarHelpSection.hidden = false;
}

function renderAll() {
  if (!state.data) return;
  const locked = isLayoutLocked(state.data);
  syncFrameSize();
  render(svg, state.data, { selection: state.selection, gridSize: state.gridSize, showGrid: showGridInput.checked, locked });
  renderProperties();
  renderRoomStatus();
  updatePaletteLockState(locked);
  updateDirtyUI();
}

/* ── Zoom / pan / fit (View section) ──────────────────────────────────
   Shared with room.js (see view-controls.js) — this page's own
   contribution is just which elements it transforms, and that its content
   bounds are recomputed fresh on every fit (its room DATA changes
   constantly as it's edited) rather than cached once like room.js's. The
   transform applies to `canvasFrame` (a plain div sized to the room's
   canvasWidth/canvasHeight), not the SVG's own viewBox — tools.js's
   clientToSvgPoint() reads the SVG's getScreenCTM(), which already folds in
   any ancestor CSS transform, so panning/zooming this frame needs no
   changes there at all. Panning is also gated on the Select tool and
   excludes shapes/devices (`[data-kind]`), unlike room.js which has no tool
   concept and only excludes devices (`[data-id]`) — see `shouldPan` below. */

function syncFrameSize() {
  canvasFrame.style.width = `${state.data.canvasWidth}px`;
  canvasFrame.style.height = `${state.data.canvasHeight}px`;
}

function currentContentBounds() {
  const { canvasWidth: W, canvasHeight: H, layout, devices } = state.data;
  return computeContentBounds(layout, devices, W, H);
}

const viewCtl = createViewController({
  viewport: canvasViewport,
  frame: canvasFrame,
  getCanvasSize: () => ({ w: state.data.canvasWidth, h: state.data.canvasHeight }),
  getContentBounds: currentContentBounds,
  isReady: () => !!state.data,
  shouldPan: e => state.tool?.type === 'select' && !e.target.closest?.('[data-kind]'),
  buttons: {
    zoomOut: edZoomOutBtn,
    zoomIn: edZoomInBtn,
    zoomFit: edZoomFitBtn,
    zoom100: edZoom100Btn,
    zoomFullscreen: edZoomFullscreenBtn,
  },
  hintEl: edZoomHint,
});

/** Collapsible like Legend (same shared disclosure component, see
 *  disclosure.js) — defaults collapsed, since Tools/Properties are reached
 *  for far more often than the View controls. */
const viewDisclosure = createDisclosure({
  toggleBtn: viewToggleBtn,
  body: viewBody,
  openLabel: 'View ▴',
  closedLabel: 'View ▾',
  defaultOpen: false,
});

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
  deleteRoomBtn.hidden = !has;
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

/* ── Delete Room — the reverse of createNewRoom(): deletes the currently
   loaded room's data/*.json and rooms/*.html, and un-registers it from
   every touch-point createNewRoom() writes (ALL_ROOMS in js/export.js,
   its <a class="room-link"> in index.html), plus data/campus.json if it's
   placed in a building there — createNewRoom() never writes that file, but
   a room can still end up referenced there by manual/future placement, so
   this is the one touch-point that's a cleanup rather than a strict mirror.
   Requires the same explicit confirmation Reset Room/Unlock Layout already
   do; a "final" room's confirmation says so explicitly, since that room may
   already be in front of a real checker. Does not, and cannot, clear any
   localStorage inspection-state a browser already holds for this room's
   old device ids — that's per-browser, out of reach of a static-file
   operation, same limitation exportStateJSON's own docs already note. */

function openDeleteRoomConfirm() {
  if (!state.data) return;
  deleteRoomFinalWarning.hidden = !isLayoutLocked(state.data);
  deleteRoomOverlay.classList.add('open');
}
function closeDeleteRoomConfirm() {
  deleteRoomOverlay.classList.remove('open');
}

/** Back to the same "nothing loaded" state the page starts in — the
 *  inverse of showRoomSections() plus clearing the canvas and state. */
function resetToNoRoomLoaded() {
  state.mode = null;
  state.roomId = null;
  state.roomLabel = null;
  state.roomCampus = null;
  state.data = null;
  state.selection = null;
  state.tool = { type: 'select' };
  state.dirty = false;
  svg.replaceChildren();
  toolsPanel.hidden = true;
  propertiesPanel.hidden = true;
  sidebarViewSection.hidden = true;
  sidebarLegendSection.hidden = true;
  sidebarHelpSection.hidden = true;
  editorFooter.hidden = true;
  renderRoomStatus();
  roomPicker.value = '';
}

async function confirmDeleteRoom() {
  if (!state.data) return;
  const id = state.roomId;
  const stem = roomFileStem(id);

  try {
    const dataDir = await rootHandle.getDirectoryHandle('data');
    const roomsDir = await rootHandle.getDirectoryHandle('rooms');
    const jsDir = await rootHandle.getDirectoryHandle('js');

    await removeEntryIfExists(dataDir, `${stem}.json`);
    await removeEntryIfExists(roomsDir, `${stem}.html`);

    const exportJsText = await readTextFile(jsDir, 'export.js');
    await writeTextFile(jsDir, 'export.js', removeFromExportJs(exportJsText, id));

    const indexHtmlText = await readTextFile(rootHandle, 'index.html');
    await writeTextFile(rootHandle, 'index.html', removeFromIndexHtml(indexHtmlText, id));

    let campusNote = '';
    try {
      const campusText = await readTextFile(dataDir, 'campus.json');
      const { data: newCampusData, removed } = removeRoomFromCampusData(JSON.parse(campusText), stem);
      if (removed.length) {
        await writeTextFile(dataDir, 'campus.json', serializeCampusData(newCampusData));
        const where = removed.map(r => `${r.buildingLabel} (${r.floorLabel})`).join(', ');
        campusNote = ` Also unlinked from ${where} in data/campus.json.`;
      }
    } catch {
      // Missing/unreadable/malformed campus.json — nothing to unlink.
    }

    resetToNoRoomLoaded();
    closeDeleteRoomConfirm();
    await refreshRoomPicker();
    setStatus(`Deleted ${id}: data/${stem}.json, rooms/${stem}.html, and its entries in index.html and js/export.js.${campusNote}`);
  } catch (err) {
    closeDeleteRoomConfirm();
    setStatus(`Delete failed: ${err.message}`, true);
  }
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

/** The Properties section itself is never hidden once a room is loaded
 *  (see showRoomSections) — only its own inner content toggles, between a
 *  one-line "Nothing selected" placeholder and the full fields, so the
 *  section never disappears and jumps the sections around it. */
function renderProperties() {
  const has = !!state.selection;
  propertiesEmpty.hidden = has;
  propertiesFields.hidden = !has;
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

/** Builds a device type's canvas-accurate swatch — the same SVG node
 *  renderDevice() would draw on the canvas itself — shared by the Legend
 *  (true-to-scale, via buildDeviceLegend) and the Tools palette (uniformly
 *  small, via buildPalette) so a device type's icon can never drift between
 *  the two. */
function buildDeviceSwatchSvg(type) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const pad = 3;
  const sample = { type, id: type };
  const { width, height } = deviceBoxSize(sample);
  const swatch = document.createElementNS(svgNS, 'svg');
  swatch.setAttribute('viewBox', `-${pad} -${pad} ${width + pad * 2} ${height + pad * 2}`);
  swatch.appendChild(renderDevice(sample, 0));
  return { swatch, width, height };
}

/** Generic per-kind icon for the Tools palette's Shapes group — schematic,
 *  not literal (several shape types share a kind: floor/room/counter/
 *  wallrect are all rect-kind), same plain-outline-SVG house style as
 *  room.js's own icons (see its ICON_SEARCH/ICON_FULLSCREEN). Static markup
 *  built from a fixed, non-user-controlled set of shape kinds, so building
 *  it via innerHTML below is safe. */
const SHAPE_KIND_ICON = {
  rect: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="10"/></svg>',
  line: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="2" y1="8" x2="14" y2="8"/></svg>',
  hinge: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2 14V3"/><path d="M2 3 A11 11 0 0 1 13 14" stroke-dasharray="2 2"/></svg>',
  polygon: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><polygon points="2,14 2,5 8,2 14,6 14,14"/></svg>',
};

/** A compact icon+label grid (see editor.css's .editor-tool-row) rather
 *  than a full-width stacked list — same set of tools, same click/arm
 *  behavior (armTool), just far less vertical space. */
function buildPalette() {
  DEVICE_TYPES.forEach(type => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toolbar-btn editor-tool-btn';
    btn.title = type;
    const { swatch } = buildDeviceSwatchSvg(type);
    swatch.classList.add('editor-tool-icon');
    btn.appendChild(swatch);
    const label = document.createElement('span');
    label.className = 'editor-tool-label';
    label.textContent = type;
    btn.appendChild(label);
    btn.addEventListener('click', () => armTool({ type: 'add-device', deviceType: type }, btn));
    deviceToolsEl.appendChild(btn);
  });

  PLACEABLE_SHAPE_TYPES.forEach(type => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toolbar-btn editor-tool-btn';
    const label = shapeDisplayName(type);
    btn.title = label;
    const kind = LAYOUT_SHAPES[type]?.kind;
    btn.innerHTML = `${SHAPE_KIND_ICON[kind] || ''}<span class="editor-tool-label">${label}</span>`;
    btn.querySelector('svg')?.classList.add('editor-tool-icon');
    btn.addEventListener('click', () => armTool({ type: 'add-shape', shapeType: type }, btn));
    shapeToolsEl.appendChild(btn);
  });
}

/* ── Legend — what each device-type block in the Tools palette actually
   looks like on canvas, built from canvas-renderer.js's own renderDevice()
   so it can never drift from what the canvas draws. Collapsible, same
   disclosure convention as room.js's Legend & Stats section. ── */

function buildDeviceLegend() {
  deviceLegendEl.innerHTML = '';
  DEVICE_TYPES.forEach(type => {
    const item = document.createElement('div');
    item.className = 'legend-item';

    const { swatch, width, height } = buildDeviceSwatchSvg(type);
    swatch.setAttribute('width', String(width));
    swatch.setAttribute('height', String(height));
    swatch.classList.add('editor-legend-swatch');
    item.appendChild(swatch);

    const label = document.createElement('span');
    label.textContent = type.length <= 3 ? type.toUpperCase() : type.charAt(0).toUpperCase() + type.slice(1);
    item.appendChild(label);

    deviceLegendEl.appendChild(item);
  });
}

/** Collapsible, built on the same shared disclosure component room.js's own
 *  Legend & Stats section uses (see disclosure.js). */
const legendCtl = createDisclosure({
  toggleBtn: legendToggleBtn,
  body: legendBody,
  openLabel: 'Legend ▴',
  closedLabel: 'Legend ▾',
  defaultOpen: false,
});

/* ── Help / shortcuts ──────────────────────────────────────────────── */

/** Data for the shared help-overlay component (see help-overlay.js) — the
 *  rendering itself is one implementation shared with room.js's own
 *  shortcut list. */
const EDITOR_HELP_ROWS = [
  ['Click canvas', 'Place the armed tool, or select what’s under the pointer'],
  ['Drag, or click then click a destination', 'Move the selected device or shape'],
  ['Corner / endpoint handles', 'Resize or reshape the selected shape'],
  ['Delete', 'Delete the selected device or shape'],
  ['Escape', 'Return to Select, or close an open dialog'],
  ['F', 'Fit the floor plan to screen'],
  [`${zoomModifierLabel()}+scroll`, 'Zoom the floor plan (plain scroll behaves normally)'],
  ['?', 'Open this help'],
];

/** No focus-trap/return-focus here — matches this page's own pre-existing
 *  simpler overlay behavior (its New Room / Unlock dialogs don't have it
 *  either), unlike room.js's own Help overlay which keeps its fuller
 *  behavior via focusManagement:true (see help-overlay.js). */
const helpCtl = createHelpOverlay({
  overlay: editorHelpOverlay,
  list: editorShortcutList,
  rows: EDITOR_HELP_ROWS,
  openBtn: editorHelpBtn,
  closeBtn: editorHelpCloseBtn,
});

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
nrRoomType.addEventListener('change', onRoomTypeChange);
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

deleteRoomBtn.addEventListener('click', openDeleteRoomConfirm);
$('delete-room-confirm').addEventListener('click', confirmDeleteRoom);
$('delete-room-cancel').addEventListener('click', closeDeleteRoomConfirm);
deleteRoomOverlay.addEventListener('click', e => { if (e.target === deleteRoomOverlay) closeDeleteRoomConfirm(); });

gridSizeInput.addEventListener('input', () => {
  state.gridSize = Number(gridSizeInput.value) || 0;
  renderAll();
});
showGridInput.addEventListener('change', renderAll);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (tracePhotoOverlay.classList.contains('open')) { closeTracePhotoDialog(); return; }
    if (newRoomOverlay.classList.contains('open')) { closeNewRoomDialog(); return; }
    if (unlockOverlay.classList.contains('open')) { closeUnlockConfirm(); return; }
    if (deleteRoomOverlay.classList.contains('open')) { closeDeleteRoomConfirm(); return; }
    if (helpCtl.isOpen()) { helpCtl.close(); return; }
    state.tool = { type: 'select' };
    document.querySelectorAll('.editor-tool-btn.armed').forEach(b => b.classList.remove('armed'));
  }
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (e.key === 'Delete' && state.selection && !typing) {
    deleteSelected();
    return;
  }
  if (typing) return;
  if (e.key === '?') { e.preventDefault(); helpCtl.open(); return; }
  if (e.key.toLowerCase() === 'f' && state.data) { e.preventDefault(); viewCtl.fitToScreen(); }
});

window.addEventListener('beforeunload', e => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

buildPalette();
buildDeviceTypeList();
buildDeviceLegend();
