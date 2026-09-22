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
  return out;
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
