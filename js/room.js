/**
 * room.js — the room page as a workstation: an always-visible inspector
 * panel (not a modal) drives ordinary device inspection, with Next
 * Unchecked, Inspection Mode, filters, search, zoom/pan, and keyboard
 * shortcuts all built on top of the same status/notes storage as before.
 *
 * Call initRoomPage(CFG) once CFG (metadata + layout + devices + the
 * project-wide assets.json lookup) is ready. Modals are reserved for
 * destructive/one-off actions (reset this room) — never for inspecting a
 * single device, which is what the inspector panel is for.
 */
import { loadState, saveState, stateKey } from './state.js';
import { formatDate } from './format.js';
import { exportRoom, exportAllRooms, ALL_ROOMS } from './export.js';
import {
  orderDevicesForInspection, findNextUnchecked, computeStats,
  matchesFilter, matchesSearch, buildSearchHaystack,
  computeContentBounds, computeFitScale as fitScaleFor, computeFitPan as fitPanFor,
} from './room-logic.js';

/**
 * Every device carries two independent fields (see state.js): an
 * inspectionState ('unchecked' | 'checked' | 'not-applicable') and, only
 * when checked, a condition ('working' | 'minor' | 'major'). Everywhere
 * in this file that needs a single display key collapses the two into
 * one of five "status keys" — 'working' | 'minor' | 'major' | 'unchecked'
 * | 'not-applicable' — via `statusKeyOf`/`changeFor` below. That
 * collapsed key is a rendering/UI convenience only; the stored shape
 * always keeps the two fields separate.
 */
const CONDITION_WORDS = { working: 'working', minor: 'minor issue', major: 'major issue' };

/** Spoken/written wording for every status key — one place, so the
 *  stats line and the screen-reader labels can never disagree. */
const STATUS_WORDS = {
  working: 'working',
  minor:   'minor issue',
  major:   'major issue',
  unchecked: 'not checked',
  'not-applicable': 'not applicable',
};

/** Status options the inspector offers — printers only ever have two
 *  meaningful conditions, same distinction the old per-kind popups made.
 *  "Not Applicable" and "Not Checked" (renamed from a generic "Clear" —
 *  each label matches exactly what the action does) are common to both. */
const PC_STATUS_OPTIONS = [
  { status: 'working', label: 'Working' },
  { status: 'minor',   label: 'Minor Issue' },
  { status: 'major',   label: 'Major Issue' },
  { status: 'not-applicable', label: 'Not Applicable' },
  { status: 'unchecked', label: 'Not Checked' },
];
const PRINTER_STATUS_OPTIONS = [
  { status: 'working', label: 'Working' },
  { status: 'major',   label: 'Not Working' },
  { status: 'not-applicable', label: 'Not Applicable' },
  { status: 'unchecked', label: 'Not Checked' },
];

/** Inspection Mode's choices — Working/Minor/Major apply a condition in
 *  one tap, same as the old Quick Mark; Not Applicable marks a device
 *  intentionally excluded without leaving the mode. There's no "reset to
 *  Not Checked" quick-action here on purpose — resetting a device is a
 *  correction, not something you do while sweeping the room, so it stays
 *  an inspector/keyboard-shortcut-only action (see applyChange). */
const MODE_STATUSES = [
  { status: 'working', label: 'Working' },
  { status: 'minor',   label: 'Minor' },
  { status: 'major',   label: 'Major' },
  { status: 'not-applicable', label: 'N/A' },
];

const FILTERS = [
  { key: 'all',            label: 'All' },
  { key: 'unchecked',      label: 'Unchecked' },
  { key: 'checked',        label: 'Checked' },
  { key: 'not-applicable', label: 'Not Applicable' },
  { key: 'working',        label: 'Working' },
  { key: 'minor',          label: 'Minor' },
  { key: 'major',          label: 'Major' },
  { key: 'notes',          label: 'Notes' },
];

const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
const PAN_DRAG_THRESHOLD = 3;
/** Small, consistent breathing room around a fit — not large empty
 *  padding. Screen-space px, mirrors --space-4 (16px). */
const FIT_MARGIN = 16;

/** No emoji anywhere in this file — every icon is either a plain
 *  typographic character already used elsewhere in the app (←, →, ↓, ↶,
 *  ↺) or one of these small flat outline SVGs, sized in `em` so they scale
 *  with whatever text they sit next to. `currentColor` means each one
 *  picks up its button's own text color for free — no new color values. */
const ICON_SEARCH = '<svg class="icon" width="1em" height="1em" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><line x1="9.8" y1="9.8" x2="14" y2="14" stroke-linecap="round"/></svg>';
const ICON_FULLSCREEN = '<svg class="icon" width="1em" height="1em" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1 5V1h4"/><path d="M11 1h4v4"/><path d="M15 11v4h-4"/><path d="M5 15H1v-4"/></svg>';

/** Ctrl on Windows/Linux, Cmd on Mac — for the wheel-zoom hint text only;
 *  the actual key check (e.ctrlKey || e.metaKey) accepts either regardless
 *  of platform, this is purely about which word to show. Guarded for
 *  environments (like the test suite) with no `navigator` at all. */
function zoomModifierLabel() {
  const platform = (typeof navigator !== 'undefined' && navigator.platform) || '';
  return /Mac|iPod|iPhone|iPad/.test(platform) ? 'Cmd' : 'Ctrl';
}

