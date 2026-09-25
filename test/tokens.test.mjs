/**
 * tokens.test.mjs — permanent regression guard for the design system's
 * corner/divider aesthetic (sharp corners, bold structural dividers), not
 * just a one-off check: a future edit that reintroduces a soft radius or a
 * hardcoded color/hairline divider should fail here, the same way
 * no-emoji.test.mjs guards against emoji creeping back in.
 *
 * admin/trace.css is deliberately excluded — it's a self-contained module
 * with its own local --radius token, independent of tokens.css by design
 * (see its own header comment), not part of this app-wide pass.
 * Run: node test/tokens.test.mjs
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

const tokensCss = fs.readFileSync(path.join(ROOT, 'tokens.css'), 'utf8');

function tokenValue(name) {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(tokensCss);
  return m ? m[1].trim() : null;
}

await test('every radius token (control/panel/pill) is sharp — 0', async () => {
  for (const name of ['--radius-control', '--radius-panel', '--radius-pill']) {
    assertEqualToken(tokenValue(name), '0', name);
  }
});
function assertEqualToken(actual, expected, name) {
  assert(actual === expected, `${name} should be "${expected}", got "${actual}"`);
}

await test('--border-divider is bold (thicker than an ordinary 1.5px control border) and reuses --line-strong rather than a new color', async () => {
  const value = tokenValue('--border-divider');
  assert(value, '--border-divider is not defined in tokens.css');
  const m = /^([\d.]+)px solid var\(--line-strong\)$/.exec(value);
  assert(m, `--border-divider should be "<width>px solid var(--line-strong)", got "${value}"`);
  assert(parseFloat(m[1]) > 1.5, `--border-divider's width (${m[1]}px) should be bolder than the ordinary 1.5px control border, not a hairline`);
});

const SKIP_FILES = new Set(['trace.css']);

function walkCss(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkCss(full, files);
    else if (entry.name.endsWith('.css') && !SKIP_FILES.has(entry.name)) files.push(full);
  }
  return files;
}

await test('no stylesheet (outside the self-contained admin/trace.css) hardcodes a soft border-radius pixel value — every corner goes through a --radius-* token, or is 0/50% (a functional circle, not a corner style)', async () => {
  const offenders = [];
  for (const file of walkCss(ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const m = /border-radius:\s*([^;]+);/.exec(line);
      if (!m) return;
      const value = m[1].trim();
      // Allowed: var(--radius-*) (alone or combined, e.g. "var(--radius-panel) var(--radius-panel) 0 0"),
      // a literal 0, or 50% (circles/dots — a functional shape, not a corner-radius aesthetic).
      const ok = /^(var\(--radius-[a-z]+\)|0)(\s+(var\(--radius-[a-z]+\)|0))*$/.test(value) || value === '50%';
      if (!ok) offenders.push(`${path.relative(ROOT, file)}:${i + 1} → border-radius: ${value}`);
    });
  }
  assert(offenders.length === 0, `found a hardcoded/soft border-radius outside the token system:\n  ${offenders.join('\n  ')}`);
});

/* ── Report ────────────────────────────────────────────────────── */

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
