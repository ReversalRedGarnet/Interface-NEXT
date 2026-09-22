/**
 * state.js — shared localStorage state for all rooms.
 * Key format: LIBRARY_PC1, S28-107_PRINTER, GPL_PC3 …
 *
 * NOTE: this is per-browser/per-device storage only — it does not sync
 * between different computers or people viewing the same room. Use the
 * Backup/Restore (JSON) buttons on the menu page to move state between
 * devices manually. True real-time multi-device sync would need a small
 * backend (e.g. a shared database) instead of localStorage.
 */

const STORAGE_KEY = 'it-room-monitor-v1';

export function loadState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
  catch { return {}; }
}

export function saveState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { console.warn('localStorage unavailable — state will not persist.'); }
}

export function stateKey(roomId, deviceId) {
  return `${roomId}_${deviceId}`;
}
