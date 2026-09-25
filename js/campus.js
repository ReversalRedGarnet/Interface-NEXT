/**
 * campus.js — prototype nav layer: a birds-eye "Campus" view rendered into
 * index.html's #campus-root. Renders buildings from data/campus.json as
 * clickable schematic blocks; clicking one either goes straight to its
 * single floor's existing room page, or opens a floor-picker overlay when
 * it has more than one floor.
 *
 * Building stats (device/inspected/remaining/issue counts, and the small
 * status marker) are the one place this file does read room/device data —
 * lazily, one building at a time, via the same fetchRoomDevices() export.js
 * already uses for its own "Export All Rooms" roster fetch. The initial
 * building blocks render and become clickable the moment data/campus.json
 * itself resolves; stats fill in afterward, per building, as each one's
 * own fetch resolves — never blocking the initial paint on every room's
 * data file.
 */
import { roomFileStem } from './editor/room-scaffold.js';
import { normalizeCampusData, findBuilding, buildingDestination } from './campus-data.js';
import { ALL_ROOMS, fetchRoomDevices, fetchRoomStatus } from './export.js';
import { loadState } from './state.js';
import { buildingStats, buildingStatusKey } from './issues-logic.js';

/**
 * data/campus.json's floor.roomId values are lowercase file stems (e.g.
 * "commons"); every stored inspection entry is keyed by the room's real,
 * differently-cased id (ROOM_META.id / ALL_ROOMS' id, e.g. "COMMONS" — see
 * state.js's stateKey()). Stats have to look state up under that real id,
 * not the stem, or every building would read as permanently 0% inspected.
 */
function canonicalRoomId(roomId) {
  const stem = roomFileStem(roomId);
  return ALL_ROOMS.find(r => roomFileStem(r.id) === stem)?.id || roomId;
}

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
      <circle class="campus-building-status" cx="${x + width - 10}" cy="${y + 10}" r="5" data-state="not-inspected"/>
    </g>`;
  }).join('');
  return `<svg class="campus-svg" viewBox="0 0 ${data.canvasWidth} ${data.canvasHeight}" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="Campus buildings">${blocks}</svg>`;
}

function rectOf(el) {
  try { return el.getBoundingClientRect(); }
  catch { return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; }
}

export async function initCampusPage() {
  const root = document.getElementById('campus-root');
  if (!root) return;

  root.innerHTML = `
    <div class="campus-canvas-wrap" id="campus-canvas-wrap">
      <p class="campus-loading">Loading campus…</p>
    </div>

    <div class="campus-tooltip floating-panel" id="campus-tooltip" hidden></div>

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
  const tooltip = document.getElementById('campus-tooltip');
  const overlay = document.getElementById('floor-picker-overlay');
  const pickerTitle = document.getElementById('floor-picker-title');
  const pickerBody = document.getElementById('floor-picker-body');
  const pickerList = document.getElementById('floor-picker-list');

