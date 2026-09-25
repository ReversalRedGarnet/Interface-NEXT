/**
 * no-emoji.test.mjs — scans every shipped HTML/JS/CSS file for emoji.
 * The app uses only plain typographic characters already established
 * elsewhere (←, →, ↓, ↶, ↺, ⋯, ✕, ✓, ✔, ⎙ — arrows/dingbats, never
 * colorful pictographs) and small flat outline SVGs. This is a permanent
 * regression guard, not just a one-off sweep — a future PR that pastes an
 * emoji back in should fail here.
 * Run: node test/no-emoji.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const results = [];

async function test(name, fn) {
  try { await fn(); results.push(['PASS', name, '']); }
  catch (err) { results.push(['FAIL', name, err.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// Broad emoji-ish ranges: supplementary-plane pictographs, misc
// symbols/dingbats, misc symbols and arrows, misc technical, and the
// emoji variation selector. Arrows (U+2190-21FF) are deliberately NOT
// included — that whole block is the plain arrow vocabulary (←, →, ↓, ↶,
// ↺) this app already relies on everywhere.
const EMOJI_RANGE = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{FE0F}]/gu;

// Plain typographic symbols in those same ranges that are NOT emoji —
// dingbats/technical glyphs with no color/pictographic presentation,
// explicitly allowed rather than widening the range and losing the check.
const ALLOWED = new Set(['✕', '✓', '✔', '⎙']);

const SCAN_EXTENSIONS = new Set(['.html', '.js', '.css']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'test']);

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

await test('no emoji anywhere in shipped HTML/JS/CSS', async () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const matches = line.match(EMOJI_RANGE) || [];
      const bad = matches.filter(ch => !ALLOWED.has(ch));
      if (bad.length) offenders.push(`${path.relative(ROOT, file)}:${i + 1} → ${bad.join(' ')}`);
    });
  }
  assert(offenders.length === 0, `found emoji in:\n  ${offenders.join('\n  ')}`);
});

await test('the allow-listed dingbats are exactly the ones actually in use (no unused entries to rot)', async () => {
  const found = new Set();
  for (const file of walk(ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const ch of text.match(EMOJI_RANGE) || []) if (ALLOWED.has(ch)) found.add(ch);
  }
  for (const ch of ALLOWED) {
    assert(found.has(ch), `"${ch}" is allow-listed but never actually appears anywhere — remove it from ALLOWED`);
  }
});

/* ── Report ────────────────────────────────────────────────────── */

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
