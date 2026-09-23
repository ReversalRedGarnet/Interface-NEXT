/**
 * build-grid.js — shared PC-grid generator for room data files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

function makeGrid({ startTop, startLeft, rowGap, colGap, rows, cols, blocks = 1, blockGap = 0, startCount = 1 }) {
  const devices = [];
  let count = startCount;
  for (let block = 0; block < blocks; block++) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        devices.push({
          id: `PC${count++}`,
          type: 'pc',
          top: startTop + row * rowGap,
          left: startLeft + block * blockGap + col * colGap,
        });
      }
    }
  }
  return devices;
}

const ROOM_GRIDS = {
  annex: {
    grid: { startTop: 90, startLeft: 220, rowGap: 120, colGap: 120, rows: 6, cols: 3, blocks: 2, blockGap: 460 },
    extra: [],
  },
  workshop: {
    grid: { startTop: 130, startLeft: 280, rowGap: 90, colGap: 95, rows: 6, cols: 3, blocks: 2, blockGap: 360 },
    // type:'staff' (not 'pc') — the wider chip, so the 8-char label fits.
    extra: [{ id: 'STAFF-PC', type: 'staff', top: 100, left: 850, label: 'Staff' }],
  },
  'b2-204': {
    grid: { startTop: 220, startLeft: 300, rowGap: 120, colGap: 120, rows: 4, cols: 6 },
    extra: [],
  },
  'b2-210': {
    grid: { startTop: 180, startLeft: 250, rowGap: 120, colGap: 120, rows: 4, cols: 6 },
    extra: [],
  },
};

for (const [room, { grid, extra }] of Object.entries(ROOM_GRIDS)) {
  const file = path.join(DATA_DIR, `${room}.json`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.devices = [...makeGrid(grid), ...extra];
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`${room}: wrote ${data.devices.length} devices`);
}
