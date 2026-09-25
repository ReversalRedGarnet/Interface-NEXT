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
