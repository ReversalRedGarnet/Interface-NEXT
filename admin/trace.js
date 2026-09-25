/**
 * trace.js — internal admin tool: trace building outlines from a local
 * drone/aerial photo and export campus.json-ready JSON.
 *
 * Deliberately self-contained — no imports from the app's js/ tree. This is
 * a one-off tool that only ever needs to PRODUCE data in the same shape
 * data/campus.json already uses; it never reads or writes any app file
 * itself, so there is nothing here worth coupling to app code for.
 *
 * Coordinate system: the <canvas>'s internal resolution (width/height
 * attributes) is set to the loaded photo's natural pixel size, and CSS only
 * scales its *displayed* size down to fit the screen — so a click's
 * canvas-space coordinates ARE the photo's real pixel coordinates, with no
 * separate scale factor to track or reapply later. Exported canvasWidth/
 * canvasHeight are that same photo's natural size, so pasted shapes need no
 * conversion at all, in either direction.
 *
 * Schema mismatch, by design: data/campus.json's building `shape` is a
 * plain axis-aligned rect ({x,y,width,height}) — there is no polygon shape
 * for buildings (unlike a room's own `outline`, which does support one).
 * Tracing an arbitrary polygon here is still useful for accurately finding
 * a building's footprint against the photo, so each finished shape keeps
 * its full point list on screen (for visual reference) but exports only
 * its axis-aligned bounding box, matching the real schema exactly.
 */

/** No emoji — self-contained flat outline icons, matching the ones inlined
 *  in trace.html (kept as plain constants here rather than importing from
 *  the app's js/ tree, per this file's own self-contained design above). */
const ICON_CLIPBOARD = '<svg width="1em" height="1em" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="4" y="2.5" width="8" height="11" rx="1"/><rect x="6" y="1" width="4" height="2" rx="0.5"/></svg>';
const ICON_TRASH = '<svg width="1em" height="1em" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11"/><path d="M5.5 4V2.5h5V4"/><path d="M4 4l.6 9.5h6.8L12 4"/></svg>';

const canvas = document.getElementById('trace-canvas');
const ctx = canvas.getContext('2d');
const canvasWrap = document.getElementById('canvas-wrap');
const emptyMsg = document.getElementById('trace-empty');
const photoInput = document.getElementById('photo-input');
const statusEl = document.getElementById('trace-status');
const pointsCountEl = document.getElementById('points-count');
const undoPointBtn = document.getElementById('btn-undo-point');
const cancelShapeBtn = document.getElementById('btn-cancel-shape');
const finishShapeBtn = document.getElementById('btn-finish-shape');
const buildingListEl = document.getElementById('building-list');
const buildingListEmptyEl = document.getElementById('building-list-empty');
const buildingCountEl = document.getElementById('building-count');
const exportBtn = document.getElementById('btn-export');
const copyBtn = document.getElementById('btn-copy');
const exportOutput = document.getElementById('export-output');

let image = null;          // the loaded <img>, drawn as the canvas background
let objectUrl = null;      // current blob: URL, revoked on replacement/unload
let currentPoints = [];    // in-progress shape, in native photo-pixel space
let buildings = [];        // finished shapes: { id, label, floors, points }

/* ── Photo loading ────────────────────────────────────────────────── */

photoInput.addEventListener('change', () => {
  const file = photoInput.files[0];
  if (!file) return;

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);

  const img = new Image();
  img.onload = () => {
    image = img;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    currentPoints = [];
    updatePointsUI();
    redraw();
    emptyMsg.hidden = true;
    statusEl.textContent = `${file.name} — ${img.naturalWidth}×${img.naturalHeight}px`;
    // The bitmap is already decoded onto the canvas/image; the blob URL
    // itself doesn't need to stay alive, and the file is never read again.
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  };
  img.onerror = () => {
    statusEl.textContent = 'Could not load that file as an image.';
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  };
  img.src = objectUrl;
});

window.addEventListener('beforeunload', () => {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});

/* ── Tracing ──────────────────────────────────────────────────────── */

/** Canvas click clientX/clientY → native photo-pixel coordinates, correcting
 *  for the canvas's CSS-scaled *display* size vs its internal resolution. */
function toImageCoords(evt) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return [
    Math.round((evt.clientX - rect.left) * scaleX),
    Math.round((evt.clientY - rect.top) * scaleY),
  ];
}

canvas.addEventListener('click', evt => {
  if (!image) return;
  currentPoints.push(toImageCoords(evt));
  updatePointsUI();
  redraw();
});

function updatePointsUI() {
  pointsCountEl.textContent = `${currentPoints.length} point${currentPoints.length === 1 ? '' : 's'}`;
  undoPointBtn.disabled = currentPoints.length === 0;
  cancelShapeBtn.disabled = currentPoints.length === 0;
  finishShapeBtn.disabled = currentPoints.length < 3;
}

undoPointBtn.addEventListener('click', () => {
  currentPoints.pop();
  updatePointsUI();
  redraw();
});

cancelShapeBtn.addEventListener('click', () => {
  currentPoints = [];
  updatePointsUI();
  redraw();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && currentPoints.length) {
    currentPoints = [];
    updatePointsUI();
    redraw();
  }
});

/* ── Finishing a shape: name + floor count, then bounding-box it ────── */

function boundingBox(points) {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y) };
}

function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'building';
}