function escapeXML(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/** For anything interpolated into HTML text or an attribute value. */
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Builds floor-plan SVG from layout data; falls back to a plain <img> if no `layout` is given. */
function drawLayout(layout, w = 1200, h = 800) {
  const parts = [];

  const outline = layout.find(o => o.type === 'outline');
  if (outline) {
    const d = 'M' + outline.points.map(p => p.join(',')).join(' L') + ' Z';
    parts.push(`<path d="${d}" class="floor-outline"/>`);
  }

  layout.filter(o => o.type === 'floor').forEach(f => {
    parts.push(`<rect x="${f.x}" y="${f.y}" width="${f.width}" height="${f.height}" class="floor-fill"/>`);
  });

  layout.filter(o => o.type === 'wall').forEach(wl => {
    parts.push(`<line x1="${wl.x1}" y1="${wl.y1}" x2="${wl.x2}" y2="${wl.y2}" class="floor-wall"/>`);
  });

  // Rough centroid of the room(s), used to pick which side a door swings into.
  function layoutCenter() {
    const shapes = layout.filter(o => o.type === 'floor' || o.type === 'room');
    if (shapes.length) {
      let sx = 0, sy = 0;
      shapes.forEach(s => { sx += s.x + s.width / 2; sy += s.y + s.height / 2; });
      return [sx / shapes.length, sy / shapes.length];
    }
    if (outline) {
      let sx = 0, sy = 0;
      outline.points.forEach(p => { sx += p[0]; sy += p[1]; });
      return [sx / outline.points.length, sy / outline.points.length];
    }
    return [w / 2, h / 2];
  }

  // Door swing indicator: solid leaf (hinge → open tip) + dashed arc to the far jamb.
  layout.filter(o => o.type === 'door').forEach(dr => {
    if (dr.hinge && dr.jamb) {
      const [hx, hy] = dr.hinge;
      const [jx, jy] = dr.jamb;
      const dx = jx - hx, dy = jy - hy;
      const width = Math.sqrt(dx * dx + dy * dy);
      const ux = dx / width, uy = dy / width;

      const p1 = [-uy, ux], p2 = [uy, -ux];
      const [cx, cy] = layoutCenter();
      const toCenter = [cx - hx, cy - hy];
      const perp = (p1[0] * toCenter[0] + p1[1] * toCenter[1]) >= 0 ? p1 : p2;

      const tipX = hx + perp[0] * width;
      const tipY = hy + perp[1] * width;
      const sweepFlag = (ux * perp[1] - uy * perp[0]) > 0 ? 1 : 0;

      parts.push(`<line x1="${hx}" y1="${hy}" x2="${tipX}" y2="${tipY}" class="floor-door-leaf"/>`);
      parts.push(`<path d="M${tipX},${tipY} A${width},${width} 0 0 ${sweepFlag} ${jx},${jy}" class="floor-door-arc"/>`);
    } else {
      parts.push(`<line x1="${dr.x1}" y1="${dr.y1}" x2="${dr.x2}" y2="${dr.y2}" class="floor-door"/>`);
    }
  });

  layout.filter(o => o.type === 'room').forEach(r => {
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" class="floor-room"/>`);
    if (r.label) {
      parts.push(`<text x="${r.x + r.width / 2}" y="${r.y + r.height / 2}" class="floor-label" text-anchor="middle" dominant-baseline="middle">${escapeXML(r.label)}</text>`);
    }
  });

  layout.filter(o => o.type === 'entrance').forEach(r => {
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" class="floor-entrance"/>`);
    if (r.label) {
      parts.push(`<text x="${r.x + r.width / 2}" y="${r.y + r.height / 2}" class="floor-label floor-label-entrance" text-anchor="middle" dominant-baseline="middle">${escapeXML(r.label)}</text>`);
    }
  });

  layout.filter(o => o.type === 'counter').forEach(c => {
    parts.push(`<rect x="${c.x}" y="${c.y}" width="${c.width}" height="${c.height}" class="floor-counter"/>`);
  });

  layout.filter(o => o.type === 'wallrect').forEach(wr => {
    parts.push(`<rect x="${wr.x}" y="${wr.y}" width="${wr.width}" height="${wr.height}" class="floor-wallrect"/>`);
  });

  return `<svg class="room-bg-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${parts.join('')}</svg>`;
}

function buildFloorPlanHTML(cfg) {
  if (cfg.layout) return drawLayout(cfg.layout, cfg.canvasWidth || 1200, cfg.canvasHeight || 800);
  return `<img src="${escapeHTML(cfg.bgImage)}" class="room-bg" alt="${escapeHTML(cfg.label)} floor plan">`;
}

const deviceLabel = d => d.label || d.id;

/**
 * Devices are <button>s, not <div>s: they are then keyboard-reachable, get
 * Enter/Space activation and focus rings for free, and screen readers
 * announce them as controls rather than skipping them entirely.
 */
function buildDeviceHTML(devices) {
  return devices.map(d => {
    const id  = escapeHTML(d.id);
    const pos = `top:${Number(d.top) || 0}px;left:${Number(d.left) || 0}px`;

    if (d.type === 'printer') {
      return `<button type="button" class="printer" data-id="${id}" data-kind="printer" style="${pos}">
                <span class="printer-icon" aria-hidden="true">⎙</span> Printer
              </button>`;
    }

    const label = deviceLabel(d);
    const cls = ['pc'];
    if (d.type === 'staff') cls.push('staff');
    // Long IDs ("STAFF-PC") overflow the 42px chip — widen instead of clipping.
    if (label.length > 5) cls.push('wide');

    return `<button type="button" class="${cls.join(' ')}" data-id="${id}" data-kind="pc" style="${pos}">${escapeHTML(label)}</button>`;
  }).join('\n');
}

export function initRoomPage(CFG) {
  const roomId = CFG.id;
  const W = CFG.canvasWidth || 1200;
  const H = CFG.canvasHeight || 800;
  const assets = CFG.assets && typeof CFG.assets === 'object' ? CFG.assets : {};

  /** Read cache. Every *write* re-reads first (see `mutate`) so a second tab
   *  can't be rolled back by this page's stale snapshot. */
  let state = loadState();

  const deviceById = new Map(CFG.devices.map(d => [d.id, d]));
  const orderedDevices = orderDevicesForInspection(CFG.devices);
  /** The room's true drawn extent (walls/devices/labels), not just its
   *  nominal canvas size — see computeContentBounds in room-logic.js for
   *  why the two frequently differ. Computed once: layout/devices are
   *  fixed for the lifetime of this read-only page. */
  const contentBounds = computeContentBounds(CFG.layout, CFG.devices, W, H);

  document.title = `${CFG.label} — Gridkeep`;
  document.getElementById('room-root').innerHTML = `
    <div class="app workstation-app">

      <header>
        <div class="header-inner">
          <div class="header-title">
            <a href="${escapeHTML(CFG.back)}" class="back-btn">← Menu</a>
            <div>
              <h1>${escapeHTML(CFG.label)}</h1>
              <p class="campus-crumb">${escapeHTML(CFG.campus)}</p>
            </div>
          </div>
        </div>
        <div class="sweep">
          <div class="sweep-bar"><span class="sweep-fill" id="sweep-fill" style="width:0%"></span></div>
        </div>

        <div class="workstation-toolbar">
          <div class="toolbar-row toolbar-primary">
            <button type="button" class="btn-primary" id="btn-next-unchecked">→ Next Unchecked</button>
            <button type="button" class="toolbar-btn" id="btn-search">${ICON_SEARCH} Search <span class="kbd">/</span></button>

            <button type="button" class="toolbar-btn" id="btn-mode-toggle" aria-pressed="false">Inspection Mode</button>

            <button type="button" class="toolbar-btn" id="btn-filter-toggle" aria-expanded="false" aria-controls="filter-row">Filter</button>

            <div class="toolbar-spacer"></div>

            <div class="overflow-wrap" id="overflow-wrap">
              <button type="button" class="toolbar-btn" id="btn-more" aria-haspopup="true" aria-expanded="false" aria-label="More room actions">⋯</button>
              <div class="overflow-menu floating-panel" id="overflow-menu" role="menu" aria-label="Room actions" hidden>
                <button type="button" class="overflow-item" id="btn-undo" role="menuitem" disabled>↶ Undo</button>
                <button type="button" class="overflow-item" id="btn-export-room" role="menuitem">↓ Export This Room</button>
                <button type="button" class="overflow-item" id="btn-export-all" role="menuitem">↓ Export All Rooms</button>
                <button type="button" class="overflow-item" id="btn-reset" role="menuitem">↺ Reset This Room</button>
              </div>
            </div>

            <button type="button" class="toolbar-btn" id="btn-help" aria-label="Keyboard shortcuts" title="Keyboard shortcuts">?</button>
          </div>

          <div class="filter-row floating-panel" id="filter-row" role="group" aria-label="Filter devices" hidden>
            <span class="quick-mark-label">Filter</span>
            ${FILTERS.map(f => `
              <button type="button" class="filter-btn" data-filter="${f.key}" aria-pressed="${f.key === 'all'}">${f.label}</button>`).join('')}
          </div>
        </div>
      </header>

      <div class="workstation" id="workstation">
        <div class="floor-pane">
          <div class="room-viewport" id="room-viewport">
            <div class="room" id="room" style="width:${W}px;height:${H}px">
              ${buildFloorPlanHTML(CFG)}
              ${buildDeviceHTML(CFG.devices)}
            </div>

            <div class="zoom-controls" id="zoom-controls">
              <button type="button" class="toolbar-btn" id="zoom-out" aria-label="Zoom out">−</button>
              <button type="button" class="toolbar-btn" id="zoom-fit" aria-label="Fit to screen">Fit</button>
              <button type="button" class="toolbar-btn" id="zoom-100" aria-label="Actual size">100%</button>
              <button type="button" class="toolbar-btn" id="zoom-in" aria-label="Zoom in">+</button>
              <button type="button" class="toolbar-btn" id="zoom-fullscreen" aria-label="Fullscreen">${ICON_FULLSCREEN}</button>
              <span class="zoom-hint">${zoomModifierLabel()}+scroll to zoom</span>
            </div>
          </div>

          <p class="visually-hidden" role="status" aria-live="polite" id="room-live"></p>
        </div>

        <aside class="inspector-panel" id="inspector-panel" aria-label="Device inspector">
          <p class="quick-mark-label inspector-panel-label">Inspector</p>
          <div class="inspector-scroll">

            <!-- Inspection Mode's active UI — replaces the normal inspector
                 content below while armed; the toolbar's toggle button is
                 still the entry point (see setMode()). -->
            <div class="sidebar-mode" id="sidebar-mode" hidden>
              <div class="mode-group floating-panel" id="mode-group" role="group" aria-label="Inspection mode: mark status">
                <span class="quick-mark-label">Mark as</span>
                ${MODE_STATUSES.map(m => `
                  <button type="button" class="quick-btn" data-mode-status="${m.status}" aria-pressed="false">
                    <span class="status-dot ${m.status}"></span>${m.label}
                  </button>`).join('')}
              </div>
              <div class="mode-banner" id="mode-banner">
                <span class="mode-banner-text" id="mode-banner-text"></span>
                <button type="button" class="mode-banner-exit" id="btn-mode-exit" title="Exit Inspection Mode (Esc)">Exit</button>
              </div>
            </div>

            <div id="inspector-normal">
              <p class="inspector-empty" id="inspector-empty">Select a device to inspect it, or press <span class="kbd">→</span> for the next unchecked one.</p>
              <div class="inspector-content" id="inspector-content" hidden>
                <div class="inspector-head">
                  <h3 id="inspector-device-id"></h3>
                  <span class="save-status" id="save-status"></span>
                </div>
                <div class="status-grid" id="inspector-status-grid"></div>
                <div class="inspector-meta" id="inspector-meta"></div>
                <label class="notes-label" for="inspector-notes">Notes (optional)</label>
                <textarea id="inspector-notes" class="notes-input" rows="4" placeholder="Describe the issue…"></textarea>
                <p class="last-updated" id="inspector-last-updated"></p>
              </div>
            </div>

            <!-- Legend + stats — always available regardless of Inspector/
                 Inspection-Mode state, kept as its own clearly separate,
                 collapsible sub-section rather than blended into either. -->
            <div class="sidebar-legend" id="sidebar-legend">
              <button type="button" class="site-toggle sidebar-legend-toggle" id="btn-legend-toggle" aria-expanded="true" aria-controls="legend-stats-body"></button>
              <div class="legend-stats-body" id="legend-stats-body">
                <p class="room-stats" id="room-stats"></p>
                <div class="legend">
                  <div class="legend-item"><span class="dot working"></span>Working</div>
                  <div class="legend-item"><span class="dot minor"></span>Minor Issue</div>
                  <div class="legend-item"><span class="dot major"></span>Major Issue</div>
                  <div class="legend-item"><span class="dot unchecked"></span>Not Checked</div>
                  <div class="legend-item"><span class="dot not-applicable"></span>Not Applicable</div>
                  <div class="legend-item"><span class="dot has-notes"></span>Has a note</div>
                </div>
              </div>
            </div>

          </div>
        </aside>
      </div>

    </div>

    <!-- Search -->
    <div class="overlay" id="search-overlay" role="dialog" aria-modal="true" aria-labelledby="search-title">
      <div class="popup popup-search">
        <button class="popup-close" id="search-close" aria-label="Close">✕</button>
        <h3 class="popup-title" id="search-title">Search</h3>
        <input type="text" id="search-input" class="notes-input" placeholder="Device id, asset id, serial, manufacturer, notes…">
        <div class="search-results" id="search-results"></div>
      </div>
    </div>

    <!-- Keyboard shortcuts -->
    <div class="overlay" id="help-overlay" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <div class="popup">
        <button class="popup-close" id="help-close" aria-label="Close">✕</button>
        <h3 class="popup-title" id="help-title">Keyboard shortcuts</h3>
        <dl class="shortcut-list">
          <div><dt class="kbd">1</dt><dd>Mark selected device Working</dd></div>
          <div><dt class="kbd">2</dt><dd>Mark selected device Minor</dd></div>
          <div><dt class="kbd">3</dt><dd>Mark selected device Major</dd></div>
          <div><dt class="kbd">0</dt><dd>Reset selected device to Not Checked</dd></div>
          <div><dt class="kbd">N</dt><dd>Add/edit note on selected device</dd></div>
          <div><dt class="kbd">U</dt><dd>Undo last status change</dd></div>
          <div><dt class="kbd">→</dt><dd>Jump to next unchecked device</dd></div>
          <div><dt class="kbd">/</dt><dd>Search</dd></div>
          <div><dt class="kbd">F</dt><dd>Fit floor plan to screen</dd></div>
          <div><dt class="kbd">${zoomModifierLabel()}+scroll</dt><dd>Zoom the floor plan (plain scroll behaves normally)</dd></div>
          <div><dt class="kbd">Esc</dt><dd>Exit inspection mode / close menus and dialogs</dd></div>
        </dl>
      </div>
    </div>

    <!-- Reset confirmation -->
    <div class="overlay" id="reset-overlay" role="dialog" aria-modal="true" aria-labelledby="reset-popup-title">
      <div class="popup popup-sm">
        <h3 class="popup-title" id="reset-popup-title">Reset ${escapeHTML(CFG.label)}?</h3>
        <p class="popup-body">Clears all statuses and notes for this room only.</p>
        <div class="popup-actions">
          <button class="btn-danger"    id="reset-confirm">Yes, Reset</button>
          <button class="btn-secondary" id="reset-cancel">Cancel</button>
        </div>
      </div>
    </div>
  `;

  /* DOM refs */
  const room = document.getElementById('room');
  const viewport = document.getElementById('room-viewport');
  const liveEl = document.getElementById('room-live');
  const resetOverlay = document.getElementById('reset-overlay');
  const searchOverlay = document.getElementById('search-overlay');
  const helpOverlay = document.getElementById('help-overlay');
  const searchInput = document.getElementById('search-input');
  const searchResultsEl = document.getElementById('search-results');
  const modeBtns = document.querySelectorAll('#mode-group .quick-btn');
  const filterBtns = document.querySelectorAll('#filter-row .filter-btn');
  const modeBanner = document.getElementById('mode-banner');
  const modeBannerText = document.getElementById('mode-banner-text');
  const modeExitBtn = document.getElementById('btn-mode-exit');
  const modeToggleBtn = document.getElementById('btn-mode-toggle');
  const sidebarMode = document.getElementById('sidebar-mode');
  const inspectorNormal = document.getElementById('inspector-normal');
  const legendToggleBtn = document.getElementById('btn-legend-toggle');
  const legendStatsBody = document.getElementById('legend-stats-body');
  const filterToggleBtn = document.getElementById('btn-filter-toggle');
  const filterRow = document.getElementById('filter-row');
  const overflowWrap = document.getElementById('overflow-wrap');
  const moreBtn = document.getElementById('btn-more');
  const overflowMenu = document.getElementById('overflow-menu');
  const undoBtn = document.getElementById('btn-undo');
  const roomStatsEl = document.getElementById('room-stats');
  const sweepFillEl = document.getElementById('sweep-fill');
  const inspectorEmpty = document.getElementById('inspector-empty');
  const inspectorContent = document.getElementById('inspector-content');
  const inspectorDeviceIdEl = document.getElementById('inspector-device-id');
  const inspectorStatusGrid = document.getElementById('inspector-status-grid');
  const inspectorMetaEl = document.getElementById('inspector-meta');
  const inspectorNotesEl = document.getElementById('inspector-notes');
  const inspectorLastUpdated = document.getElementById('inspector-last-updated');
  const saveStatusEl = document.getElementById('save-status');
  const zoomOutBtn = document.getElementById('zoom-out');
  const zoomInBtn = document.getElementById('zoom-in');
  const zoomFitBtn = document.getElementById('zoom-fit');
  const zoom100Btn = document.getElementById('zoom-100');
  const zoomFullscreenBtn = document.getElementById('zoom-fullscreen');

  /** id → node, so repainting one device never re-scans the DOM. */
  const nodeById = new Map(
    [...room.querySelectorAll('[data-id]')].map(el => [el.dataset.id, el]),
  );

  let selectedDeviceId = null;
  let activeModeStatus = null;
  let activeFilter = 'all';
  let filterOpen = false;
  let lastFocused = null;
  let notesSaveTimer = null;
  let saveStatusTimer = null;
  let otherRoomsCache = null;
  const undoStack = [];

  const announce = msg => { liveEl.textContent = msg; };
  const entryFor = (id, ofRoomId = roomId) => state[stateKey(ofRoomId, id)];
  /** The collapsed 5-way display key described at the top of this file —
   *  shared by painting, the inspector, and cross-room search, so every
   *  surface derives it from an entry the exact same way. */
  const statusKeyFromEntry = entry => {
    const inspectionState = entry?.inspectionState || 'unchecked';
    return inspectionState === 'checked' ? (entry.condition || 'unchecked') : inspectionState;
  };
  const statusKeyOf = device => statusKeyFromEntry(entryFor(device.id));
  /** `{ inspectionState, condition }` for room-logic.js's two-field API. */
  const inspectionOf = device => {
    const entry = entryFor(device.id);
    return { inspectionState: entry?.inspectionState || 'unchecked', condition: entry?.condition ?? null };
  };
  /** Turns a status key (what a button/shortcut names) into the two-part
   *  change to store — the one place that mapping happens. */
  function changeFor(statusKey) {
    if (statusKey === 'not-applicable') return { inspectionState: 'not-applicable', condition: null };
    if (statusKey === 'unchecked') return { inspectionState: 'unchecked', condition: null };
    return { inspectionState: 'checked', condition: statusKey };
  }

  /* ── State writes ──────────────────────────────────────────────
     Re-read before merging: a checker often has two room tabs open, and the
     old code wrote back a snapshot taken at page load, silently reverting
     whatever the other tab had saved in the meantime. */
  function mutate(fn) {
    const fresh = loadState();
    fn(fresh);
    saveState(fresh);
    state = fresh;
  }

  /* ── Save-status indicator ────────────────────────────────────── */
  function flashSaveStatus() {
    saveStatusEl.textContent = 'Saving…';
    clearTimeout(saveStatusTimer);
    saveStatusTimer = setTimeout(() => { saveStatusEl.textContent = 'Saved'; }, 200);
  }

  /* ── Painting ──────────────────────────────────────────────── */

  function paint(deviceId) {
    const el = nodeById.get(deviceId);
    if (!el) return;
    const entry = entryFor(deviceId);
    const device = deviceById.get(deviceId);
    const status = statusKeyOf(device || { id: deviceId });
    const name = device ? deviceLabel(device) : deviceId;
    const kind = el.dataset.kind === 'printer' ? 'Printer ' : '';
    const note = entry?.notes ? ` — note: ${entry.notes}` : '';

    el.dataset.status = status;
    el.dataset.hasNotes = entry?.notes ? 'true' : 'false';
    el.setAttribute('aria-label', `${kind}${name}, ${STATUS_WORDS[status] || STATUS_WORDS.unchecked}${note}`);
    if (entry?.notes) el.setAttribute('title', entry.notes);
    else el.removeAttribute('title');
    applyFilterToNode(el);
  }

  function paintAll() {
    CFG.devices.forEach(d => paint(d.id));
  }

  function updateStatsUI() {
    const stats = computeStats(CFG.devices, inspectionOf);
    roomStatsEl.textContent =
      `${stats.total} devices · ${stats.inspected} inspected · ${stats.notApplicable} not applicable · ${stats.unchecked} remaining · ${stats.issues} issue${stats.issues === 1 ? '' : 's'}`;
    sweepFillEl.style.width = stats.total ? `${((stats.inspected + stats.notApplicable) / stats.total) * 100}%` : '0%';
  }

  /* ── Entry writes ──────────────────────────────────────────── */

  /** The one place any device entry is written — a fresh device (no
   *  entry yet) and an untouched-since-reset device (inspectionState
   *  'unchecked' with no notes) both collapse to "no localStorage row",
   *  matching the "no entry = unchecked" convention untouched devices
   *  have always used; a note always keeps the row alive so it isn't
   *  lost under a reset-to-unchecked. */
  function saveEntry(deviceId, change) {
    const key = stateKey(roomId, deviceId);
    const notes = entryFor(deviceId)?.notes || '';
    mutate(s => {
      if (change.inspectionState === 'unchecked' && !notes) delete s[key];
      else s[key] = { inspectionState: change.inspectionState, condition: change.condition ?? null, notes, updatedAt: new Date().toISOString() };
    });
    paint(deviceId);
    updateStatsUI();
  }

  function resetRoom() {
    mutate(s => { CFG.devices.forEach(({ id }) => delete s[stateKey(roomId, id)]); });
    undoStack.length = 0;
    refreshUndo();
    paintAll();
    updateStatsUI();
    if (selectedDeviceId) renderInspector();
    flashSaveStatus();
    announce(`${CFG.label} reset`);
  }

  function describeChange(change) {
    if (change.inspectionState === 'not-applicable') return 'marked not applicable';
    if (change.inspectionState === 'unchecked') return 'reset to not checked';
    return `marked ${CONDITION_WORDS[change.condition] || change.condition}`;
  }

  /** The one place any inspection-state/condition change goes through —
   *  Inspection Mode clicks, inspector status buttons, and keyboard
   *  shortcuts (1/2/3/0) all call this, so Undo always sees every kind
   *  of change regardless of how it was made. */
  function applyChange(deviceId, change, opts = {}) {
    undoStack.push({ deviceId, previous: entryFor(deviceId) ?? null });
    refreshUndo();
    saveEntry(deviceId, change);
    if (!opts.silent) announce(`${deviceId} ${describeChange(change)}`);
    flashSaveStatus();
    if (selectedDeviceId === deviceId) renderInspector({ keepFocus: true });
  }

  function undoLast() {
    const last = undoStack.pop();
    refreshUndo();
    if (!last) return;
    if (last.previous) {
      mutate(s => { s[stateKey(roomId, last.deviceId)] = last.previous; });
    } else {
      mutate(s => { delete s[stateKey(roomId, last.deviceId)]; });
    }
    paint(last.deviceId);
    updateStatsUI();
    flashSaveStatus();
    if (selectedDeviceId === last.deviceId) renderInspector({ keepFocus: true });
    announce(`Undid ${last.deviceId}`);
  }

  function refreshUndo() {
    undoBtn.disabled = undoStack.length === 0;
    undoBtn.textContent = undoStack.length ? `↶ Undo (${undoStack.length})` : '↶ Undo';
  }

  /* ── Notes ─────────────────────────────────────────────────── */

  function saveNotesNow(deviceId, notes) {
    const key = stateKey(roomId, deviceId);
    const entry = entryFor(deviceId);
    const inspectionState = entry?.inspectionState || 'unchecked';
    const condition = inspectionState === 'checked' ? (entry?.condition ?? null) : null;
    mutate(s => {
      if (inspectionState === 'unchecked' && !notes) delete s[key];
      else s[key] = { inspectionState, condition, notes, updatedAt: new Date().toISOString() };
    });
    paint(deviceId);
    updateStatsUI();
    flashSaveStatus();
  }

  function scheduleNotesSave(deviceId, notes) {
    clearTimeout(notesSaveTimer);
    saveStatusEl.textContent = 'Saving…';
    notesSaveTimer = setTimeout(() => saveNotesNow(deviceId, notes), 400);
  }

  function flushNotesSave() {
    if (!notesSaveTimer || !selectedDeviceId) return;
    clearTimeout(notesSaveTimer);
    notesSaveTimer = null;
    saveNotesNow(selectedDeviceId, inspectorNotesEl.value.trim());
  }

  /* ── Inspection Mode (build on Quick Mark) ───────────────────────
     Collapsed to a single toggle button in the toolbar when off; clicking
     it arms Working (the common case) — the toggle button itself stays
     visible and switches to its pressed look (rather than disappearing),
     so there's always a visible, clickable trace of how you got into the
     mode and how to leave it from the toolbar itself. Its active UI (the
     Working/Minor/Major/N/A picker + the "marking X" banner and its own
     Exit button) renders in the sidebar, replacing the normal device
     inspector while armed — clicking a device applies a status directly
     without ever selecting/opening the inspector (see the room click
     handler below), so there's nothing useful for the normal inspector to
     show during this mode anyway. Clicking the already-active picker
     button again, the toggle again, the banner's own Exit button, or Esc
     all turn it off the same way and hand the sidebar back to the normal
     inspector. */

  function setMode(status) {
    activeModeStatus = status;
    modeBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.modeStatus === status)));
    room.classList.toggle('quick-mode', !!status);
    if (status) room.dataset.quick = status; else delete room.dataset.quick;
    modeToggleBtn.setAttribute('aria-pressed', String(!!status));
    sidebarMode.hidden = !status;
    inspectorNormal.hidden = !!status;
    if (status) {
      modeBanner.dataset.status = status;
      modeBannerText.textContent = `INSPECTION MODE — marking ${STATUS_WORDS[status]}. Click a device to apply.`;
    }
    announce(status ? `Inspection mode on: ${STATUS_WORDS[status]}` : 'Inspection mode off');
  }

  /* ── Sidebar Legend + Stats — its own collapsible sub-section, always
     available regardless of Inspector/Inspection-Mode state. Same
     disclosure convention as menu.js's site-toggle ("Hide Rooms ▴" /
     "View Rooms ▾"): the button's own label carries the open/closed
     state, not just aria-expanded. */
  function setLegendOpen(open) {
    legendStatsBody.hidden = !open;
    legendToggleBtn.setAttribute('aria-expanded', String(open));
    legendToggleBtn.textContent = open ? 'Legend & Stats ▴' : 'Legend & Stats ▾';
  }

  /* ── Filters (fade, never hide — spatial context stays intact) ──
     Collapsed behind a toggle button; picking "All" also collapses it
     back, since that's the "I'm done filtering" choice. The toggle
     button's own label shows the active filter even while collapsed, so
     a filter left on doesn't get forgotten. */

  function setFilterOpen(open) {
    filterOpen = open;
    filterRow.hidden = !open;
    filterToggleBtn.setAttribute('aria-expanded', String(open));
  }

  function updateFilterToggleLabel() {
    const active = FILTERS.find(f => f.key === activeFilter);
    filterToggleBtn.textContent = activeFilter === 'all' ? 'Filter' : `Filter: ${active ? active.label : activeFilter}`;
  }

  function applyFilterToNode(el) {
    const id = el.dataset.id;
    const device = deviceById.get(id);
    if (!device) return;
    const entry = entryFor(id);
    const { inspectionState, condition } = inspectionOf(device);
    const match = matchesFilter(inspectionState, condition, !!entry?.notes, activeFilter);
    el.classList.toggle('filtered-out', !match);
  }

  function applyFilterToAll() {
    nodeById.forEach(el => applyFilterToNode(el));
  }

  function setFilter(key) {
    activeFilter = key;
    filterBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === key)));
    applyFilterToAll();
    updateFilterToggleLabel();
    if (key === 'all') setFilterOpen(false);
  }

  /* ── Inspector panel ──────────────────────────────────────────── */

  function statusOptionsFor(device) {
    return device.type === 'printer' ? PRINTER_STATUS_OPTIONS : PC_STATUS_OPTIONS;
  }

  function renderInspector(opts = {}) {
    const device = selectedDeviceId && deviceById.get(selectedDeviceId);
    if (!device) {
      inspectorEmpty.hidden = false;
      inspectorContent.hidden = true;
      return;
    }
    inspectorEmpty.hidden = true;
    inspectorContent.hidden = false;

    const entry = entryFor(device.id);
    const status = statusKeyOf(device);

    inspectorDeviceIdEl.textContent = `${roomId} › ${deviceLabel(device)}`;

    inspectorStatusGrid.innerHTML = statusOptionsFor(device).map(opt => `
      <button type="button" class="status-btn${opt.status === status ? ' selected' : ''}" data-status="${opt.status}">
        <span class="status-dot ${opt.status}"></span>${opt.label}
      </button>`).join('');
    inspectorStatusGrid.querySelectorAll('.status-btn').forEach(btn => {
      btn.addEventListener('click', () => applyChange(device.id, changeFor(btn.dataset.status)));
    });

    const assetRecord = device.assetId ? assets[device.assetId] : null;
    const metaRows = [];
    if (device.assetId) metaRows.push(`<div><span>Asset ID</span><span class="mono">${escapeHTML(device.assetId)}</span></div>`);
    if (assetRecord?.manufacturer) metaRows.push(`<div><span>Manufacturer</span><span>${escapeHTML(assetRecord.manufacturer)}</span></div>`);
    if (assetRecord?.serial) metaRows.push(`<div><span>Serial</span><span class="mono">${escapeHTML(assetRecord.serial)}</span></div>`);
    inspectorMetaEl.innerHTML = metaRows.join('');
    inspectorMetaEl.hidden = metaRows.length === 0;

    if (document.activeElement !== inspectorNotesEl) inspectorNotesEl.value = entry?.notes || '';
    inspectorLastUpdated.textContent = entry?.updatedAt ? `Updated ${formatDate(entry.updatedAt)}` : '';
    // Only a *fresh* selection resets the save-status text — re-renders
    // triggered by applyChange/undo must leave whatever flashSaveStatus()
    // just set (e.g. "Saving…") alone, or it'd be overwritten instantly.
    if (opts.resetSaveStatus) saveStatusEl.textContent = 'Saved';

    if (opts.focusStatus) {
      const btn = inspectorStatusGrid.querySelector('.status-btn.selected') || inspectorStatusGrid.querySelector('.status-btn');
      btn?.focus();
    } else if (opts.keepFocus) {
      // leave focus wherever it already is (e.g. mid-typing in notes)
    }
  }

  /** The one place selection happens — every entry point (a plain click,
   *  Next Unchecked, a search result) ends up here. */
  function selectDevice(deviceId, opts = {}) {
    if (selectedDeviceId && selectedDeviceId !== deviceId) flushNotesSave();
    if (selectedDeviceId) nodeById.get(selectedDeviceId)?.classList.remove('selected');
    selectedDeviceId = deviceId;
    nodeById.get(deviceId)?.classList.add('selected');
    renderInspector({ focusStatus: opts.focusStatus !== false, resetSaveStatus: true });
  }

  /* ── Zoom / pan — a view transform only; device coordinates never change ── */
  let view = { scale: 1, x: 0, y: 0 };

  function clampScale(s) { return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)); }

  function computeFitScale() {
    const vw = viewport.clientWidth || W, vh = viewport.clientHeight || H;
    return fitScaleFor(contentBounds, vw, vh, FIT_MARGIN);
  }

  function clampPanAxis(pos, scaledSize, viewSize) {
    if (scaledSize <= viewSize) return 0;
    return Math.min(0, Math.max(viewSize - scaledSize, pos));
  }

  function clampPan(x, y, scale) {
    const vw = viewport.clientWidth || W, vh = viewport.clientHeight || H;
    return {
      x: clampPanAxis(x, W * scale, vw),
      y: clampPanAxis(y, H * scale, vh),
    };
  }

  function applyView() {
    room.style.transformOrigin = 'top left';
    room.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  }

  function setView(scale, x, y) {
    view.scale = clampScale(scale);
    const clamped = clampPan(x, y, view.scale);
    view.x = clamped.x;
    view.y = clamped.y;
    applyView();
  }

  function zoomAt(viewportX, viewportY, newScale) {
    newScale = clampScale(newScale);
    const roomX = (viewportX - view.x) / view.scale;
    const roomY = (viewportY - view.y) / view.scale;
    setView(newScale, viewportX - roomX * newScale, viewportY - roomY * newScale);
  }

  function zoomByFactor(factor) {
    const vw = viewport.clientWidth || W, vh = viewport.clientHeight || H;
    zoomAt(vw / 2, vh / 2, view.scale * factor);
  }

  /**
   * True maximum contain-fit: centers the room's actual content bounding
   * box (not its raw (0,0) canvas origin) in the viewport at the largest
   * scale that fits. This deliberately bypasses setView()/clampPan() — that
   * clamp is calibrated to the full nominal canvas size (W×H) for ordinary
   * interactive pan/zoom, and would fight a deliberately off-(0,0) centered
   * pan for a room whose content doesn't start at the canvas origin (true
   * of every real room but one — see computeContentBounds).
   */
  function fitToScreen() {
    const vw = viewport.clientWidth || W, vh = viewport.clientHeight || H;
    const scale = clampScale(computeFitScale());
    const { x, y } = fitPanFor(contentBounds, vw, vh, scale);
    view.scale = scale;
    view.x = x;
    view.y = y;
    applyView();
  }
  function actualSize() { setView(1, 0, 0); }

  /** Approximate chip center — good enough to center a device on screen;
   *  exact chip size varies by type/label and isn't worth tracking here. */
  function deviceCenter(device) {
    return [(Number(device.left) || 0) + 21, (Number(device.top) || 0) + 21];
  }

  /**
   * Shared by every entry point that needs to bring a possibly-off-screen
   * device into view: Next Unchecked and search results. A plain click
   * doesn't need this — the device was already visible, or it wouldn't
   * have been clickable.
   */
  function focusDevice(deviceId, opts = {}) {
    const device = deviceById.get(deviceId);
    if (!device) return;
    const vw = viewport.clientWidth || W, vh = viewport.clientHeight || H;
    const targetScale = Math.max(view.scale, Math.min(1, computeFitScale() * 1.4));
    const [cx, cy] = deviceCenter(device);
    setView(targetScale, vw / 2 - cx * targetScale, vh / 2 - cy * targetScale);
    if (opts.select !== false) selectDevice(deviceId, opts);
  }

  /* ── Next Unchecked ───────────────────────────────────────────── */

  function goToNextUnchecked() {
    const next = findNextUnchecked(orderedDevices, d => inspectionOf(d).inspectionState === 'unchecked', selectedDeviceId);
    if (!next) { announce('Every device is inspected.'); return; }
    focusDevice(next.id);
  }

  /* ── Search (in-room + other rooms) ──────────────────────────── */

  async function loadOtherRooms() {
    if (otherRoomsCache) return otherRoomsCache;
    const others = ALL_ROOMS.filter(r => r.id !== roomId);
    const loaded = await Promise.all(others.map(async r => {
      const stem = String(r.id).toLowerCase();
      try {
        const res = await fetch(`../data/${stem}.json`);
        if (!res.ok) return null;
        const data = await res.json();
        return { id: r.id, label: r.label, stem, devices: Array.isArray(data.devices) ? data.devices : [] };
      } catch {
        return null;
      }
    }));
    otherRoomsCache = loaded.filter(Boolean);
    return otherRoomsCache;
  }

  function searchIndex(rooms) {
    const rows = [];
    const indexRoom = (rid, rlabel, stem, devices) => {
      devices.forEach(d => {
        const entry = state[stateKey(rid, d.id)];
        const statusWord = STATUS_WORDS[statusKeyFromEntry(entry)];
        const assetRecord = d.assetId ? assets[d.assetId] : null;
        const haystack = buildSearchHaystack({
          roomId: rid, roomLabel: rlabel, device: d,
          statusWord, notes: entry?.notes, assetRecord,
        });
        rows.push({ roomId: rid, roomLabel: rlabel, stem, device: d, haystack, sameRoom: rid === roomId });
      });
    };
    indexRoom(roomId, CFG.label, null, CFG.devices);
    rooms.forEach(r => indexRoom(r.id, r.label, r.stem, r.devices));
    return rows;
  }

  function renderSearchResults(query) {
    const rows = searchIndex(otherRoomsCache || []);
    const matches = query.trim() ? rows.filter(r => matchesSearch(r.haystack, query)).slice(0, 30) : [];
    if (!query.trim()) {
      searchResultsEl.innerHTML = '<p class="search-hint">Type to search devices across every room.</p>';
      return;
    }
    if (!matches.length) {
      searchResultsEl.innerHTML = '<p class="search-hint">No matches.</p>';
      return;
    }
    searchResultsEl.innerHTML = matches.map((m, i) => `
      <button type="button" class="search-result" data-index="${i}">
        <span class="search-result-device">${escapeHTML(deviceLabel(m.device))}</span>
        <span class="search-result-room">${escapeHTML(m.roomLabel)}</span>
      </button>`).join('');
    searchResultsEl.querySelectorAll('.search-result').forEach(btn => {
      btn.addEventListener('click', () => selectSearchResult(matches[Number(btn.dataset.index)]));
    });
  }

  function selectSearchResult(match) {
    closeSearch();
    if (!match.sameRoom) {
      window.location.href = `../rooms/${match.stem}.html?focus=${encodeURIComponent(match.device.id)}`;
      return;
    }
    focusDevice(match.device.id);
  }

  function openSearch() {
    openOverlay(searchOverlay, searchInput);
    searchInput.value = '';
    renderSearchResults('');
    loadOtherRooms().then(() => renderSearchResults(searchInput.value));
  }
  function closeSearch() { closeOverlay(searchOverlay); }

  searchInput?.addEventListener('input', () => renderSearchResults(searchInput.value));

  /* ── Overlays + focus ──────────────────────────────────────────
     Focus is moved into the dialog on open and returned to whatever
     opened it on close. Reserved for reset confirmation, search, and the
     shortcuts help — never for ordinary device inspection. */

  function focusables(overlay) {
    return [...overlay.querySelectorAll('button, textarea, [href], input, select')]
      .filter(el => !el.disabled);
  }

  function openOverlay(overlay, focusEl) {
    lastFocused = document.activeElement;
    overlay.classList.add('open');
    (focusEl || focusables(overlay)[0])?.focus?.();
  }

  function closeOverlay(overlay) {
    if (!overlay.classList.contains('open')) return;
    overlay.classList.remove('open');
    if (lastFocused?.isConnected) lastFocused.focus?.();
    lastFocused = null;
  }

  function trapTab(e, overlay) {
    if (e.key !== 'Tab') return;
    const items = focusables(overlay);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  [resetOverlay, searchOverlay, helpOverlay].forEach(o =>
    o.addEventListener('keydown', e => trapTab(e, o)));

  /* ── Events ────────────────────────────────────────────────── */

  // One delegated listener instead of one per device.
  room.addEventListener('click', e => {
    const el = e.target.closest?.('[data-id]');
    if (!el || !room.contains(el)) return;
    const deviceId = el.dataset.id;
    if (activeModeStatus) { applyChange(deviceId, changeFor(activeModeStatus)); return; }
    selectDevice(deviceId);
  });

  modeToggleBtn.addEventListener('click', () => setMode(activeModeStatus ? null : 'working'));
  modeBtns.forEach(btn => btn.addEventListener('click', () => {
    setMode(activeModeStatus === btn.dataset.modeStatus ? null : btn.dataset.modeStatus);
  }));
  modeExitBtn.addEventListener('click', () => setMode(null));

  filterToggleBtn.addEventListener('click', () => setFilterOpen(!filterOpen));
  filterBtns.forEach(btn => btn.addEventListener('click', () => setFilter(btn.dataset.filter)));

  legendToggleBtn.addEventListener('click', () => setLegendOpen(legendStatsBody.hidden));

  function setOverflowOpen(open) {
    overflowMenu.hidden = !open;
    moreBtn.setAttribute('aria-expanded', String(open));
  }
  moreBtn.addEventListener('click', () => setOverflowOpen(overflowMenu.hidden));
  overflowMenu.addEventListener('click', e => { if (e.target.closest('button')) setOverflowOpen(false); });
  document.addEventListener('click', e => {
    if (!overflowMenu.hidden && !overflowWrap.contains(e.target)) setOverflowOpen(false);
  });

  document.getElementById('btn-next-unchecked').addEventListener('click', goToNextUnchecked);
  undoBtn.addEventListener('click', undoLast);

  inspectorNotesEl.addEventListener('input', () => {
    if (selectedDeviceId) scheduleNotesSave(selectedDeviceId, inspectorNotesEl.value.trim());
  });
  inspectorNotesEl.addEventListener('blur', flushNotesSave);

  zoomOutBtn.addEventListener('click', () => zoomByFactor(0.8));
  zoomInBtn.addEventListener('click', () => zoomByFactor(1.25));
  zoomFitBtn.addEventListener('click', fitToScreen);
  zoom100Btn.addEventListener('click', actualSize);
  zoomFullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else viewport.requestFullscreen?.();
  });

  // Plain wheel scroll over the floor plan behaves like normal page scroll
  // (we don't touch the event at all) — zoom only kicks in with Ctrl/Cmd
  // held, matching the browser's own "zoom the page" gesture so it never
  // hijacks an ordinary scroll.
  viewport.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, view.scale * factor);
  }, { passive: false });

  let panDrag = null;
  viewport.addEventListener('pointerdown', e => {
    if (e.target.closest?.('[data-id]')) return;
    if (e.button !== undefined && e.button !== 0) return;
    panDrag = { startX: e.clientX, startY: e.clientY, origX: view.x, origY: view.y, moved: false };
  });
  window.addEventListener('pointermove', e => {
    if (!panDrag) return;
    const dx = e.clientX - panDrag.startX, dy = e.clientY - panDrag.startY;
    if (Math.hypot(dx, dy) > PAN_DRAG_THRESHOLD) panDrag.moved = true;
    if (!panDrag.moved) return;
    setView(view.scale, panDrag.origX + dx, panDrag.origY + dy);
  });
  window.addEventListener('pointerup', () => { panDrag = null; });

  document.getElementById('btn-search').addEventListener('click', openSearch);
  document.getElementById('search-close').addEventListener('click', closeSearch);
  searchOverlay.addEventListener('click', e => { if (e.target === searchOverlay) closeSearch(); });

  document.getElementById('btn-help').addEventListener('click', () => openOverlay(helpOverlay));
  document.getElementById('help-close').addEventListener('click', () => closeOverlay(helpOverlay));
  helpOverlay.addEventListener('click', e => { if (e.target === helpOverlay) closeOverlay(helpOverlay); });

  document.getElementById('btn-reset').addEventListener('click', () => openOverlay(resetOverlay));
  document.getElementById('reset-confirm').addEventListener('click', () => { resetRoom(); closeOverlay(resetOverlay); });
  document.getElementById('reset-cancel').addEventListener('click', () => closeOverlay(resetOverlay));
  resetOverlay.addEventListener('click', e => { if (e.target === resetOverlay) closeOverlay(resetOverlay); });

  document.getElementById('btn-export-room').addEventListener('click', () => exportRoom(roomId, CFG.label, { devices: CFG.devices }));
  document.getElementById('btn-export-all').addEventListener('click', () => exportAllRooms({ dataUrlFor: stem => `../data/${stem}.json` }));

  document.addEventListener('keydown', e => {
    if (e.key === '?') { e.preventDefault(); openOverlay(helpOverlay); return; }
    if ((e.key === '/' && !e.ctrlKey && !e.metaKey) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if (typing) return;
      e.preventDefault();
      openSearch();
      return;
    }
    if (e.key === 'Escape') {
      const anyOpen = [resetOverlay, searchOverlay, helpOverlay].some(o => o.classList.contains('open'));
      if (anyOpen) { closeOverlay(resetOverlay); closeSearch(); closeOverlay(helpOverlay); }
      else if (!overflowMenu.hidden) setOverflowOpen(false);
      else if (filterOpen) setFilterOpen(false);
      else if (activeModeStatus) setMode(null);
      return;
    }

    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (typing) return;

    if (e.key === 'ArrowRight') { e.preventDefault(); goToNextUnchecked(); return; }
    if (e.key.toLowerCase() === 'f') { e.preventDefault(); fitToScreen(); return; }
    if (e.key.toLowerCase() === 'u') { e.preventDefault(); undoLast(); return; }
    if (!selectedDeviceId) return;
    if (e.key === '1') { e.preventDefault(); applyChange(selectedDeviceId, changeFor('working')); return; }
    if (e.key === '2') { e.preventDefault(); applyChange(selectedDeviceId, changeFor('minor')); return; }
    if (e.key === '3') { e.preventDefault(); applyChange(selectedDeviceId, changeFor('major')); return; }
    if (e.key === '0') { e.preventDefault(); applyChange(selectedDeviceId, changeFor('unchecked')); return; }
    if (e.key.toLowerCase() === 'n') { e.preventDefault(); inspectorNotesEl.focus(); return; }
  });

  // Another tab saved something — pick it up instead of showing stale colours.
  window.addEventListener('storage', () => {
    state = loadState();
    paintAll();
    updateStatsUI();
    if (selectedDeviceId) renderInspector({ keepFocus: true });
  });

  window.addEventListener('resize', () => {
    if (view.scale === computeFitScale()) fitToScreen();
    else setView(view.scale, view.x, view.y);
  });
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => setView(view.scale, view.x, view.y)).observe(viewport);
  }

  paintAll();
  applyFilterToAll();
  updateStatsUI();
  refreshUndo();
  renderInspector();
  setLegendOpen(true);
  fitToScreen();

  const focusParam = new URLSearchParams(window.location.search).get('focus');
  if (focusParam && deviceById.has(focusParam)) {
    focusDevice(focusParam);
    if (window.history?.replaceState) {
      const url = new URL(window.location.href);
      url.searchParams.delete('focus');
      window.history.replaceState(null, '', url);
    }
  } else if (typeof requestAnimationFrame === 'function') {
    // The synchronous fitToScreen() above can run before the browser has
    // actually laid out the DOM just injected — viewport.clientWidth may
    // still read 0 at that exact point, which computeFitScale() silently
    // treats as "no room, use scale 1" instead of a true fit. Re-running
    // it one frame later, once layout has definitely settled, corrects
    // that without disturbing anything the user's done since. Skipped
    // entirely when a ?focus= param is about to pan/zoom to a specific
    // device instead, so this never fights that.
    requestAnimationFrame(() => fitToScreen());
  }
}
