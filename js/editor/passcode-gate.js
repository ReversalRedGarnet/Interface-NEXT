/**
 * passcode-gate.js — the editor's casual access gate: a plain client-side
 * string comparison against a per-deployment passcode, no hashing or
 * backend. Explicitly not real security, same spirit as admin/trace.html
 * being unlinked-but-reachable — this just keeps the editor from being one
 * obvious click away for anyone browsing the site during this testing
 * phase. Real, server-verified auth is separate, future work.
 *
 * WHAT THIS ACTUALLY BUYS, AND WHAT IT DOESN'T:
 * The real passcode lives in js/editor/passcode.config.js, which is
 * gitignored rather than committed (see passcode.config.example.js next to
 * it). That keeps this deployment's actual value out of the repo's public
 * git history, so anyone browsing the source on GitHub doesn't get it for
 * free. Combined with the failed-attempt backoff below, that also slows
 * down a same-page casual guesser. That's the whole benefit. Once the site
 * is actually deployed, passcode.config.js is still served as plain,
 * unobfuscated JS to anyone who loads the page — readable via devtools or
 * view-source with no more effort than any other file on the site. None of
 * this defends against someone who actually opens devtools on the live
 * site; it only raises the bar for a casual visitor clicking around.
 *
 * Pure/DOM-light on purpose (testable directly under Node): `storage` is
 * always injected (defaults to `sessionStorage`), and the config loader
 * takes an injectable `importer`, the same convention `dataUrlFor`/`rand`
 * already use elsewhere in this codebase — a test can hand it a fake
 * storage object or a fake importer instead of needing a real browser's
 * sessionStorage or a real config file on disk.
 */

/** sessionStorage (not localStorage): unlocking is meant to last only this
 *  browser tab's session, re-locking the moment it's closed — never a
 *  persistent, indefinite unlock. */
const UNLOCK_KEY = 'gridkeep-editor-unlocked';

/** Failed-attempt tracking lives alongside the unlock flag in the same
 *  sessionStorage — same tab-only lifetime. This is a mild deterrent, not a
 *  real lockout: closing the tab clears it, exactly like the unlock flag. */
const FAIL_COUNT_KEY = 'gridkeep-editor-fail-count';
const FAIL_TIME_KEY = 'gridkeep-editor-fail-time';

/** Consecutive failures before a cooldown starts applying at all. */
const BACKOFF_THRESHOLD = 3;
/** Cooldown duration (ms), indexed by how far past the threshold the
 *  current streak is — the last entry is the cap for every failure beyond
 *  it (so this stays "increasing, then capped", never unbounded). */
const BACKOFF_SCHEDULE_MS = [5000, 15000, 30000];

/**
 * Loads this deployment's real passcode from js/editor/passcode.config.js.
 * Resolves to { ok: true, passcode } on success, or { ok: false, error } if
 * the file is missing (fresh clone, example not yet copied) or malformed.
 * Callers MUST fail closed on `ok: false` — never fall back to a default
 * passcode.
 */
export async function loadPasscodeConfig(importer = () => import('./passcode.config.js')) {
  try {
    const mod = await importer();
    if (!mod || typeof mod.EDITOR_PASSCODE !== 'string' || mod.EDITOR_PASSCODE === '') {
      throw new Error('passcode.config.js did not export a non-empty EDITOR_PASSCODE string.');
    }
    return { ok: true, passcode: mod.EDITOR_PASSCODE };
  } catch (error) {
    return { ok: false, error };
  }
}

export function isCorrectPasscode(input, configuredPasscode) {
  return typeof configuredPasscode === 'string' && input === configuredPasscode;
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
  resetFailedAttempts(storage);
}

/**
 * Records one failed attempt and returns the new consecutive-failure
 * count. Fails toward "no lockout" (returns 0, as if nothing were
 * recorded) on any storage problem — unlike isSessionUnlocked, the failure
 * counter is a deterrent, not the security boundary, so a broken counter
 * should degrade to no cooldown rather than a stuck one.
 */
export function recordFailedAttempt(storage = sessionStorage, now = Date.now()) {
  try {
    const count = readFailCount(storage) + 1;
    storage.setItem(FAIL_COUNT_KEY, String(count));
    storage.setItem(FAIL_TIME_KEY, String(now));
    return count;
  } catch {
    return 0;
  }
}

export function resetFailedAttempts(storage = sessionStorage) {
  try {
    storage.removeItem(FAIL_COUNT_KEY);
    storage.removeItem(FAIL_TIME_KEY);
  } catch {
    // Advisory only, same reasoning as markSessionUnlocked above.
  }
}

/**
 * Milliseconds remaining before another attempt should be accepted (0 if
 * none is owed right now). Fails toward 0 — "no lockout" — on any storage
 * problem, for the same reason recordFailedAttempt does: the cooldown
 * isn't the security boundary, the passcode is.
 */
export function cooldownRemainingMs(storage = sessionStorage, now = Date.now()) {
  try {
    const count = readFailCount(storage);
    if (count < BACKOFF_THRESHOLD) return 0;
    const tier = Math.min(count - BACKOFF_THRESHOLD, BACKOFF_SCHEDULE_MS.length - 1);
    const duration = BACKOFF_SCHEDULE_MS[tier];
    const raw = storage.getItem(FAIL_TIME_KEY);
    const lastFailure = raw ? Number(raw) : 0;
    return Math.max(0, duration - (now - lastFailure));
  } catch {
    return 0;
  }
}

function readFailCount(storage) {
  const raw = storage.getItem(FAIL_COUNT_KEY);
  const count = raw ? Number(raw) : 0;
  return Number.isFinite(count) && count > 0 ? count : 0;
}
