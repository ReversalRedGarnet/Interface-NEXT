/**
 * room-templates.js — Room Type templates for the New Room flow: generates a
 * starting layout (walls, entrance, devices) for a handful of common room
 * shapes, using the exact same data/*.json schema (schema.js) any
 * manually-built room uses. There is no separate "template mode" — the
 * generated room is a normal, fully-editable draft the instant it's created,
 * same as createBlankRoomData's output; this module just produces a
 * different starting `layout`/`devices` than an empty room would.
 *
 * Pure/DOM-free, like schema.js and room-scaffold.js, so it's testable
 * directly under Node.
 *
 * PC grid spacing (120x120) is not arbitrary — it's measured from the two
 * existing regular-grid rooms (data/b2-210.json, data/b2-204.json; see
 * js/build-grid.js's ROOM_GRIDS), so a generated Computer Lab reads at the
 * same visual density as a real one rather than inventing new spacing.
 */
import { createBlankRoomData, nextDeviceId, ENTRANCE_WIDTH } from './schema.js';

export const ROOM_TEMPLATES = ['blank', 'computer-lab', 'office', 'network-room'];

export const ROOM_TEMPLATE_LABELS = {
  blank: 'Blank',
  'computer-lab': 'Computer Lab',
  office: 'Office',
  'network-room': 'Network Room',
};

/** Reasonable default canvas size per template — Blank/Computer Lab keep the
 *  dialog's existing 1200×800 default; Office defaults a bit smaller (no
 *  real office room exists yet in this project to measure, so this is a
 *  judgment call, not a measurement); Network Room defaults smaller still,
 *  per spec ("this is normally a small room"). All are just starting values
 *  in the dialog — the width/height fields stay freely editable. */
export const ROOM_TEMPLATE_DEFAULT_SIZE = {
  blank: { width: 1200, height: 800 },
  'computer-lab': { width: 1200, height: 800 },
  office: { width: 900, height: 600 },
  'network-room': { width: 500, height: 400 },
};

/** Only templates with an entry here ask for a device count in the dialog —
 *  Network Room's device set is fixed (one each of server/switch/router/ups),
 *  same as Blank needing no count at all. */
export const ROOM_TEMPLATE_DEFAULT_COUNT = {
  'computer-lab': 24,
  office: 5,
};

export function templateNeedsCount(templateId) {
  return Object.prototype.hasOwnProperty.call(ROOM_TEMPLATE_DEFAULT_COUNT, templateId);
}

const WALL_MARGIN = 60;

/**
 * A plain rectangular room boundary: a `floor` rect, four `wall` segments
 * tracing it, and one `door` (hinge/jamb — the same shape the editor itself
 * creates for a new entrance; see schema.js's LAYOUT_SHAPES comment) centered
 * in the bottom wall. Shared by all three templates below since the spec
 * calls for the same "rectangular boundary + entrance" shape in each.
 */
function roomBoundary(x, y, width, height) {
  const doorHingeX = x + width / 2 - ENTRANCE_WIDTH / 2;
  const doorJambX = doorHingeX + ENTRANCE_WIDTH;
  return [
    { type: 'floor', x, y, width, height },
    { type: 'wall', x1: x, y1: y, x2: x + width, y2: y },
    { type: 'wall', x1: x + width, y1: y, x2: x + width, y2: y + height },
    { type: 'wall', x1: x + width, y1: y + height, x2: doorJambX, y2: y + height },
    { type: 'wall', x1: doorHingeX, y1: y + height, x2: x, y2: y + height },
    { type: 'wall', x1: x, y1: y + height, x2: x, y2: y },
    { type: 'door', hinge: [doorHingeX, y + height], jamb: [doorJambX, y + height] },
  ];
}

/** Rows of `pc` devices at the same 120×120 spacing as data/b2-210.json and
 *  data/b2-204.json's real grids, wrapping to another row once a row can't
 *  fit any more columns in the available width — a front strip on the left
 *  (matching data/commons.json's staff/printer corner placement) stays clear
 *  of the grid for one `staff` "Teacher" station and one `printer`. */