function uniqueSlug(base) {
  const used = buildings.map(b => b.id);
  let slug = base, n = 2;
  while (used.includes(slug)) slug = `${base}-${n++}`;
  return slug;
}

/** Placeholder floors — there's no real room behind a freshly-traced
 *  building yet, so roomIds are just predictable slugs the admin wires up
 *  to real data/{roomId}.json + rooms/{roomId}.html files by hand (or via
 *  the existing drag-and-drop editor) before the nav will actually work. */
function makeFloors(slug, count) {
  if (count <= 1) return [{ roomId: slug, label: 'Floor 1' }];
  const floors = [];
  for (let i = 1; i <= count; i++) floors.push({ roomId: `${slug}-floor-${i}`, label: `Floor ${i}` });
  return floors;
}

finishShapeBtn.addEventListener('click', () => {
  if (currentPoints.length < 3) return;

  const name = window.prompt('Building name?', '');
  if (name === null) return; // cancelled — keep the points so they can retry
  const trimmedName = name.trim();
  if (!trimmedName) { alert('Building name is required.'); return; }

  const floorsInput = window.prompt('Number of floors? (1 = straight into the room; 2+ = floor picker)', '1');
  if (floorsInput === null) return;
  const floorCount = Math.max(1, parseInt(floorsInput, 10) || 1);

  const id = uniqueSlug(slugify(trimmedName));
  buildings.push({
    id,
    label: trimmedName,
    floors: makeFloors(id, floorCount),
    points: currentPoints,
  });

  currentPoints = [];
  updatePointsUI();
  renderBuildingList();
  redraw();
});

/* ── Building list panel ─────────────────────────────────────────── */

function renderBuildingList() {
  buildingCountEl.textContent = String(buildings.length);
  buildingListEmptyEl.hidden = buildings.length > 0;
  [...buildingListEl.querySelectorAll('li:not(#building-list-empty)')].forEach(li => li.remove());

  buildings.forEach((b, i) => {
    const li = document.createElement('li');

    const info = document.createElement('div');
    info.className = 'trace-building-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'trace-building-name';
    nameEl.textContent = b.label;
    const metaEl = document.createElement('div');
    metaEl.className = 'trace-building-meta';
    metaEl.textContent = `${b.floors.length} floor${b.floors.length === 1 ? '' : 's'} · ${b.points.length} points`;
    info.append(nameEl, metaEl);

    const redoBtn = document.createElement('button');
    redoBtn.type = 'button';
    redoBtn.className = 'trace-btn';
    redoBtn.textContent = '↺ Redo';
    redoBtn.title = 'Remove this shape and resume tracing its points';
    redoBtn.addEventListener('click', () => {
      currentPoints = buildings[i].points.slice();
      buildings.splice(i, 1);
      updatePointsUI();
      renderBuildingList();
      redraw();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'trace-btn danger';
    deleteBtn.innerHTML = ICON_TRASH;
    deleteBtn.title = 'Delete this building';
    deleteBtn.setAttribute('aria-label', 'Delete this building');
    deleteBtn.addEventListener('click', () => {
      buildings.splice(i, 1);
      renderBuildingList();
      redraw();
    });

    li.append(info, redoBtn, deleteBtn);
    buildingListEl.appendChild(li);
  });
}

/* ── Canvas drawing ───────────────────────────────────────────────── */

function drawPolygon(points, { stroke, fill, closed }) {
  if (points.length < 2 && !fill) {
    // still draw the single point as a dot below
  } else {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    if (closed) ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(2, canvas.width / 400);
    ctx.stroke();
  }
  ctx.fillStyle = stroke;
  const r = Math.max(3, canvas.width / 250);
  points.forEach(([x, y]) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawBoundingBox(shape, stroke) {
  ctx.strokeStyle = stroke;
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = Math.max(2, canvas.width / 500);
  ctx.strokeRect(shape.x, shape.y, shape.width, shape.height);
  ctx.setLineDash([]);
}

function redraw() {
  if (!image) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);

  // Finished buildings: traced outline (solid) + exported bounding box
  // (dashed) so it's obvious what actually gets exported.
  buildings.forEach(b => {
    drawPolygon(b.points, { stroke: '#4da3ff', fill: 'rgba(77,163,255,0.15)', closed: true });
    drawBoundingBox(boundingBox(b.points), '#ffb84d');
  });

  // In-progress shape.
  if (currentPoints.length) {
    drawPolygon(currentPoints, { stroke: '#4dff88', fill: currentPoints.length >= 3 ? 'rgba(77,255,136,0.15)' : null, closed: false });
  }
}

/* ── Export ───────────────────────────────────────────────────────── */

exportBtn.addEventListener('click', () => {
  const data = {
    canvasWidth: image ? image.naturalWidth : 1000,
    canvasHeight: image ? image.naturalHeight : 460,
    buildings: buildings.map(b => ({
      id: b.id,
      label: b.label,
      shape: boundingBox(b.points),
      floors: b.floors,
    })),
  };
  exportOutput.value = JSON.stringify(data, null, 2);
  copyBtn.disabled = buildings.length === 0;
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(exportOutput.value);
    copyBtn.textContent = '✓ Copied';
  } catch {
    exportOutput.select();
    copyBtn.textContent = 'Select-all instead (clipboard blocked)';
  }
  setTimeout(() => { copyBtn.innerHTML = `${ICON_CLIPBOARD} Copy to clipboard`; }, 1800);
});
