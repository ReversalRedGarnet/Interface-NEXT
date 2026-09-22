/**
 * serve.js — cross-platform wrapper around `python -m http.server`.
 * The launcher binary name differs by platform/install (python3, python, py),
 * so this picks whichever one is actually on PATH instead of hardcoding one.
 */
import { spawn, spawnSync } from 'node:child_process';

const PORT = 8000;
const CANDIDATES = ['python3', 'python', 'py'];
const isWin = process.platform === 'win32';

function isAvailable(cmd) {
  const result = spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: isWin });
  return !result.error;
}

const python = CANDIDATES.find(isAvailable);
if (!python) {
  console.error('No Python interpreter found on PATH (tried: python3, python, py).');
  console.error('Install Python, or run any other static file server against this directory.');
  process.exit(1);
}

const args = python === 'py' ? ['-3', '-m', 'http.server', String(PORT)] : ['-m', 'http.server', String(PORT)];
const child = spawn(python, args, { stdio: 'inherit', shell: isWin });
child.on('exit', (code) => process.exit(code ?? 0));