function computerLabTemplate(canvasWidth, canvasHeight, pcCount = ROOM_TEMPLATE_DEFAULT_COUNT['computer-lab']) {
  const x = WALL_MARGIN, y = WALL_MARGIN;
  const width = Math.max(canvasWidth - WALL_MARGIN * 2, 200);
  const height = Math.max(canvasHeight - WALL_MARGIN * 2, 200);
  const layout = roomBoundary(x, y, width, height);

  const rowGap = 120, colGap = 120;
  const gridLeft = x + 200;
  const gridTop = y + 110;
  const endMargin = 80;
  const availableWidth = Math.max(x + width - endMargin - gridLeft, colGap);
  const cols = Math.max(1, Math.floor(availableWidth / colGap) + 1);

  const count = Math.max(1, Math.round(Number(pcCount)) || ROOM_TEMPLATE_DEFAULT_COUNT['computer-lab']);
  const devices = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    devices.push({
      id: nextDeviceId(devices, 'pc'), type: 'pc',
      top: gridTop + row * rowGap, left: gridLeft + col * colGap,
    });
  }
  devices.push({ id: nextDeviceId(devices, 'staff'), type: 'staff', top: y + 30, left: x + 30, label: 'Teacher' });
  devices.push({ id: nextDeviceId(devices, 'printer'), type: 'printer', top: y + 140, left: x + 30 });

  return { layout, devices };
}

/** `staff` devices standing in for desks, spaced looser than a lab's PC grid
 *  (offices are less uniform — see spec) and wrapping rows the same way the
 *  lab's grid does; one `printer` and one generic `furniture` ("Cabinet")
 *  sit along the back wall. */
function officeTemplate(canvasWidth, canvasHeight, deskCount = ROOM_TEMPLATE_DEFAULT_COUNT.office) {
  const x = WALL_MARGIN, y = WALL_MARGIN;
  const width = Math.max(canvasWidth - WALL_MARGIN * 2, 200);
  const height = Math.max(canvasHeight - WALL_MARGIN * 2, 200);
  const layout = roomBoundary(x, y, width, height);

  const deskGap = 150, rowGap = 130;
  const rowLeft = x + 60;
  const rowTop = y + 60;
  const endMargin = 60;
  const availableWidth = Math.max(x + width - endMargin - rowLeft, deskGap);
  const perRow = Math.max(1, Math.floor(availableWidth / deskGap) + 1);

  const count = Math.max(1, Math.round(Number(deskCount)) || ROOM_TEMPLATE_DEFAULT_COUNT.office);
  const devices = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    devices.push({
      id: nextDeviceId(devices, 'staff'), type: 'staff',
      top: rowTop + row * rowGap, left: rowLeft + col * deskGap,
      label: `Staff ${i + 1}`,
    });
  }
  devices.push({ id: nextDeviceId(devices, 'printer'), type: 'printer', top: y + height - 90, left: x + 30 });
  devices.push({
    id: nextDeviceId(devices, 'furniture'), type: 'furniture',
    top: y + height - 90, left: x + width - 90, label: 'Cabinet',
  });

  return { layout, devices };
}

/** One each of server/switch/router/ups, clustered as a 2×2 rack area
 *  (tighter spacing than either other template — this is meant to read as
 *  one equipment cluster, not devices spread across open floor) rather than
 *  a count-driven grid — the spec calls for exactly one of each, not a
 *  variable count. */
function networkRoomTemplate(canvasWidth, canvasHeight) {
  const x = WALL_MARGIN, y = WALL_MARGIN;
  const width = Math.max(canvasWidth - WALL_MARGIN * 2, 150);
  const height = Math.max(canvasHeight - WALL_MARGIN * 2, 150);
  const layout = roomBoundary(x, y, width, height);

  const rackLeft = x + width / 2 - 60;
  const rackTop = y + 60;
  const devices = [];
  devices.push({ id: nextDeviceId(devices, 'server'), type: 'server', top: rackTop, left: rackLeft });
  devices.push({ id: nextDeviceId(devices, 'switch'), type: 'switch', top: rackTop, left: rackLeft + 70 });
  devices.push({ id: nextDeviceId(devices, 'router'), type: 'router', top: rackTop + 70, left: rackLeft });
  devices.push({ id: nextDeviceId(devices, 'ups'), type: 'ups', top: rackTop + 70, left: rackLeft + 70 });

  return { layout, devices };
}

const TEMPLATE_BUILDERS = {
  'computer-lab': computerLabTemplate,
  office: officeTemplate,
  'network-room': networkRoomTemplate,
};

/**
 * Builds a full room-data object (same shape as createBlankRoomData's
 * output — status "draft", the given canvas size, plus a generated
 * layout/devices) for one of the non-blank templates. `count` is ignored by
 * templates that don't ask for one (see templateNeedsCount). Blank isn't
 * handled here at all — the New Room flow keeps calling createBlankRoomData
 * directly for it, unchanged, so this module never touches that path.
 */
export function generateTemplateRoomData(templateId, canvasWidth, canvasHeight, count) {
  const builder = TEMPLATE_BUILDERS[templateId];
  if (!builder) throw new Error(`Unknown room template: ${templateId}`);
  const { layout, devices } = builder(canvasWidth, canvasHeight, count);
  return { ...createBlankRoomData(canvasWidth, canvasHeight), layout, devices };
}
