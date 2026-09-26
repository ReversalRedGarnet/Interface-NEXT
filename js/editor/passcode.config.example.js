/**
 * passcode.config.example.js — template for this deployment's editor
 * passcode.
 *
 * To set up a deployment:
 *   1. Copy this file to passcode.config.js, in this same directory.
 *   2. Change EDITOR_PASSCODE below to whatever this deployment's real
 *      access code should be.
 *   3. Don't commit passcode.config.js — it's gitignored on purpose, so
 *      the real value never ends up in this repo's public git history.
 *
 * If passcode.config.js doesn't exist yet, the editor's lock screen fails
 * closed with a message pointing back to these steps — it never falls
 * back to this file's placeholder value. See passcode-gate.js for what
 * this passcode gate does and doesn't protect against.
 */

export const EDITOR_PASSCODE = 'change-me';
