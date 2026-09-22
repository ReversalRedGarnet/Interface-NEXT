# IT Room Monitor

A floor-plan view of every lab machine in a room. Interns walk the room, tap
each device, and the status sticks. Reports come out as CSV.

## Structure
```
index.html      — campus/room menu (was documented as menu.html; that was wrong)
style.css
js/
  main.js       — entry point (dual-mode: menu page vs room page)
  menu.js       — menu page: campus toggles, export-all, backup/restore
  room.js       — room page: floor-plan SVG, device rendering, quick-mark,
                  popups, progress, state
  export.js     — CSV reports + JSON state backup/restore
  state.js      — localStorage read/write helpers
  format.js     — date formatting helpers
  build-grid.js — shared PC-grid generator; regenerates the `devices` array
                  in data/*.json (was previously 4 copy-pasted inline loops)
data/
  gpl.json, library.json, mtl.json, s28-104.json, s28-107.json
  — each room's layout + device positions
rooms/
  gpl.html, library.html, mtl.html, s28-104.html, s28-107.html
  — page shell + a few lines of routing metadata (id/label/campus/back/dataUrl)
test/
  room.test.mjs   — drives room.js in jsdom; asserts on the DOM an intern touches
  rooms.smoke.mjs — renders all five real rooms; checks bounds and labels
```

## Running locally
The pages use `fetch()` to load each room's JSON and `<script type="module">`,
both of which require **http(s)**, not `file://`. Serve the folder locally:

```
python3 -m http.server 8000       # or: npm run serve
# then open http://localhost:8000/
```

(GitHub Pages, Netlify, Vercel, etc. all serve over http(s) automatically —
this only matters for opening the files directly by double-clicking them.)

## Tests
```
npm install     # jsdom, dev-only — the site itself has no dependencies
npm test
```

`test/room.test.mjs` renders a real room in jsdom and clicks through it the way
an intern would. It's the feedback loop to reach for **before** changing
`room.js`: it goes red on things that are easy to break silently — a status
saved under the wrong key, a device that can't be reached by keyboard, a popup
that swallows focus, one tab's save wiping another's.

## Using a room page
- **Tap a device** → popup with status + notes. Keyboard works too: devices are
  buttons, so Tab reaches them and Enter/Space opens the popup. Focus returns
  to the device you came from when the popup closes.
- **Quick mark** → arm a status in the toolbar, then one tap per device instead
  of four. `Undo` steps back through the sweep; `Esc` disarms.
- **Progress bar / "N unchecked"** → what's left in this room, so a half-finished
  sweep is obvious.
- **Orange corner dot** → that device has a note attached. Hover (or a screen
  reader) reads the note without opening anything.
- **Fit to screen / Actual size** → the floor plan is a fixed 1200×800-ish
  coordinate space; it's scaled to fit whatever screen you're on. On a phone,
  switch to Actual size when you need to tap accurately.

## Editing a room's PC grid
For the 4 grid-based rooms (gpl, mtl, s28-104, s28-107), edit the params in
`js/build-grid.js` and re-run:
```
node js/build-grid.js       # or: npm run build-grid
```
This regenerates only the `devices` field of the matching `data/*.json` —
`layout`, `canvasWidth`, `canvasHeight` are left untouched.

`library.json`'s devices are hand-placed (scattered clusters + staff desks +
printer), not a regular grid — edit `data/library.json` directly for that one.

Device labels longer than 5 characters get a wider chip automatically, so a
name like `STAFF-PC` isn't clipped. Devices typed `staff` get the wide chip
regardless.

## State & multi-device sync
Device statuses are saved in the browser's `localStorage` — **per browser,
per device**. Two people checking the same room from different computers
won't see each other's updates.

Within one browser it's now safe to keep several room tabs open: every save
re-reads storage before merging, and an open tab repaints when another tab
writes. (Previously a tab wrote back the snapshot it took at page load, which
silently reverted whatever another tab had saved since.)

As a practical workaround for moving state between machines, the menu page has:
- **Backup State (JSON)** — downloads the full raw state as a `.json` file
- **Restore State (JSON)** — loads a previously-downloaded backup (this
  *overwrites* current state, it doesn't merge)

True real-time sync across devices would require a small backend (a shared
database instead of localStorage).

## Known limitation: the CSV lists only devices that were touched
`export.js` builds its rows by scanning localStorage keys, so a device nobody
clicked has no row at all — a room that was never checked collapses to a single
"Not checked" line. Fixing this properly means giving `export.js` access to each
room's device roster, which currently lives only in `data/*.json`.
