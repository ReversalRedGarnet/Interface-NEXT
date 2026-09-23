/**
 * schema.js — the data/*.json room schema, in one place: field specs for
 * every layout shape and device, defaults for newly-placed items, and
 * exact-key-order (de)serialization so a room saved by the editor diffs
 * cleanly against a hand-authored file instead of silently reshuffling keys.
 *
 * Pure data/logic only — no DOM — so it can be unit-tested directly and
 * reused from both editor.js (browser) and room-scaffold.js.
 */

export const DEFAULT_CANVAS_WIDTH = 1200;
export const DEFAULT_CANVAS_HEIGHT = 800;

export const DEVICE_TYPES = ['pc', 'staff', 'printer'];

/** The one standard width every entrance/boundary-opening uses — no
 *  per-instance sizing. Matches the most common real hinge→jamb distance
 *  across data/*.json's existing doors (gpl 90, s28-107 90, mtl 99.7,
 *  s28-104 113 — 90 is both the mode and a clean number). */
export const ENTRANCE_WIDTH = 90;

/**
 * One entry per layout shape `type`. `fields` is the exact key order used
 * by the real data/*.json files (verified against every shape currently in
 * data/*.json); `counter`/`wallrect` don't appear in any real room yet, so
 * their order follows the same rect convention as the shapes that do.
 *
 * `door` and `entrance` are two different JSON shapes for historical
 * reasons: room.js (untouched, and not addressed by this schema) has two
 * separate hardcoded renderers — `entrance` draws a plain labeled rect from
 * x/y/width/height, `door` draws a hinge/jamb swing-arc. The editor now
 * only ever *creates* the door-shaped one (fixed at ENTRANCE_WIDTH, no
 * resize handles, no per-instance fields) and presents it everywhere in
 * its own UI as "entrance" — see SHAPE_DISPLAY_NAMES — so from the user's
 * side there is only one "entrance" concept, even though two JSON shapes
 * remain recognized so an existing rect-style entrance (data/library.json)
 * still loads, renders and edits correctly.
 */
export const LAYOUT_SHAPES = {
  outline:  { kind: 'polygon' },
  floor:    { kind: 'rect',   fields: ['x', 'y', 'width', 'height'] },
  room:     { kind: 'rect',   fields: ['x', 'y', 'width', 'height'], label: 'required', labelFirst: true },
  entrance: { kind: 'rect',   fields: ['x', 'y', 'width', 'height'], label: 'required', labelFirst: true },
  counter:  { kind: 'rect',   fields: ['x', 'y', 'width', 'height'] },
  wallrect: { kind: 'rect',   fields: ['x', 'y', 'width', 'height'] },
  wall:     { kind: 'line',   fields: ['x1', 'y1', 'x2', 'y2'] },
  door:     { kind: 'hinge',  fields: ['hinge', 'jamb'] },
};

export const LAYOUT_SHAPE_TYPES = Object.keys(LAYOUT_SHAPES);

/** Types offered in the placement palette — everything except the legacy
 *  rect-style `entrance`, which stays loadable/editable but isn't offered
 *  for new placement any more (superseded by `door`, displayed as
 *  "entrance"; see the LAYOUT_SHAPES comment above). */
export const PLACEABLE_SHAPE_TYPES = LAYOUT_SHAPE_TYPES.filter(t => t !== 'entrance');

/** UI label to show for a shape type — only `door` differs from its own
 *  type name, so `'door'` never surfaces in the editor's own interface. */
export const SHAPE_DISPLAY_NAMES = { door: 'entrance' };
export function shapeDisplayName(type) {
  return SHAPE_DISPLAY_NAMES[type] || type;
}

/** Default geometry for a newly-placed shape, anchored at (x, y). */
const SHAPE_FACTORIES = {
  outline:  (x, y) => ({ points: [[x, y], [x + 200, y], [x + 200, y + 150], [x, y + 150]] }),
  floor:    (x, y) => ({ x, y, width: 200, height: 150 }),
  room:     (x, y) => ({ x, y, width: 160, height: 120, label: 'Room' }),
  entrance: (x, y) => ({ x, y, width: 120, height: 80, label: 'Entrance' }),
  counter:  (x, y) => ({ x, y, width: 120, height: 40 }),
  wallrect: (x, y) => ({ x, y, width: 100, height: 20 }),
  wall:     (x, y) => ({ x1: x, y1: y, x2: x + 100, y2: y }),
  door:     (x, y) => ({ hinge: [x, y], jamb: [x + ENTRANCE_WIDTH, y] }),
};

