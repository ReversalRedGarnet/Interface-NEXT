/**
 * passcode-gate.js — the editor's casual access gate: a plain client-side
 * string comparison, no hashing/obfuscation/backend. Explicitly not real
 * security, same spirit as admin/trace.html being unlinked-but-reachable —
 * this just keeps the editor from being one obvious click away for anyone
 * browsing the site during this testing phase. Real auth is separate,
 * future work.
 *
 * Pure/DOM-light on purpose (testable directly under Node): `storage` is
 * always injected (defaults to `sessionStorage`) rather than hardcoded, the
 * same convention `dataUrlFor`/`rand` already use elsewhere in this
 * codebase, so a test can hand it a fake storage object instead of needing
 * a real browser's sessionStorage.
 */

export const EDITOR_PASSCODE = '1234';

/** sessionStorage (not localStorage): unlocking is meant to last only this
 *  browser tab's session, re-locking the moment it's closed — never a
 *  persistent, indefinite unlock. */
const UNLOCK_KEY = 'gridkeep-editor-unlocked';

export function isCorrectPasscode(input) {
  return input === EDITOR_PASSCODE;
}

/** Fails locked, never unlocked, on any storage access problem (a private
 *  browsing mode that blocks storage, etc.) — the safe direction for an
 *  access gate to fail in. */
export function isSessionUnlocked(storage = sessionStorage) {
  try {
    return storage.getItem(UNLOCK_KEY) === 'true';
  } catch {
    return false;
  }
}

export function markSessionUnlocked(storage = sessionStorage) {
  try {
    storage.setItem(UNLOCK_KEY, 'true');
  } catch {
    // Advisory only — if it can't be persisted, the tab just re-prompts
    // next time; it already behaved correctly for the current page load.
  }
}
