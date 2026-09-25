/**
 * room-logic.js — pure decision logic behind the room page's workstation
 * features: inspection order, next-unchecked lookup, stats, filter
 * matching, and search matching. No DOM — testable directly under Node,
 * same split as schema.js vs canvas-renderer.js/tools.js.
 *
 * Every device is described by two independent fields, matching exactly
 * what state.js now stores:
 *   - inspectionState: 'unchecked' | 'checked' | 'not-applicable'
 *   - condition: 'working' | 'minor' | 'major' | null — only meaningful
 *     when inspectionState is 'checked'
 * `inspectionFor`-style callbacks are always supplied by the caller
 * (room.js), reading the same state.js-backed entries as before. This
 * module only ever reads device fields that already exist (id, top,
 * left, label, assetId) — it never requires or invents a new room-data
 * field.
 */

/**
 * Deterministic inspection order: top-to-bottom, then left-to-right —
 * row-major over each device's existing stored position. Ties on `top`
 * (the common case: a row of PCs sharing one y-coordinate) resolve by
 * `left`, so a genuine row reads left-to-right exactly as a person
 * sweeping the room would expect.
 */
export function orderDevicesForInspection(devices) {
  return [...devices].sort((a, b) => {
    const dy = (Number(a.top) || 0) - (Number(b.top) || 0);
    if (dy !== 0) return dy;
    return (Number(a.left) || 0) - (Number(b.left) || 0);
  });
}

/**
 * Finds the next device (in inspection order) for which `isUnchecked`
 * returns true, starting just after `afterId` (or from the top if
 * `afterId` is null/not found) and wrapping around once. Returns null if
 * every device is checked, or the device list is empty.
 */
export function findNextUnchecked(orderedDevices, isUnchecked, afterId = null) {
  if (!orderedDevices.length) return null;
  const afterIdx = afterId ? orderedDevices.findIndex(d => d.id === afterId) : -1;
  const startIdx = afterIdx + 1;
  for (let i = 0; i < orderedDevices.length; i++) {
    const idx = (startIdx + i) % orderedDevices.length;
    if (isUnchecked(orderedDevices[idx])) return orderedDevices[idx];
  }
  return null;
}

/**
 * Room-wide counts for the header stats line and the completion state.
 * `inspectionFor(device)` returns `{ inspectionState, condition }`.
 * `inspected` counts only *checked* devices (a working/minor/major
 * condition) — not-applicable devices are their own bucket, never folded
 * into "inspected", so a stats line can read e.g. "27 inspected · 2 not
 * applicable · 3 remaining" without double-counting.
 */
export function computeStats(devices, inspectionFor) {
  let working = 0, minor = 0, major = 0, unchecked = 0, notApplicable = 0;
  devices.forEach(d => {
    const { inspectionState, condition } = inspectionFor(d) || {};
    if (inspectionState === 'not-applicable') { notApplicable++; return; }
    if (inspectionState === 'checked') {
      if (condition === 'working') working++;
      else if (condition === 'minor') minor++;
      else if (condition === 'major') major++;
      return;
    }
    unchecked++;
  });
  const total = devices.length;
  const inspected = working + minor + major;
  return { total, working, minor, major, unchecked, notApplicable, inspected, issues: minor + major };
}

/** Filter row matching — 'all'/'unchecked'/'checked'/'not-applicable'/
 *  'working'/'minor'/'major'/'notes'. `condition` is ignored (and may be
 *  null) for every filter except the three specific-condition ones. */
export function matchesFilter(inspectionState, condition, hasNotes, filterKey) {
  switch (filterKey) {
    case 'unchecked':      return inspectionState === 'unchecked';
    case 'checked':        return inspectionState === 'checked';
    case 'not-applicable': return inspectionState === 'not-applicable';
    case 'working':        return inspectionState === 'checked' && condition === 'working';
    case 'minor':          return inspectionState === 'checked' && condition === 'minor';
    case 'major':          return inspectionState === 'checked' && condition === 'major';
    case 'notes':          return !!hasNotes;
    case 'all':
    default:               return true;
  }
}

/** Case-insensitive substring match against a pre-built haystack string
 *  (room.js assembles the haystack from id/label/assetId/serial/
 *  manufacturer/notes/status/room-id/room-label — whatever fields are
 *  actually present; this function only knows about matching text). */
export function matchesSearch(haystack, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return false;
  return String(haystack || '').toLowerCase().includes(q);
}

/** Builds one device's search haystack — every field item 6 lists that
 *  actually exists for this device, space-joined. Missing fields (no
 *  assetId, no note, no matching assets.json record) are simply omitted,
 *  never "undefined"-polluted. */
