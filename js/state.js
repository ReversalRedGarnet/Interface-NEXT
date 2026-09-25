/**
 * state.js — shared localStorage state for all rooms.
 * Key format: LIBRARY_PC1, S28-107_PRINTER, GPL_PC3 …
 *
 * Entry shape (current): { inspectionState, condition, notes, updatedAt }
 *   - inspectionState: 'unchecked' | 'checked' | 'not-applicable'
 *   - condition: 'working' | 'minor' | 'major' | null — only meaningful
 *     (non-null) when inspectionState is 'checked'
 * A device with no entry at all is implicitly unchecked — untouched
 * devices don't get a localStorage row just for existing.
 *
 * Entry shape (pre-2026-09 — before inspection state and condition were
 * split apart): { status: 'working'|'minor'|'major'|'unknown', notes,
 * updatedAt }. Real browsers already have data in this old shape, so
 * `loadState` migrates it transparently on every read (see
 * `migrateEntry` below) — it never rewrites or deletes anything in
 * localStorage itself, so a page that never saves anything leaves the
 * old data exactly as it found it, and the first real save persists the
 * migrated shape as a side effect of that save.
 *
 * NOTE: this is per-browser/per-device storage only — it does not sync
 * between different computers or people viewing the same room. Use the
 * Backup/Restore (JSON) buttons on the menu page to move state between
 * devices manually. True real-time multi-device sync would need a small
 * backend (e.g. a shared database) instead of localStorage.
 */

const STORAGE_KEY = 'it-room-monitor-v1';

/**
 * Converts one old-shape entry `{ status, notes, updatedAt }` into the
 * current `{ inspectionState, condition, notes, updatedAt }` shape.
 * Already-migrated entries (they carry `inspectionState`) pass through
 * untouched, so this is safe to run on every load regardless of whether
 * the stored blob has already been migrated.
 */
export function migrateEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  if (entry.inspectionState) return entry;
  const oldStatus = entry.status;
  const hasCondition = oldStatus === 'working' || oldStatus === 'minor' || oldStatus === 'major';
  return {
    inspectionState: hasCondition ? 'checked' : 'unchecked',
    condition: hasCondition ? oldStatus : null,
    notes: entry.notes || '',
    updatedAt: entry.updatedAt || null,
  };
}

export function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    const migrated = {};
    for (const [key, entry] of Object.entries(raw)) migrated[key] = migrateEntry(entry);
    return migrated;
  } catch { return {}; }
}

export function saveState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { console.warn('localStorage unavailable — state will not persist.'); }
}

export function stateKey(roomId, deviceId) {
  return `${roomId}_${deviceId}`;
}
