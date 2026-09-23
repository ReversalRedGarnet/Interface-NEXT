# Gridkeep

A floor-plan view of every tracked device in a room. Checkers walk the room,
tap each device, and the status sticks. Reports come out as CSV.

## Structure
```
index.html      — campus view (birds-eye buildings/floors) + the site/room
                  menu, kept intact as a collapsed fallback (see "Campus
                  view" below)
style.css
js/
  main.js         — entry point (dual-mode: menu page vs room page)
  menu.js         — menu page: site toggles, export-all, backup/restore
  campus.js       — campus view: renders data/campus.json as clickable
                    building blocks, floor-picker overlay for multi-floor
                    buildings (see "Campus view" below)
  campus-data.js  — pure logic behind campus.js (normalize/find/decide);
                    no DOM, same split as schema.js vs canvas-renderer.js
  room.js       — room page: floor-plan SVG, device rendering, quick-mark,
                  popups, progress, state
  export.js     — CSV reports + JSON state backup/restore
  state.js      — localStorage read/write helpers
  format.js     — date formatting helpers
  build-grid.js — shared PC-grid generator; regenerates the `devices` array
                  in data/*.json (was previously 4 copy-pasted inline loops)
data/
  annex.json, b2-204.json, b2-210.json, commons.json, workshop.json
  — each room's layout + device positions
  campus.json — buildings/floors for the campus view; each floor just
                points at one of the roomIds above (see "Campus view" below)
  assets.json — assetId → {type, manufacturer, serial, notes} lookup, shared
                across every room (see "Editing rooms visually" below)
rooms/
  annex.html, b2-204.html, b2-210.html, commons.html, workshop.html
  — page shell + a few lines of routing metadata (id/label/campus/back/dataUrl)
editor.html, editor.css
  — drag-and-drop floor-plan editor; see "Editing rooms visually" below
js/editor/
  editor.js          — page wiring: File System Access I/O, room picker,
                        tool palette, properties panel, new-room dialog
  canvas-renderer.js — draws the editable SVG surface (independent of
                        room.js's own read-only drawLayout)
  tools.js           — pointer-driven drag/place/select + grid snapping
  schema.js           — the data/*.json schema: shape/device field specs,
                        defaults, exact-key-order (de)serialization
  room-scaffold.js   — generates rooms/{id}.html, patches index.html and
                        js/export.js's ALL_ROOMS, and the cross-file
                        id-collision check for a brand-new room
test/
  room.test.mjs   — drives room.js in jsdom; asserts on the DOM a checker touches
  rooms.smoke.mjs — renders all five rooms; checks bounds and labels
  editor.test.mjs — schema.js + room-scaffold.js: existing-room round-trip,
                    new-room 4-file generation, id-collision validation
  campus.test.mjs — campus-data.js's pure logic, data/campus.json sanity
                    checks, and campus.js's rendering/click/keyboard
                    behaviour driven in jsdom
```

## Campus view (prototype)
`index.html` opens on a birds-eye schematic of buildings (`data/campus.json`),
one level up in scale from a room's own floor plan. Clicking a building with
one floor goes straight into that floor's existing room page; a building
with more than one floor opens a picker first. Every floor is just an
existing room id — `room.js`, `schema.js`, and the five `data/*.json` room
files are completely untouched by this layer; it only adds a new page
section, `data/campus.json`, and `js/campus.js`/`js/campus-data.js`.

The existing site/room menu is still there underneath, collapsed by default
("Browse all rooms (list view)") — it's what `js/editor/room-scaffold.js`'s
New Room flow patches when the drag-and-drop editor scaffolds a room, so its
exact markup (`.site-grid`/`.site-card`/`.room-list`) had to stay intact
rather than being replaced by the campus view.

`data/campus.json` shape:
```json
{
  "canvasWidth": 1000, "canvasHeight": 460,
  "buildings": [
    { "id": "commons-hall", "label": "Commons Hall",
      "shape": { "x": 60, "y": 180, "width": 220, "height": 200 },
      "floors": [ { "roomId": "commons", "label": "Commons" } ] }
  ]
}
```
Seeded with 3 placeholder buildings (mixed single/multi-floor) built from
the 5 existing rooms — no new room data was invented for this prototype.
There's no campus-view equivalent of the drag-and-drop editor yet; add or
move a building by hand-editing `data/campus.json`.

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
a checker would. It's the feedback loop to reach for **before** changing
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