export function createShape(type, x = 0, y = 0) {
  const factory = SHAPE_FACTORIES[type];
  if (!factory) throw new Error(`Unknown layout shape type: ${type}`);
  return { type, ...factory(x, y) };
}

/** Box size a device renders at — mirrors the CSS cascade in style.css
 *  exactly: `.pc.wide` (label > 5 chars) is declared after `.pc.staff`, so
 *  a long-labelled staff PC ends up 64px wide, not 52px. */
export function deviceBoxSize(device) {
  if (device.type === 'printer') return { width: 88, height: 44 };
  const label = String(device.label || device.id || '');
  if (label.length > 5) return { width: 64, height: 42 };
  if (device.type === 'staff') return { width: 52, height: 42 };
  return { width: 42, height: 42 };
}

/** Suggests the next free id for a newly-placed device — a starting point,
 *  not enforced; the properties panel lets it be renamed to anything. */
export function nextDeviceId(devices, type) {
  const prefix = type === 'printer' ? 'PRINTER' : type === 'staff' ? 'STAFF' : 'PC';
  const used = new Set(devices.map(d => d.id));
  if (type === 'printer' && !used.has(prefix)) return prefix;
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export function createDevice(devices, type, top = 0, left = 0) {
  return { id: nextDeviceId(devices, type), type, top, left };
}

export function snap(value, gridSize) {
  if (!gridSize) return value;
  return Math.round(value / gridSize) * gridSize;
}

/** Fills in defaults for anything missing/malformed, tolerating a hand-edited file. */
export function normalizeRoomData(data) {
  return {
    canvasWidth: Number(data?.canvasWidth) || DEFAULT_CANVAS_WIDTH,
    canvasHeight: Number(data?.canvasHeight) || DEFAULT_CANVAS_HEIGHT,
    layout: Array.isArray(data?.layout) ? data.layout.map(s => ({ ...s })) : [],
    devices: Array.isArray(data?.devices) ? data.devices.map(d => ({ ...d })) : [],
  };
}

export function createBlankRoomData(canvasWidth = DEFAULT_CANVAS_WIDTH, canvasHeight = DEFAULT_CANVAS_HEIGHT) {
  return { canvasWidth, canvasHeight, layout: [], devices: [] };
}

export function cloneRoomData(data) {
  return {
    canvasWidth: data.canvasWidth,
    canvasHeight: data.canvasHeight,
    layout: data.layout.map(s => (Array.isArray(s.points) ? { ...s, points: s.points.map(p => [...p]) } : { ...s })),
    devices: data.devices.map(d => ({ ...d })),
  };
}

function orderedShape(shape) {
  const spec = LAYOUT_SHAPES[shape.type];
  if (!spec) return { ...shape }; // unknown type — pass through untouched rather than drop data

  const out = { type: shape.type };
  const hasLabel = spec.label && (spec.label === 'required' || shape.label);

  if (spec.kind === 'polygon') {
    out.points = shape.points.map(p => [...p]);
    return out;
  }

  if (hasLabel && spec.labelFirst) out.label = shape.label ?? '';
  for (const f of spec.fields) out[f] = shape[f];
  if (hasLabel && !spec.labelFirst) out.label = shape.label;
  return out;
}

function orderedDevice(device) {
  const out = { id: device.id, type: device.type, top: device.top, left: device.left };
  if (device.label) out.label = device.label;
  if (device.assetId) out.assetId = device.assetId;
  return out;
}

/* ── data/assets.json — the assetId → {type, manufacturer, serial, notes}
 * lookup. A device's own `assetId` (see orderedDevice above) just points
 * into this file; room.js never reads it, same as any other field it
 * doesn't recognize. ── */

const ASSET_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ASSET_ID_SUFFIX_LENGTH = 6;

/** AST-<6 random base-36 chars> (e.g. AST-4K9QXZ): short enough to type or
 *  read aloud, and visually distinct from device ids (PC1, STAFF-PC, …) and
 *  room ids so the three id spaces are never confused. `rand` is injectable
 *  so tests can force a collision deterministically instead of relying on
 *  36^6 odds. Retries until the id isn't already a key in assetsData. */
export function generateAssetId(assetsData = {}, rand = Math.random) {
  let id;
  do {
    let suffix = '';
    for (let i = 0; i < ASSET_ID_SUFFIX_LENGTH; i++) {
      suffix += ASSET_ID_ALPHABET[Math.floor(rand() * ASSET_ID_ALPHABET.length)];
    }
    id = `AST-${suffix}`;
  } while (Object.prototype.hasOwnProperty.call(assetsData, id));
  return id;
}

/** A freshly-registered asset's starting record — every field present
 *  (blank) so opening data/assets.json shows the shape to fill in, rather
 *  than an empty `{}` with no hint of what belongs there. */
function blankAssetRecord() {
  return { type: '', manufacturer: '', serial: '', notes: '' };
}

/** Ensures `assetId` exists as a key in assetsData, without ever
 *  overwriting a record that's already there — a device pointing at an id
 *  someone already filled in shouldn't reset it back to blank. Returns a
 *  new object (assetsData is never mutated) plus whether it actually added
 *  anything, so callers only need to write data/assets.json when it did. */
export function registerAssetId(assetsData, assetId) {
  if (!assetId || Object.prototype.hasOwnProperty.call(assetsData, assetId)) {
    return { assets: assetsData, added: false };
  }
  return { assets: { ...assetsData, [assetId]: blankAssetRecord() }, added: true };
}

/** Tolerates a missing/malformed file (→ `{}`, same spirit as
 *  normalizeRoomData) but otherwise passes each record through untouched —
 *  extra fields someone hand-added to a record aren't the editor's to drop. */
export function normalizeAssetsData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const out = {};
  for (const [id, rec] of Object.entries(data)) {
    out[id] = (rec && typeof rec === 'object' && !Array.isArray(rec)) ? { ...rec } : {};
  }
  return out;
}