const ROOM_LINK_ICON = '<svg class="icon" width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1" y="2" width="14" height="9" rx="1"/><line x1="5.5" y1="14" x2="10.5" y2="14" stroke-linecap="round"/><line x1="8" y1="11" x2="8" y2="14" stroke-linecap="round"/></svg>';

  let campusData = null;
  const statsCache = new Map(); // buildingId -> stats from issues-logic.js's buildingStats()
  // roomId (canonical, e.g. "COMMONS") -> "draft" | "final", filled in by
  // populateBuildingStats() alongside stats, from the same per-floor fetch
  // — see its own comment for why this makes both reads below reliable by
  // the time a user could plausibly click anything.
  const statusCache = new Map();

  /** A floor is only navigable once its status is known AND final —
   *  defaults to "not yet known" (never navigable) rather than assuming
   *  final, so a floor whose fetch hasn't resolved yet reads the same as
   *  one that's genuinely still draft, not as a broken/silent link. */
  function floorIsFinal(roomId) {
    return statusCache.get(canonicalRoomId(roomId)) === 'final';
  }

  function openFloorPicker(building) {
    pickerTitle.textContent = building.label;
    pickerBody.textContent = `${building.floors.length} floors — pick one to check its devices.`;
    pickerList.innerHTML = building.floors.map(f => {
      if (floorIsFinal(f.roomId)) {
        return `<a class="room-link" href="${roomHref(f.roomId)}">
          <span class="room-link-icon" aria-hidden="true">${ROOM_LINK_ICON}</span>${escapeHTML(f.label)}
        </a>`;
      }
      return `<span class="room-link room-link-disabled" aria-disabled="true">
        <span class="room-link-icon" aria-hidden="true">${ROOM_LINK_ICON}</span>${escapeHTML(f.label)} — <em>Not yet finalized</em>
      </span>`;
    }).join('');
    overlay.classList.add('open');
  }

  /** Reuses the same overlay/popup a floor-picker uses — for a single-floor
   *  building whose one floor turns out to still be draft, so clicking it
   *  gives a clear, on-brand message instead of silently navigating into
   *  room.js's own not-finalized gate (still there as a backstop — see
   *  room.js's renderNotFinalized — but bouncing through a full page load
   *  just to show the same message is worse UX than saying so right here). */
  function openNotFinalizedNotice(building, floor) {
    pickerTitle.textContent = building.label;
    pickerBody.textContent = `${floor.label} isn't finalized yet — its layout is still being drafted in the editor.`;
    pickerList.innerHTML = `<a class="room-link" href="editor.html">
      <span class="room-link-icon" aria-hidden="true">${ROOM_LINK_ICON}</span>Open in Editor
    </a>`;
    overlay.classList.add('open');
  }

  function closeFloorPicker() {
    overlay.classList.remove('open');
  }

  document.getElementById('floor-picker-close').addEventListener('click', closeFloorPicker);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeFloorPicker(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeFloorPicker(); });

  function activate(buildingId) {
    const building = findBuilding(campusData, buildingId);
    const dest = buildingDestination(building);
    if (dest.kind === 'room') {
      if (floorIsFinal(dest.roomId)) window.location.href = roomHref(dest.roomId);
      else openNotFinalizedNotice(building, building.floors[0]);
    } else if (dest.kind === 'floor-picker') {
      openFloorPicker(building);
    }
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

  /* ── Hover/focus stats reveal ──
     Default (unselected) state stays just name + floor count, drawn once by
     buildingSvg() above — the tooltip only appears on hover or keyboard
     focus, so the map itself never gets cluttered with numbers. mouseover/
     mouseout (not mouseenter/mouseleave) so one delegated listener on the
     canvas wrapper covers every building, same pattern as the click/keydown
     handlers just above; focusin/focusout give keyboard users the same
     reveal mouseover/mouseout give a pointer. */
  function showTooltip(el) {
    const building = findBuilding(campusData, el.dataset.buildingId);
    if (!building) return;
    const stats = statsCache.get(building.id);
    const floorWord = building.floors.length === 1 ? 'floor' : 'floors';
    const statsLine = stats
      ? `${stats.total} device${stats.total === 1 ? '' : 's'} · ${stats.inspected} inspected · ${stats.unchecked} remaining · ${stats.issues} issue${stats.issues === 1 ? '' : 's'}`
      : 'Loading stats…';
    tooltip.innerHTML = `<strong>${escapeHTML(building.label)}</strong><br>${building.floors.length} ${floorWord}<br>${statsLine}`;

    const rect = rectOf(el);
    tooltip.style.left = `${rect.left + rect.width / 2}px`;
    tooltip.style.top = `${rect.bottom + 8}px`;
    tooltip.style.transform = 'translateX(-50%)';
    tooltip.hidden = false;
  }
  function hideTooltip() { tooltip.hidden = true; }

  canvasWrap.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-building-id]');
    if (el && !el.contains(e.relatedTarget)) showTooltip(el);
  });
  canvasWrap.addEventListener('mouseout', e => {
    const el = e.target.closest('[data-building-id]');
    if (el && !el.contains(e.relatedTarget)) hideTooltip();
  });
  canvasWrap.addEventListener('focusin', e => {
    const el = e.target.closest('[data-building-id]');
    if (el) showTooltip(el);
  });
  canvasWrap.addEventListener('focusout', e => {
    const el = e.target.closest('[data-building-id]');
    if (el) hideTooltip();
  });

  /* ── Building stats ──
     One fetch-and-compute pass per building, run concurrently and each
     updating its own marker the moment it resolves — a slow/failed fetch
     for one building never holds up another's. */
  function findBuildingEl(buildingId) {
    return [...canvasWrap.querySelectorAll('.campus-building')]
      .find(el => el.dataset.buildingId === buildingId);
  }

  /**
   * Fetches every floor's status alongside its device roster and caches
   * both — this is the one place either is read from disk, so it's also
   * where statusCache gets filled in for floorIsFinal()/openFloorPicker()
   * above to read synchronously later. Only final floors count toward the
   * building's aggregate stats/status marker: a still-drafted floor isn't
   * inspection-facing yet, so its devices (real or not) must never shift a
   * building's has-issues/complete/in-progress read one way or the other.
   */
  async function populateBuildingStats(data) {
    const state = loadState();
    await Promise.all(data.buildings.map(async building => {
      const floors = building.floors.map(f => ({ ...f, roomId: canonicalRoomId(f.roomId) }));
      const roomDevices = {};
      await Promise.all(floors.map(async floor => {
        const [devices, status] = await Promise.all([
          fetchRoomDevices({ id: floor.roomId }),
          fetchRoomStatus({ id: floor.roomId }),
        ]);
        roomDevices[floor.roomId] = devices;
        statusCache.set(floor.roomId, status);
      }));
      const finalFloors = floors.filter(f => statusCache.get(f.roomId) === 'final');
      const stats = buildingStats(finalFloors, roomDevices, state);
      statsCache.set(building.id, stats);

      const el = findBuildingEl(building.id);
      const marker = el?.querySelector('.campus-building-status');
      if (marker) marker.dataset.state = buildingStatusKey(stats);
    }));
  }

  try {
    const res = await fetch('data/campus.json');
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    campusData = normalizeCampusData(await res.json());
    canvasWrap.innerHTML = buildingSvg(campusData);
    await populateBuildingStats(campusData);
  } catch (err) {
    canvasWrap.innerHTML = `<p class="campus-loading">Couldn't load campus data: ${escapeHTML(err.message)}</p>`;
  }
}