export function buildSearchHaystack({ roomId, roomLabel, device, statusWord, notes, assetRecord }) {
  return [
    roomId, roomLabel, device.id, device.label,
    device.assetId, assetRecord?.manufacturer, assetRecord?.serial,
    notes, statusWord,
  ].filter(Boolean).join(' ');
}

/* ── Fit-to-screen geometry ──────────────────────────────────────────
 * A room's canvasWidth/canvasHeight is an authored canvas size, not
 * necessarily what's actually drawn on it — every real room but one has
 * real margin between its nominal canvas edges and its actual content
 * (walls/devices), because the outline/devices were placed well inside the
 * canvas when the room was scaffolded. Fitting to the raw canvas size
 * wastes scale on that margin; fitting to the true content bounding box
 * doesn't. room.js supplies the live viewport size (DOM-dependent); this
 * file only does the pure geometry. */

/** Rendered chip footprint (px), matching floor-plan.css's actual sizing
 *  rules exactly: a long label (>5 chars) widens a chip to 64px, taking
 *  priority over the staff bump to 52px if both would apply — the same
 *  precedence `.pc.wide` has over `.pc.staff` in the CSS cascade there
 *  (declared later, equal specificity). Height never changes for either
 *  variant, only a printer's does. */
export function deviceFootprint(device) {
  if (device.type === 'printer') return { width: 88, height: 44 };
  const label = device.label || device.id || '';
  if (label.length > 5) return { width: 64, height: 42 };
  if (device.type === 'staff') return { width: 52, height: 42 };
  return { width: 42, height: 42 };
}

/**
 * The true bounding box of everything actually drawn: every layout shape
 * (outline/room/entrance/counter/wallrect rects, wall line segments) plus
 * every device's real chip footprint. Room/entrance labels aren't measured
 * separately — they're always centered within their own shape's rect
 * (drawLayout in room.js), which is already included, so a reasonably
 * sized label doesn't need its own bounds check. Doors are skipped too:
 * a door's hinge/jamb points always sit on a wall/outline span that's
 * already covered. Falls back to the room's nominal canvas size only when
 * there's truly nothing to measure (no layout, no devices).
 */
export function computeContentBounds(layout, devices, fallbackWidth, fallbackHeight) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const extend = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  (layout || []).forEach(o => {
    if (o.type === 'outline' && Array.isArray(o.points)) {
      o.points.forEach(p => extend(p[0], p[1]));
      return;
    }
    if (o.x1 !== undefined && o.y1 !== undefined) {
      extend(o.x1, o.y1);
      extend(o.x2, o.y2);
      return;
    }
    if (o.x !== undefined && o.y !== undefined) {
      extend(o.x, o.y);
      extend(o.x + (Number(o.width) || 0), o.y + (Number(o.height) || 0));
    }
  });
  (devices || []).forEach(d => {
    const { width, height } = deviceFootprint(d);
    const left = Number(d.left) || 0, top = Number(d.top) || 0;
    extend(left, top);
    extend(left + width, top + height);
  });
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: fallbackWidth, maxY: fallbackHeight };
  return { minX, minY, maxX, maxY };
}

/**
 * The largest scale — never more than 1× (no auto-zooming past actual
 * size) — at which `bounds` fits inside an `availableWidth`×
 * `availableHeight` viewport, leaving `margin` px of breathing room on
 * every side rather than butting the content against the pane's edges.
 */
export function computeFitScale(bounds, availableWidth, availableHeight, margin = 0) {
  const boundsWidth = (bounds.maxX - bounds.minX) || 1;
  const boundsHeight = (bounds.maxY - bounds.minY) || 1;
  const w = Math.max(0, availableWidth - margin * 2);
  const h = Math.max(0, availableHeight - margin * 2);
  return Math.min(1, w / boundsWidth, h / boundsHeight);
}

/** The pan (translate) that centers `bounds` — not the room's raw (0,0)
 *  origin — within an availableWidth×availableHeight viewport at `scale`.
 *  Centering on the actual content means a room whose content doesn't
 *  start at (0,0) (nearly every real room) still lands framed in the
 *  middle of the pane, not shifted off to one side. */
export function computeFitPan(bounds, availableWidth, availableHeight, scale) {
  const boundsWidth = bounds.maxX - bounds.minX;
  const boundsHeight = bounds.maxY - bounds.minY;
  return {
    x: (availableWidth - boundsWidth * scale) / 2 - bounds.minX * scale,
    y: (availableHeight - boundsHeight * scale) / 2 - bounds.minY * scale,
  };
}