export function serializeAssetsData(assetsData) {
  return JSON.stringify(assetsData, null, 2) + '\n';
}

/**
 * Looks for another device — anywhere in the project — already using
 * `assetId`. This is the collision worth surfacing: device ids (PC1,
 * STAFF-PC, …) repeat freely across rooms, but assetId is meant to be a
 * project-wide identifier, so a match in a *different* room's file is the
 * case most worth catching, not just a duplicate within the room currently
 * open. Pure/non-blocking by design — it only reports what it finds; the
 * caller decides whether to warn, and never has to block on it.
 *
 * `rooms` is `[{ roomId, devices }, …]`. The caller supplies the current
 * room's *live* (possibly-unsaved) device list for its own entry rather
 * than re-reading its file from disk — an in-progress edit should never be
 * compared against its own stale on-disk copy — and on-disk devices for
 * every other room. `exclude` is the device being edited, so it never
 * reports a collision against its own current value.
 */
export function findAssetIdOwner(assetId, rooms, exclude) {
  if (!assetId) return null;
  for (const room of rooms) {
    for (const device of room.devices) {
      if (device.assetId !== assetId) continue;
      if (room.roomId === exclude.roomId && device.id === exclude.deviceId) continue;
      return { roomId: room.roomId, deviceId: device.id };
    }
  }
  return null;
}

/** Serializes back to the exact schema shape/key-order data/*.json already
 *  uses, 2-space indent + trailing newline, so an unedited round-trip
 *  through load→save reproduces the original file byte-for-byte (modulo
 *  the CRLF/LF the checkout applies via core.autocrlf). */
export function serializeRoomData(data) {
  const ordered = {
    canvasWidth: data.canvasWidth,
    canvasHeight: data.canvasHeight,
    layout: data.layout.map(orderedShape),
    devices: data.devices.map(orderedDevice),
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}
