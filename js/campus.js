/**
 * campus.js — prototype nav layer: a birds-eye "Campus" view rendered into
 * index.html's #campus-root. Renders buildings from data/campus.json as
 * clickable schematic blocks; clicking one either goes straight to its
 * single floor's existing room page, or opens a floor-picker overlay when
 * it has more than one floor. Deliberately independent of the room/editor
 * internals — this file only ever reads data/campus.json and links to the
 * existing rooms/*.html pages, never room/device data itself.
 */
import { roomFileStem } from './editor/room-scaffold.js';
import { normalizeCampusData, findBuilding, buildingDestination } from './campus-data.js';

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function roomHref(roomId) {
  return `rooms/${roomFileStem(roomId)}.html`;
}

function buildingSvg(data) {
  const blocks = data.buildings.map(b => {
    const { x, y, width, height } = b.shape;
    const cx = x + width / 2, cy = y + height / 2;
    const sub = b.floors.length > 1
      ? `<text x="${cx}" y="${cy + 16}" class="campus-building-sub" text-anchor="middle">${b.floors.length} floors</text>`
      : '';
    return `<g class="campus-building" data-building-id="${escapeHTML(b.id)}" tabindex="0" role="button" aria-label="${escapeHTML(b.label)}">
      <rect x="${x}" y="${y}" width="${width}" height="${height}" class="campus-building-shape"/>
      <text x="${cx}" y="${cy}" class="campus-building-label" text-anchor="middle" dominant-baseline="middle">${escapeHTML(b.label)}</text>
      ${sub}
    </g>`;
  }).join('');
  return `<svg class="campus-svg" viewBox="0 0 ${data.canvasWidth} ${data.canvasHeight}" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="Campus buildings">${blocks}</svg>`;
}

export async function initCampusPage() {
  const root = document.getElementById('campus-root');
  if (!root) return;

  root.innerHTML = `
    <div class="campus-canvas-wrap" id="campus-canvas-wrap">
      <p class="campus-loading">Loading campus…</p>
    </div>

    <div class="overlay" id="floor-picker-overlay" role="dialog" aria-modal="true" aria-labelledby="floor-picker-title">
      <div class="popup">
        <button class="popup-close" id="floor-picker-close" aria-label="Close">✕</button>
        <h3 class="popup-title" id="floor-picker-title"></h3>
        <p class="popup-body" id="floor-picker-body"></p>
        <div class="room-list" id="floor-picker-list"></div>
      </div>
    </div>
  `;

  const canvasWrap = document.getElementById('campus-canvas-wrap');
  const overlay = document.getElementById('floor-picker-overlay');
  const pickerTitle = document.getElementById('floor-picker-title');
  const pickerBody = document.getElementById('floor-picker-body');
  const pickerList = document.getElementById('floor-picker-list');

  function openFloorPicker(building) {
    pickerTitle.textContent = building.label;
    pickerBody.textContent = `${building.floors.length} floors — pick one to check its devices.`;
    pickerList.innerHTML = building.floors.map(f => `
      <a class="room-link" href="${roomHref(f.roomId)}">
        <span class="room-link-icon" aria-hidden="true"><svg class="icon" width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1" y="2" width="14" height="9" rx="1"/><line x1="5.5" y1="14" x2="10.5" y2="14" stroke-linecap="round"/><line x1="8" y1="11" x2="8" y2="14" stroke-linecap="round"/></svg></span>${escapeHTML(f.label)}
      </a>`).join('');
    overlay.classList.add('open');
  }
  function closeFloorPicker() {
    overlay.classList.remove('open');
  }

  document.getElementById('floor-picker-close').addEventListener('click', closeFloorPicker);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeFloorPicker(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeFloorPicker(); });

  let campusData = null;

  function activate(buildingId) {
    const building = findBuilding(campusData, buildingId);
    const dest = buildingDestination(building);
    if (dest.kind === 'room') window.location.href = roomHref(dest.roomId);
    else if (dest.kind === 'floor-picker') openFloorPicker(building);
  }

  canvasWrap.addEventListener('click', e => {
    const target = e.target.closest('[data-building-id]');
    if (target) activate(target.dataset.buildingId);
  });
  // Buildings are SVG <g role="button"> elements, not real <button>s (a
  // schematic block is an arbitrary shape) — Enter/Space activation has to
  // be wired by hand for the same keyboard reachability room.js's real
  // <button> devices get for free.
  canvasWrap.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target.closest('[data-building-id]');
    if (target) { e.preventDefault(); activate(target.dataset.buildingId); }
  });

  try {
    const res = await fetch('data/campus.json');
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    campusData = normalizeCampusData(await res.json());
    canvasWrap.innerHTML = buildingSvg(campusData);
  } catch (err) {
    canvasWrap.innerHTML = `<p class="campus-loading">Couldn't load campus data: ${escapeHTML(err.message)}</p>`;
  }
}
