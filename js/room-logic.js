/**
 * room-logic.js — pure decision logic behind the room page's workstation
 * features: inspection order, next-unchecked lookup, stats, filter
 * matching, and search matching. No DOM — testable directly under Node,
 * same split as schema.js vs canvas-renderer.js/tools.js.
 *
 * Nothing here changes what a status IS or how it's stored — `statusFor`/
 * `entryFor`-style callbacks are always supplied by the caller (room.js),
 * reading the same state.js-backed entries as before. This module only
 * ever reads device fields that already exist (id, top, left, label,
 * assetId) — it never requires or invents a new room-data field.
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
 * `statusFor(device)` returns 'working'/'minor'/'major'/'unknown' — the
 * exact same four values room.js has always used.
 */
export function computeStats(devices, statusFor) {
  let working = 0, minor = 0, major = 0, unchecked = 0;
  devices.forEach(d => {
    const s = statusFor(d);
    if (s === 'working') working++;
    else if (s === 'minor') minor++;
    else if (s === 'major') major++;
    else unchecked++;
  });
  const total = devices.length;
  return { total, working, minor, major, unchecked, inspected: total - unchecked, issues: minor + major };
}

/** Filter row matching — 'all'/'unchecked'/'working'/'minor'/'major'/'notes'. */
export function matchesFilter(status, hasNotes, filterKey) {
  switch (filterKey) {
    case 'unchecked': return status === 'unknown';
    case 'working':   return status === 'working';
    case 'minor':     return status === 'minor';
    case 'major':     return status === 'major';
    case 'notes':     return !!hasNotes;
    case 'all':
    default:          return true;
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
