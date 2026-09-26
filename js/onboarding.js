/**
 * onboarding.js — the room page's first-run walkthrough: what to show, and
 * whether it should show automatically. Kept separate from state.js (which
 * is per-device inspection data) since this is a single, page-independent
 * "has this browser seen the tour" flag — never confused with inspection
 * state, never touched by Reset or Backup/Restore.
 *
 * `storage` is always injected (defaults to `localStorage`), the same
 * convention state.js/passcode-gate.js already use, so this is testable
 * under Node without a real localStorage.
 */

const ONBOARDED_KEY = 'gridkeep-onboarded';

/** Kept short and jargon-free — this teaches the workflow to someone who's
 *  never seen the app and has nobody walking them through it. */
export const WALKTHROUGH_STEPS = [
  {
    title: 'Welcome',
    body: 'This app is for walking through a room and checking each device, one at a time.',
  },
  {
    title: 'Tap a device',
    body: 'Tap any device on the floor plan to see its status options — Working, Minor, Major, or Not Applicable — plus a place to add notes.',
  },
  {
    title: 'Inspection Mode',
    body: 'Arm a status once in Inspection Mode, then tap through many devices in a row without reopening anything each time.',
  },
  {
    title: 'Track your progress',
    body: 'The progress bar shows how much of the room is left to check.',
  },
  {
    title: 'Find a device fast',
    body: 'Use Search to jump straight to a device by name instead of scanning the whole floor plan.',
  },
];

/**
 * True only when this browser/device has never dismissed the walkthrough.
 * Fails toward false — "don't auto-show" — on any storage problem (private
 * browsing, storage disabled, etc.): the room page must never be blocked,
 * or even nagged repeatedly, by onboarding chrome failing to read its own
 * flag.
 */
export function shouldAutoShowWalkthrough(storage = localStorage) {
  try {
    return storage.getItem(ONBOARDED_KEY) !== 'true';
  } catch {
    return false;
  }
}

export function markWalkthroughSeen(storage = localStorage) {
  try {
    storage.setItem(ONBOARDED_KEY, 'true');
  } catch {
    // Advisory only — if it can't be persisted, the tour just reappears
    // next visit, a fine failure mode for onboarding chrome.
  }
}