## Editing a room's device grid
For the 4 grid-based rooms (annex, workshop, b2-204, b2-210), edit the params in
`js/build-grid.js` and re-run:
```
node js/build-grid.js       # or: npm run build-grid
```
This regenerates only the `devices` field of the matching `data/*.json` —
`layout`, `canvasWidth`, `canvasHeight` are left untouched.

`commons.json`'s devices are hand-placed (scattered clusters + staff desks +
printer), not a regular grid — edit `data/commons.json` directly for that one.

Device labels longer than 5 characters get a wider chip automatically, so a
name like `STAFF-PC` isn't clipped. Devices typed `staff` get the wide chip
regardless. `type` itself is free text — `pc`/`staff`/`printer` are the only
values room.js renders specially, but the editor's Type field will suggest
those plus a few generic asset examples (`peripheral`, `furniture`, `network
gear`); anything else typed in is preserved as-is.

## Editing rooms visually
`editor.html` is a drag-and-drop floor-plan editor for `data/*.json` — no more
hand-editing coordinates. It needs a **Chromium-based browser** (Chrome or
Edge): it uses the File System Access API to read and write project files
directly, which is the only way it persists anything (there's no server or
build step here, and download-then-manually-replace didn't scale to
iterative edits). Firefox/Safari will show a message explaining this rather
than silently failing.

1. Open `editor.html` over **localhost or https** (e.g. `npm run serve`) and
   click **Open Project Folder** — grant it access to the repo root. The
   File System Access API isn't available in an insecure context, so a
   plain-http LAN address (e.g. `http://192.168.x.x:8000`) won't work even
   in Chrome — `http://localhost:8000` does.
2. Pick an existing room to edit its floor plan and devices, or **New
   Room…** to scaffold one from scratch.
3. Arm a tool (a device type or a layout shape) in the sidebar and click
   the canvas to place it. Reposition anything already placed either way:
   press-drag-release, or click it once to select (no drag) and click a
   destination point to send it there — both snap to the grid size shown
   in the sidebar and land at the same spot; Escape cancels a pending
   click-to-move before you've clicked the destination. Dragging a
   rectangular shape's corner handle (room/wallrect/floor/entrance/counter,
   or a 4-point outline) always resizes it — the opposite corner stays put
   and it can't be skewed into a non-rectangle. Select an item to edit its
   exact fields (position, size, label, …) in the Properties panel, or
   delete it.
4. **Save** writes `data/{id}.json` (and, if step 3 registered a new asset
   id — see below — `data/assets.json` too). Editing a room never touches
   `rooms/*.html`, `index.html`, or `js/export.js`.

**Asset ID** is an optional field on a selected device, for linking it to
inventory/asset-tracking info kept outside the room's own layout data.
Type one in by hand, or click **Generate** to fill in an unused id in the
form `AST-` + 6 random letters/digits (e.g. `AST-4K9QXZ`) — short, easy to
read aloud, and visually distinct from device ids (`PC1`, `STAFF-PC`, …) so
the two are never confused. Leaving it blank is fine; `room.js` doesn't
read this field at all, same as any other field it doesn't recognize.

Every asset id, wherever it came from, is a key into `data/assets.json` —
one lookup file shared across every room, mapping `assetId → {type,
manufacturer, serial, notes}`. Setting an id the editor hasn't seen before
adds a blank record for it there (`data/assets.json` is created on first
use if it doesn't exist yet); setting an id that's already a key just
links the device to that existing record without touching its data. The
editor never edits `type`/`manufacturer`/`serial`/`notes` themselves — fill
those in by hand (or with other tooling) once the id exists.

**New Room** is different: a room only shows up on the menu and in CSV
exports if four things agree (see "Known limitation" below and
`js/export.js`'s `ALL_ROOMS`), so creating one writes all four together
*after* checking the id doesn't collide with anything already using it
(case-insensitively, since two ids differing only in case would collide as
Windows filenames even though `localStorage` keys are case-sensitive):
`data/{id}.json`, `rooms/{id}.html`, a new link in `index.html` (a new
site card too, if the site doesn't exist yet), and a new entry in
`ALL_ROOMS`. If a later file in that sequence fails to write, the editor
reports exactly which files it did write so the rest can be finished by
hand — there's no way to make four separate file writes atomic in a
browser.

Two things the editor deliberately leaves alone — update them by hand if a
new room needs them:
- `test/rooms.smoke.mjs`'s `ROOMS` list — a new room isn't smoke-tested
  until it's added there.
- `js/build-grid.js`'s `ROOM_GRIDS` — only relevant if you want a new
  room's devices generated from a regular grid formula instead of the
  editor's placement; the 4 existing grid rooms use it, the editor doesn't
  need it.

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
