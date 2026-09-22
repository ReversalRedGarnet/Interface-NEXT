/**
 * room.js — everything needed to render and drive a single room page.
 * Call initRoomPage(CFG) once CFG (metadata + layout + devices) is ready.
 *
 * Interface: one function. Everything a caller needs to know is that CFG
 * carries { id, label, campus, back, canvasWidth, canvasHeight, layout,
 * devices } and that #room-root exists. Statuses, notes, keyboard access,
 * scaling and persistence all sit behind that.
 */
import { loadState, saveState, stateKey } from './state.js';
import { formatDate } from './format.js';
import { exportRoom, exportAllRooms } from './export.js';

/** Spoken/written status wording — one place, so the map, the pills and the
 *  screen-reader labels can never disagree with each other. */
const STATUS_WORDS = {
  working: 'working',
  minor:   'minor issue',
  major:   'major issue',
  unknown: 'not checked',
};

/** Statuses an intern can apply with one tap in quick-mark mode. */
const QUICK_STATUSES = [
  { status: 'working', label: 'Working' },
  { status: 'minor',   label: 'Minor'   },
  { status: 'major',   label: 'Major'   },
  { status: 'clear',   label: 'Clear'   },
];

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

  layout.filter(o => o.type === 'pillar').forEach(p => {
    parts.push(`<circle cx="${p.cx}" cy="${p.cy}" r="${p.r}" class="floor-pillar"/>`);
    const k = p.r * 0.7;
    parts.push(`<line x1="${p.cx - k}" y1="${p.cy - k}" x2="${p.cx + k}" y2="${p.cy + k}" class="floor-pillar-mark"/>`);
    parts.push(`<line x1="${p.cx - k}" y1="${p.cy + k}" x2="${p.cx + k}" y2="${p.cy - k}" class="floor-pillar-mark"/>`);
    if (p.label) parts.push(`<title>${escapeXML(p.label)}</title>`);
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

  /** Read cache. Every *write* re-reads first (see `mutate`) so a second tab
   *  can't be rolled back by this page's stale snapshot. */
  let state = loadState();

  const deviceById = new Map(CFG.devices.map(d => [d.id, d]));

  document.title = `${CFG.label} — Room Monitor`;
  document.getElementById('room-root').innerHTML = `
    <div class="app">

      <header>
        <div class="header-inner">
          <div class="header-title">
            <a href="${escapeHTML(CFG.back)}" class="back-btn">← Menu</a>
            <span class="header-icon">⬡</span>
            <div>
              <h1>${escapeHTML(CFG.label)}</h1>
              <p class="campus-crumb">${escapeHTML(CFG.campus)}</p>
            </div>
          </div>
          <div class="status-summary">
            <span class="summary-pill working"   id="count-working">0 Working</span>
            <span class="summary-pill minor"     id="count-minor">0 Minor</span>
            <span class="summary-pill major"     id="count-major">0 Major</span>
            <span class="summary-pill unchecked" id="count-unchecked">0 unchecked</span>
          </div>
        </div>
        <div class="sweep">
          <div class="sweep-bar"><span class="sweep-fill" id="sweep-fill" style="width:0%"></span></div>
          <p class="subtitle" id="sweep-text">Tap a device to update it — or pick a status under Quick mark and tap straight through the room.</p>
        </div>
      </header>

      <div class="toolbar">
        <div class="quick-mark" id="quick-mark" role="group" aria-label="Quick mark">
          <span class="quick-mark-label">Quick mark</span>
          ${QUICK_STATUSES.map(q => `
            <button type="button" class="quick-btn" data-status="${q.status}" aria-pressed="false">
              ${q.status === 'clear' ? '' : `<span class="status-dot ${q.status}"></span>`}${q.label}
            </button>`).join('')}
        </div>
        <button class="toolbar-btn" id="btn-undo" disabled>↶ Undo</button>
        <button class="toolbar-btn" id="btn-zoom">⤢ Actual size</button>
        <button class="toolbar-btn" id="btn-export-room">⬇ Export This Room</button>
        <button class="toolbar-btn" id="btn-export-all">⬇ Export All Rooms</button>
        <button class="toolbar-btn" id="btn-reset">↺ Reset This Room</button>
      </div>

      <div class="room-viewport" id="room-viewport">
        <div class="room" id="room" style="width:${W}px;height:${H}px">
          ${buildFloorPlanHTML(CFG)}
          ${buildDeviceHTML(CFG.devices)}
        </div>
      </div>

      <p class="visually-hidden" role="status" aria-live="polite" id="room-live"></p>

      <div class="legend">
        <div class="legend-item"><span class="dot working"></span>Working</div>
        <div class="legend-item"><span class="dot minor"></span>Minor Issue</div>
        <div class="legend-item"><span class="dot major"></span>Major Issue</div>
        <div class="legend-item"><span class="dot unknown"></span>Unknown</div>
        <div class="legend-item"><span class="dot has-notes"></span>Has a note</div>
      </div>

    </div>

    <!-- PC popup -->
    <div class="overlay" id="pc-overlay" role="dialog" aria-modal="true" aria-labelledby="pc-popup-title">
      <div class="popup">
        <button class="popup-close" id="pc-close" aria-label="Close">✕</button>
        <h3 class="popup-title" id="pc-popup-title">Update Status</h3>
        <p class="popup-id" id="popup-id"></p>
        <div class="status-grid">
          <button class="status-btn" data-status="working"><span class="status-dot working"></span>Working</button>
          <button class="status-btn" data-status="minor"><span class="status-dot minor"></span>Minor Issue</button>
          <button class="status-btn" data-status="major"><span class="status-dot major"></span>Major Issue</button>
          <button class="status-btn" data-status="unknown"><span class="status-dot unknown"></span>Unknown</button>
        </div>
        <label class="notes-label" for="pc-notes">Notes (optional)</label>
        <textarea id="pc-notes" class="notes-input" rows="3" placeholder="Describe the issue…"></textarea>
        <p class="last-updated" id="pc-last-updated"></p>
        <div class="popup-actions">
          <button class="btn-primary" id="pc-save">Save</button>
          <button class="btn-secondary" id="pc-cancel">Cancel</button>
        </div>
      </div>
    </div>

    <!-- Printer popup -->
    <div class="overlay" id="printer-overlay" role="dialog" aria-modal="true" aria-labelledby="printer-popup-title">
      <div class="popup">
        <button class="popup-close" id="printer-close" aria-label="Close">✕</button>
        <h3 class="popup-title" id="printer-popup-title">Printer Status</h3>
        <p class="popup-id" id="printer-popup-id"></p>
        <div class="status-grid printer-grid">
          <button class="status-btn" data-status="working"><span class="status-dot working"></span>Working</button>
          <button class="status-btn" data-status="major"><span class="status-dot major"></span>Not Working</button>
        </div>
        <label class="notes-label" for="printer-notes">Notes (optional)</label>
        <textarea id="printer-notes" class="notes-input" rows="3" placeholder="Describe the issue…"></textarea>
        <p class="last-updated" id="printer-last-updated"></p>
        <div class="popup-actions">
          <button class="btn-primary" id="printer-save">Save</button>
          <button class="btn-secondary" id="printer-cancel">Cancel</button>
        </div>
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
  const pcOverlay = document.getElementById('pc-overlay');
  const printerOverlay = document.getElementById('printer-overlay');
  const resetOverlay = document.getElementById('reset-overlay');
  const popupIdEl = document.getElementById('popup-id');
  const printerIdEl = document.getElementById('printer-popup-id');
  const pcNotesEl = document.getElementById('pc-notes');
  const pcLastUpdated = document.getElementById('pc-last-updated');
  const printerNotesEl = document.getElementById('printer-notes');
  const printerLastUp = document.getElementById('printer-last-updated');
  const statusBtns = document.querySelectorAll('#pc-overlay .status-btn');
  const printerBtns = document.querySelectorAll('#printer-overlay .status-btn');
  const quickBtns = document.querySelectorAll('#quick-mark .quick-btn');
  const undoBtn = document.getElementById('btn-undo');
  const zoomBtn = document.getElementById('btn-zoom');

  /** id → node, so repainting one device never re-scans the DOM. */
  const nodeById = new Map(
    [...room.querySelectorAll('[data-id]')].map(el => [el.dataset.id, el]),
  );

  let activeDeviceId = null;
  let selectedStatus = null;
  let quickStatus = null;
  let lastFocused = null;
  const undoStack = [];

  const announce = msg => { liveEl.textContent = msg; };
  const entryFor = id => state[stateKey(roomId, id)];

  /* ── State writes ──────────────────────────────────────────────
     Re-read before merging: an intern often has two room tabs open, and the
     old code wrote back a snapshot taken at page load, silently reverting
     whatever the other tab had saved in the meantime. */
  function mutate(fn) {
    const fresh = loadState();
    fn(fresh);
    saveState(fresh);
    state = fresh;
  }

  /* ── Painting ──────────────────────────────────────────────── */

  function paint(deviceId) {
    const el = nodeById.get(deviceId);
    if (!el) return;
    const entry = entryFor(deviceId);
    const device = deviceById.get(deviceId);
    const status = entry?.status || 'unknown';
    const name = device ? deviceLabel(device) : deviceId;
    const kind = el.dataset.kind === 'printer' ? 'Printer ' : '';
    const note = entry?.notes ? ` — note: ${entry.notes}` : '';

    el.dataset.status = status;
    el.dataset.hasNotes = entry?.notes ? 'true' : 'false';
    el.setAttribute('aria-label', `${kind}${name}, ${STATUS_WORDS[status] || STATUS_WORDS.unknown}${note}`);
    if (entry?.notes) el.setAttribute('title', entry.notes);
    else el.removeAttribute('title');
  }

  function paintAll() {
    CFG.devices.forEach(d => paint(d.id));
  }

  function updateSummary() {
    let w = 0, m = 0, maj = 0, unchecked = 0;
    CFG.devices.forEach(({ id }) => {
      const s = entryFor(id)?.status;
      if (s === 'working') w++;
      else if (s === 'minor') m++;
      else if (s === 'major') maj++;
      else unchecked++;
    });
    const total = CFG.devices.length;
    const checked = total - unchecked;
    document.getElementById('count-working').textContent = `${w} Working`;
    document.getElementById('count-minor').textContent = `${m} Minor`;
    document.getElementById('count-major').textContent = `${maj} Major`;
    document.getElementById('count-unchecked').textContent = `${unchecked} unchecked`;
    document.getElementById('sweep-fill').style.width = total ? `${(checked / total) * 100}%` : '0%';
    document.getElementById('sweep-text').textContent =
      `${checked} of ${total} devices checked${unchecked ? ` — ${unchecked} to go` : ' — room complete'}`;
  }

  /* ── Entry writes ──────────────────────────────────────────── */

  function saveEntry(deviceId, status, notes) {
    const key = stateKey(roomId, deviceId);
    mutate(s => { s[key] = { status, notes, updatedAt: new Date().toISOString() }; });
    paint(deviceId);
    updateSummary();
  }

  function clearEntry(deviceId) {
    mutate(s => { delete s[stateKey(roomId, deviceId)]; });
    paint(deviceId);
    updateSummary();
  }

  function resetRoom() {
    mutate(s => { CFG.devices.forEach(({ id }) => delete s[stateKey(roomId, id)]); });
    undoStack.length = 0;
    refreshUndo();
    paintAll();
    updateSummary();
    announce(`${CFG.label} reset`);
  }

  /* ── Quick mark ────────────────────────────────────────────────
     A room is 24–37 machines. Popup-per-device is 4 taps each; quick mark
     makes a sweep one tap per device, with Undo as the safety net. */

  function refreshUndo() {
    undoBtn.disabled = undoStack.length === 0;
    undoBtn.textContent = undoStack.length ? `↶ Undo (${undoStack.length})` : '↶ Undo';
  }

  function setQuick(status) {
    quickStatus = status;
    quickBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.status === status)));
    room.classList.toggle('quick-mode', !!status);
    if (status) room.dataset.quick = status; else delete room.dataset.quick;
    announce(status
      ? `Quick mark ${status === 'clear' ? 'clear' : STATUS_WORDS[status]} on — tap devices to apply`
      : 'Quick mark off');
  }

  function quickApply(deviceId) {
    undoStack.push({ deviceId, previous: entryFor(deviceId) ?? null });
    refreshUndo();
    if (quickStatus === 'clear') {
      clearEntry(deviceId);
      announce(`${deviceId} cleared`);
    } else {
      const keep = entryFor(deviceId)?.notes || '';
      saveEntry(deviceId, quickStatus, keep);
      announce(`${deviceId} marked ${STATUS_WORDS[quickStatus]}`);
    }
  }

  function undoLast() {
    const last = undoStack.pop();
    refreshUndo();
    if (!last) return;
    if (last.previous) {
      mutate(s => { s[stateKey(roomId, last.deviceId)] = last.previous; });
      paint(last.deviceId);
      updateSummary();
    } else {
      clearEntry(last.deviceId);
    }
    announce(`Undid ${last.deviceId}`);
  }

  /* ── Overlays + focus ──────────────────────────────────────────
     Focus is moved into the dialog on open and returned to the device that
     opened it on close, so a keyboard sweep doesn't lose its place. */

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

  [pcOverlay, printerOverlay, resetOverlay].forEach(o =>
    o.addEventListener('keydown', e => trapTab(e, o)));

  function openPcPopup(deviceId) {
    activeDeviceId = deviceId;
    const entry = entryFor(deviceId);
    selectedStatus = entry?.status || 'unknown';
    popupIdEl.textContent = `${roomId} › ${deviceId}`;
    pcNotesEl.value = entry?.notes || '';
    pcLastUpdated.textContent = entry?.updatedAt ? `Updated ${formatDate(entry.updatedAt)}` : '';
    statusBtns.forEach(b => b.classList.toggle('selected', b.dataset.status === selectedStatus));
    openOverlay(pcOverlay, [...statusBtns].find(b => b.dataset.status === selectedStatus));
  }

  function closePcPopup() {
    closeOverlay(pcOverlay);
    activeDeviceId = selectedStatus = null;
  }

  function openPrinterPopup(deviceId) {
    activeDeviceId = deviceId;
    const entry = entryFor(deviceId);
    selectedStatus = entry?.status || 'unknown';
    printerIdEl.textContent = `${roomId} › ${deviceId}`;
    printerNotesEl.value = entry?.notes || '';
    printerLastUp.textContent = entry?.updatedAt ? `Updated ${formatDate(entry.updatedAt)}` : '';
    printerBtns.forEach(b => b.classList.toggle('selected', b.dataset.status === selectedStatus));
    openOverlay(printerOverlay, [...printerBtns].find(b => b.dataset.status === selectedStatus));
  }

  function closePrinterPopup() {
    closeOverlay(printerOverlay);
    activeDeviceId = selectedStatus = null;
  }

  /* ── Fit-to-screen ─────────────────────────────────────────────
     The floor plan is a fixed 1200×800-ish coordinate space. Rather than
     rewriting every device position as a percentage, scale the whole canvas
     and let the viewport own the height — so the room fits a phone screen
     without horizontal scrolling, and "Actual size" still gives 1:1. */
  let fitMode = true;

  function applyScale() {
    const available = viewport.clientWidth || W;
    const k = fitMode ? Math.min(1, available / W) : 1;
    room.style.transformOrigin = 'top left';
    room.style.transform = `scale(${k})`;
    viewport.style.height = `${Math.round(H * k)}px`;
    viewport.classList.toggle('actual-size', !fitMode);
    zoomBtn.textContent = fitMode ? '⤢ Actual size' : '⤢ Fit to screen';
    zoomBtn.setAttribute('aria-pressed', String(!fitMode));
  }

  /* ── Events ────────────────────────────────────────────────── */

  // One delegated listener instead of one per device.
  room.addEventListener('click', e => {
    const el = e.target.closest?.('[data-id]');
    if (!el || !room.contains(el)) return;
    const deviceId = el.dataset.id;
    if (quickStatus) { quickApply(deviceId); return; }
    if (el.dataset.kind === 'printer') openPrinterPopup(deviceId);
    else openPcPopup(deviceId);
  });

  quickBtns.forEach(btn => btn.addEventListener('click', () => {
    setQuick(quickStatus === btn.dataset.status ? null : btn.dataset.status);
  }));

  undoBtn.addEventListener('click', undoLast);

  zoomBtn.addEventListener('click', () => { fitMode = !fitMode; applyScale(); });

  statusBtns.forEach(btn => btn.addEventListener('click', () => {
    selectedStatus = btn.dataset.status;
    statusBtns.forEach(b => b.classList.toggle('selected', b === btn));
  }));

  printerBtns.forEach(btn => btn.addEventListener('click', () => {
    selectedStatus = btn.dataset.status;
    printerBtns.forEach(b => b.classList.toggle('selected', b === btn));
  }));

  document.getElementById('pc-save').addEventListener('click', () => {
    if (activeDeviceId && selectedStatus) {
      saveEntry(activeDeviceId, selectedStatus, pcNotesEl.value.trim());
      announce(`${activeDeviceId} saved as ${STATUS_WORDS[selectedStatus]}`);
    }
    closePcPopup();
  });
  document.getElementById('pc-close').addEventListener('click', closePcPopup);
  document.getElementById('pc-cancel').addEventListener('click', closePcPopup);
  pcOverlay.addEventListener('click', e => { if (e.target === pcOverlay) closePcPopup(); });

  document.getElementById('printer-save').addEventListener('click', () => {
    if (activeDeviceId && selectedStatus) {
      saveEntry(activeDeviceId, selectedStatus, printerNotesEl.value.trim());
      announce(`${activeDeviceId} saved as ${STATUS_WORDS[selectedStatus]}`);
    }
    closePrinterPopup();
  });
  document.getElementById('printer-close').addEventListener('click', closePrinterPopup);
  document.getElementById('printer-cancel').addEventListener('click', closePrinterPopup);
  printerOverlay.addEventListener('click', e => { if (e.target === printerOverlay) closePrinterPopup(); });

  document.getElementById('btn-reset').addEventListener('click', () => openOverlay(resetOverlay));
  document.getElementById('reset-confirm').addEventListener('click', () => { resetRoom(); closeOverlay(resetOverlay); });
  document.getElementById('reset-cancel').addEventListener('click', () => closeOverlay(resetOverlay));
  resetOverlay.addEventListener('click', e => { if (e.target === resetOverlay) closeOverlay(resetOverlay); });

  document.getElementById('btn-export-room').addEventListener('click', () => exportRoom(roomId, CFG.label));
  document.getElementById('btn-export-all').addEventListener('click', () => exportAllRooms());

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const anyOpen = [pcOverlay, printerOverlay, resetOverlay].some(o => o.classList.contains('open'));
    if (anyOpen) { closePcPopup(); closePrinterPopup(); closeOverlay(resetOverlay); }
    else if (quickStatus) setQuick(null);
  });

  // Another tab saved something — pick it up instead of showing stale colours.
  window.addEventListener('storage', () => {
    state = loadState();
    paintAll();
    updateSummary();
  });

  window.addEventListener('resize', applyScale);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(applyScale).observe(viewport);
  }

  paintAll();
  updateSummary();
  refreshUndo();
  applyScale();
}
