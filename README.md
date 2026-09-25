# Gridkeep

A floor-plan view of every tracked device in a room. Checkers walk the room,
tap each device, and the status sticks. Reports come out as CSV.

## Structure
```
index.html      — campus view (birds-eye buildings/floors) + the site/room
                  menu, kept intact as a collapsed fallback (see "Campus
                  view" below)
issues.html, issues.css — global Issues view: every device currently
                  minor/major, across every room (see "Issues view" below)
tokens.css, base.css, layout.css, controls.css, navigation.css,
floor-plan.css, status.css, workstation.css, overlays.css, responsive.css
  — the visual system, split by concern (see "Visual system" below);
    loaded in that order on every page except admin/trace.html
js/
  main.js         — entry point (three modes: menu page / room page /
                    issues page); also fetches the project-wide
                    data/assets.json for the room page's inspector/search
                    (tolerant of it being missing)
  menu.js         — menu page: site toggles, export-all, backup/restore
  campus.js       — campus view: renders data/campus.json as clickable
                    building blocks, floor-picker overlay for multi-floor
                    buildings, lazy per-building stats (see "Campus view"
                    below)
  campus-data.js  — pure logic behind campus.js (normalize/find/decide);
                    no DOM, same split as schema.js vs canvas-renderer.js
  issues.js       — issues page wiring: fetches every room's roster, renders
                    the grouped/filterable list (see "Issues view" below)
  issues-logic.js — pure logic behind issues.js AND campus.js's building
                    stats (collectIssues/sortIssues/buildingStats/
                    buildingStatusKey); no DOM
  room.js       — the room page as a workstation: floor-plan SVG, device
                  rendering, the inspector panel, Inspection Mode, Next
                  Unchecked, filters, search, zoom/pan (see "Room
                  workstation" below)
  room-logic.js — pure logic behind room.js (inspection order, next-
                  unchecked, stats, filter/search matching); no DOM, same
                  split as campus-data.js/schema.js
  export.js     — roster-complete CSV reports + JSON state backup/restore
  state.js      — localStorage read/write helpers, incl. the one-time
                  old-shape → inspectionState/condition migration
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
  state.test.mjs      — the old-shape → inspectionState/condition migration,
                        run against representative old-shape sample data
  room-logic.test.mjs — room-logic.js's pure logic: inspection order,
                        next-unchecked, stats, filter/search matching, and
                        the fit-to-screen geometry (deviceFootprint,
                        computeContentBounds, computeFitScale/FitPan)
  export.test.mjs — buildRoomRows roster-completeness (every device gets a
                    row, untouched ones export as "Not Checked") and
                    fetchRoomDevices' tolerant-failure behavior
  room.test.mjs   — drives room.js in jsdom; asserts on the DOM a checker
                    touches (inspector, Inspection Mode, filters, search,
                    zoom/pan, keyboard shortcuts, save-status)
  rooms.smoke.mjs — renders all five rooms; checks bounds and labels
  editor.test.mjs — schema.js + room-scaffold.js: existing-room round-trip,
                    new-room 4-file generation, id-collision validation
  campus.test.mjs — campus-data.js's pure logic, data/campus.json sanity
                    checks, campus.js's rendering/click/keyboard behaviour,
                    and its lazy building-stats/tooltip behaviour, driven
                    in jsdom
  issues-logic.test.mjs — collectIssues/sortIssues/filterIssues/
                    summarizeIssues/buildingStats/buildingStatusKey; no DOM
  issues.test.mjs — drives issues.js in jsdom: grouping, filtering, the
                    empty state, and the roster-fetch-failure fallback
  tokens.test.mjs — permanent guard on the corner/divider design system:
                    radius tokens stay 0, --border-divider stays bold and
                    color-token-based, no stylesheet hardcodes a soft
                    border-radius outside the token system
```

## Visual system
Deliberately restrained — an operations console, not a dashboard: no
gradients, no glow, no hover-scale, no gloss on devices, no pulsing status
animation, minimal shadow, and borders (not shadows) as the primary way a
panel reads as separate from the page. Sharp corners and bold, high-contrast
structural dividers throughout, rather than soft rounded panels on faint
hairlines.

- `tokens.css` — every color/spacing/radius/type-scale value, named by role
  (`--surface`, `--text-secondary`, `--status-major`), never by literal
  color. Retinting the product means editing values in this one file only.
- Radius: `--radius-control`/`--radius-panel`/`--radius-pill` are all `0` —
  sharp corners everywhere (controls, panels, the inspector sidebar,
  floating panels, buttons, the campus building blocks). `--radius-pill`'s
  only consumer (`.summary-pill`) isn't actually rendered anywhere in the
  live app, so there's no live "tag" left that needs the rounded-pill
  exception the token used to carry; a future tag-style element that
  genuinely needs one is a one-line revert in `tokens.css`, not a reason to
  keep it soft today.
