/**
 * build-grid.js — shared PC-grid generator for room data files.
 */
const fs = require('fs');
const path = require('path');

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
  gpl: {
    grid: { startTop: 74, startLeft: 214, rowGap: 122, colGap: 122, rows: 6, cols: 3, blocks: 2, blockGap: 486 },
    extra: [],
  },
  mtl: {
    grid: { startTop: 245, startLeft: 312, rowGap: 88, colGap: 89, rows: 6, cols: 3, blocks: 2, blockGap: 354 },
    // type:'staff' (not 'pc') — the wider chip, so the 8-char label fits.
    extra: [{ id: 'STAFF-PC', type: 'staff', top: 135, left: 335, label: 'Staff' }],
  },
  's28-104': {
    grid: { startTop: 201, startLeft: 274, rowGap: 122, colGap: 122, rows: 4, cols: 6 },
    extra: [],
  },
  's28-107': {
    grid: { startTop: 245, startLeft: 274, rowGap: 122, colGap: 122, rows: 4, cols: 6 },
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