- Structural dividers: `--border-divider` (`2px solid var(--line-strong)`)
  is the one token for boundaries between whole regions of the page — the
  sidebar's own divider and its six internal section dividers, panel/card
  edges, the site header/footer rules, list-group headings.
  Bold and high-contrast on purpose, not a faint hairline, but still built
  from an existing color token (`--line-strong`), never a new one. Ordinary
  control borders (buttons, inputs, chips, per-item cards like a search
  result) are a different concern and stay on `--line` at their existing
  1–1.5px weight — this token is only for edges that separate one section
  of the page from another.
- Shadow: `--shadow-elevated` exists for exactly one purpose — a floating
  `.popup`/`.overlay`/`.floating-panel` sitting above dimmed content. No
  ordinary panel, card, button, or floor-plan device has a shadow; a border
  does that job instead.
- Spacing snaps to one scale: 4/8/12/16/24/32px (`--space-1`…`--space-8`).
- Type scale: page title 22–28px (`--text-page-title`), section title 16px
  (`--text-section-title`), body 13–14px (`--text-body`/`--text-body-lg`),
  metadata/ids/timestamps 11px (`--text-meta`, always `--font-mono`).
- A device's major-status urgency is a static heavier border, not an
  animated pulse — the existing text (aria-label, legend, summary pill
  count) already carries the same information. Any transition left in the
  system (button hover, a popup's fade-in) collapses under
  `prefers-reduced-motion` (see `responsive.css`).
- `admin/trace.css` is deliberately **not** part of this system — the
  internal trace tool is a one-off utility page, never linked from the
  app, with its own local `--radius` token, with no reason to share its
  design language (this pass's corner/divider tokens don't touch it).
- `test/tokens.test.mjs` is a permanent regression guard: it fails if a
  radius token stops being `0`, if `--border-divider` stops being bold or
  starts inventing a new color, or if any stylesheet hardcodes a soft
  border-radius pixel value outside the token system.

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

**Building stats.** Each building block stays just its name + floor count
until hovered or keyboard-focused — no full-building color fill, so the map
itself never gets cluttered with numbers. On hover/focus, a small floating
panel reveals real counts ("48 devices · 43 inspected · 5 remaining · 2
issues"), computed from that building's rooms' actual `data/*.json` rosters
+ stored inspection state via the same `computeStats` a room's own toolbar
uses (`js/issues-logic.js`'s `buildingStats`). A small static corner marker
on every block (not a fill) always shows overall state — not
inspected/in progress/complete/has issues, with **has issues** taking
priority over the others regardless of how much is left unchecked. Each
building's roster is fetched lazily (one building at a time, concurrently)
after the campus view itself has already rendered and become clickable, so
a slow or missing room data file never blocks the initial paint or holds up
any other building's stats.

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
saved under the wrong key, a device that can't be reached by keyboard, a
device that can't be re-selected in the inspector, one tab's save wiping
another's. `test/room-logic.test.mjs` covers the pure decision logic
(inspection order, next-unchecked, filter/search matching) directly, with
no DOM at all.

## Room workstation
The room page's inspector panel is always on screen — never a popup — so
inspecting a device never interrupts seeing the floor plan.

On desktop, the room body is an app-shell: the floor plan (most of the
width) and the sidebar (a fixed 320px column, its own `--surface-raised`
background and left-border divider, and its own independent scroll) are two
distinct regions, not one flat row — the header/breadcrumb stays a
full-width bar above the split, with no toolbar row left in it. Every
control the room page has — Next Unchecked, Search, zoom/pan, Inspection
Mode, Filter, room actions, Legend + Stats, and the device inspector — now
lives inside the sidebar itself, organized into six clearly divided
sections (see below) rather than split between a header toolbar and the
sidebar. On mobile the sidebar becomes a collapsible bottom sheet, closed to
a small handle by default so the floor plan stays the dominant thing on
screen; selecting a device or arming Inspection Mode opens it automatically
(see "Mobile bottom sheet" below). The floor plan auto-fits to the available
space on load, on resize, and via the **Fit** button in the sidebar's View
section — no manual click needed on load.

**Fit is a true maximum contain-fit.** It's computed from the room's actual
drawn extent — every wall/room/entrance/counter shape and every device's
real chip footprint (`computeContentBounds` in `room-logic.js`) — not the
room's nominal `canvasWidth`/`canvasHeight`, which is frequently larger than
what's actually drawn (every real room but one has real margin between its
canvas edges and its content). The scale is the largest that fits that true
bounding box inside the floor-plan pane's *actual current* width **and**
height (`computeFitScale`) — the original version only ever checked width,
which is what let the zoom-control strip overlap real room content on some
layouts; the fit view then centers that bounding box in the pane
(`computeFitPan`), not the room's raw `(0,0)` canvas origin, with a small
16px margin on every side rather than either butting against the edges or
leaving a large, wasted gap.

The sidebar hosts six sections, top to bottom, each its own clearly divided
group rather than one undifferentiated wall of controls (a divider — the
same `--border-divider` token used for every other structural seam in the
app — separates each section from the next):
1. **Primary actions** — Next Unchecked and Search, unlabeled since they're
   the whole point of the page and need no caption.
2. **View** — the zoom/pan strip, grouped here since it directly controls
   the adjacent canvas.
3. **Inspection Mode** — the toggle button; its active UI (the picker +
   banner, below) renders directly beneath it, in this same section, while
   armed.
4. **Secondary actions** — Filter, the **⋯** room-actions menu, and **?**
   help, visually lighter than the primary group (smaller `--text-meta`
   sizing, same as `.kbd`/the save-status text) since they're used less
   often.
5. **Legend + Stats** — collapsible, closed by default now that five other
   sections share the sidebar with it.
6. **The device inspector** — ordinary per-device detail, replaced by #3's
   active UI while Inspection Mode is armed.

Every device carries two independent fields (see "Inspection state vs.
condition" below): whether it's been looked at, and — only if it has —
whether it's working. Everything below is built on that.

- **Tap a device** → the sidebar (a side panel on desktop, a bottom sheet
  on mobile) shows its id, a 5-way status control (Working/Minor
  Issue/Major Issue/Not Applicable/Not Checked), any linked asset info
  (asset id/serial/manufacturer, read-only — set via the editor, not here),
  and notes. Status changes and notes autosave — there's no Save button —
  and a small **Saved**/**Saving…** indicator next to the device id
  confirms it went through.
- **→ Next Unchecked** → jumps straight to the next device still marked
  Unchecked (row-major: top-to-bottom, then left-to-right, derived from
  each device's own stored position), panning/zooming it into view and
  focusing its status control.
- **Inspection Mode**'s toggle button lives in its own sidebar section and
  stays there, visible, when armed — switching to its pressed look rather
  than disappearing, so there's always a visible, clickable trace of how
  you got into the mode and how to leave it. Its *active* UI — the
  Working/Minor/Major/N/A picker and a banner making the mode impossible to
  miss — renders directly beneath the toggle, in that same section,
  replacing the device inspector section further down while armed (clicking
  a device applies a status directly and never opens the inspector during
  this mode, so there's nothing useful for it to show anyway). The banner
  carries its own **Exit** button — not just text mentioning `Esc` — so the
  mode can be entered and exited entirely by mouse or touch, with no
  keyboard required. Clicking the toggle again, the active picker button
  again, the banner's Exit button, or `Esc` all turn it off the same way and
  hand the inspector section back to normal. `Undo` (in the room actions
  menu — see below) steps back through every change, however it was made.
  Resetting a device back to Not Checked isn't in this mode on purpose —
  that's a correction, not something you do while sweeping the room, so it
  stays an inspector/`0`-key action.
- **Legend + Stats** is a collapsible sidebar section, closed by default —
  the status legend (dot + label for each of the five statuses, plus "Has a
  note") and the stats line ("X devices · Y inspected · Z not applicable ·
  N remaining · M issues") that used to sit at the bottom of the page and in
  the room header, respectively. Both read at body-text size (13–15px,
  `--text-body-lg`), not the smaller metadata size they used to.
- **Filters** collapse behind a **Filter** toggle button (its own label
  shows the active filter, e.g. "Filter: Working", even while collapsed, so
  an active filter is never silently forgotten). Expanding it reveals
  All/Unchecked/Checked/Not Applicable/Working/Minor/Major/Notes;
  non-matching devices fade to ~25% opacity rather than disappearing, so
  where they sit relative to everything else is never lost. Picking "All"
  collapses the row back down. (The picker and the filter row each carry
  their own small caption — "Mark as" / "Filter" — specifically so the two
  Working/Minor/Major button groups are never ambiguous if both happen to
  be open at once.)
- **Room actions** (Undo, Export This Room, Export All Rooms, Reset This
  Room) live behind a single **⋯** overflow button — administrative actions
  that don't need to compete visually with the inspect-a-device loop.
- **Search** (`/` or Ctrl/⌘+K) → matches device id, label, asset id, serial,
  manufacturer, notes, and status, across every room (other rooms' data is
  fetched lazily, only once you actually search). Picking a result in
  another room navigates there and focuses that device automatically.
- **Zoom/pan** → the strip (−/Fit/100%/+/⛶) in the sidebar's View section,
  plus drag-to-pan on the canvas itself (mouse or touch). This is a view
  transform only — a device's stored `top`/`left` never changes, no matter
  how far you've zoomed or panned.
  Plain mouse-wheel scroll over the floor plan behaves like normal page
  scroll; **Ctrl+scroll** (**Cmd+scroll** on Mac) zooms instead, matching
  the browser's own "zoom the page" gesture so an ordinary scroll is never
  hijacked. A quiet hint next to the zoom controls says so.
- **Keyboard**: `1`/`2`/`3` mark the selected device Working/Minor/Major,
  `0` resets it to Not Checked, `N` jumps to its notes field, `U` undoes,
  `→` is Next Unchecked, `/` opens search, `F` fits the floor plan to
  screen, `Esc` exits Inspection Mode or closes whatever menu/dialog is
  open. Press `?` for the full list on screen — shortcuts are never
  mandatory or permanently displayed otherwise. Every shortcut dispatches on
  `document`, so relocating the button it mirrors never changes its key.
- **Mobile bottom sheet**: below 700px the sidebar becomes a fixed sheet
  anchored to the bottom of the viewport, collapsed by default to a small
  handle (`Controls & Inspector ▾`) — with six sections' worth of content
  now living in the sidebar, staying permanently open would leave little of
  the floor plan visible, so it opens only on request (tapping the handle)
  or automatically the moment it's actually needed: selecting a device, or
  arming Inspection Mode.

No emoji anywhere in the app — every icon is either a plain character
already used elsewhere (←, →, ↓, ↶, ↺, ⋯, ✕) or a small flat outline SVG
(`.icon` in controls.css), sized in `em` and colored via `currentColor` so
it always matches its own button.

Every transient panel that floats above the base layout — the Mark-as
picker, the expanded filter row, the room-actions overflow menu, search
results, the shortcuts help — shares one `.floating-panel` treatment
(`--surface-raised` background, a `--line` border, `--shadow-elevated`) in
workstation.css, so each one reads as floating rather than each inventing
its own look.

## Inspection state vs. condition
A device's status is two independent fields, not one:

- **Inspection state** — `unchecked` (default) | `checked` | `not-applicable`
- **Condition** — `working` | `minor` | `major`, meaningful only when the
  inspection state is `checked`

So a device is always exactly one of: unchecked, not applicable, or checked
with a condition. This split exists so "hasn't been looked at yet" and
"intentionally excluded from this sweep" are never confused with each
other or folded into the working/minor/major scale.

`state.js` stores this as `{ inspectionState, condition, notes, updatedAt }`
per device, keyed the same way as before
(`ROOMID_DEVICEID`). Older data saved before this split (a single `status`
of `working`/`minor`/`major`/`unknown`) is migrated transparently on every
read — `working`/`minor`/`major` become `checked` + that condition, and
`unknown` (or a missing/malformed status) becomes `unchecked` — without
ever deleting anything from `localStorage`. The migration only becomes
permanent in storage the next time that data is actually saved; opening
the app read-only never rewrites anything. See `test/state.test.mjs` for
the migration tests, run against representative old-shape sample data.

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

## CSV / report export
The CSV is roster-complete: it always has one row per device that actually
exists in that room's `data/*.json` (or, for "Export All Rooms", every
room's), whether or not anyone has ever touched it — an untouched device
exports as "Not Checked" rather than being silently absent. `export.js`
fetches each room's device list itself (a room page that already has its
own devices loaded skips that fetch and passes them straight in); rows sort
worst-first (major, minor, unchecked, working, not applicable). See
`test/export.test.mjs`.

## Issues view
`issues.html` is a read-only rollup of every device currently minor/major,
across every room — built entirely on the existing inspection-state/
condition data (`js/issues-logic.js`'s `collectIssues`), not a new
Issue-object model: no issue ids, no lifecycle (open/in progress/resolved),
no history. It re-fetches every room's roster the same way "Export All
Rooms" does, so it's always roster-accurate, then filters to whatever's
currently `checked` + `minor`/`major`.

Entries group by site then room (worst condition first within a room) and
carry a device's note, if it has one. A three-way All/Major/Minor filter
narrows the visible list without changing the summary line's totals.
Selecting an entry navigates to `rooms/{stem}.html?focus={deviceId}` — the
exact same cross-room deep link search results already use, so it reuses
room.js's own existing `focusDevice()` pan/zoom/select instead of
reimplementing it. "Issues" sits alongside "Campus" as a primary nav
destination in every page's header (`.site-nav`, `layout.css`). See
`test/issues-logic.test.mjs` (pure aggregation) and `test/issues.test.mjs`
(the page itself, driven in jsdom).
