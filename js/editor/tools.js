/**
 * tools.js — turns pointer events on the canvas into edits: placing a new
 * device/shape when a palette tool is armed, or selecting-and-moving an
 * existing one (whole shape, or a single endpoint/vertex/corner handle)
 * when the select tool is active. Position updates go through schema.js's
 * `snap`, so any move always lands on the grid.
 *
 * Two interchangeable ways to reposition a placed device or shape:
 *   - press-drag-release: pointerdown on it, move, release.
 *   - click-then-click: a plain click (no movement) selects it and arms
 *     "move pending"; the next click anywhere on the canvas is read as the
 *     destination point, and that click is consumed rather than starting
 *     its own select/drag — so the two modes never fight over the same
 *     gesture. Escape cancels a pending move.
 * Both resolve to the same underlying translate math, so dragging a
 * device from its exact top-left corner to point D and click-clicking it
 * to D land it at the identical position.
 *
 * Mutates `state.data` in place (the same object editor.js holds), then
 * calls `onChange(patch)` so editor.js can merge selection/dirty bits and
 * re-render. Browser-only (pointer events + SVG hit-testing); not unit
 * tested for the same reason canvas-renderer.js isn't — the geometry
 * helpers below (resizeRect, resizeRectOutline, shapeAnchor) are the
 * exception and are covered directly in editor.test.mjs.
 */
import { LAYOUT_SHAPES, createDevice, createShape, snap } from './schema.js';
import { hitTest, clientToSvgPoint } from './canvas-renderer.js';

/** Minimum drag distance (in SVG units, pre-snap) before a press-release is
 *  treated as a drag rather than a plain click. */
const CLICK_MOVE_THRESHOLD = 2;

export function cloneShapeGeometry(shape) {
  const spec = LAYOUT_SHAPES[shape.type];
  if (!spec) return {};
  switch (spec.kind) {
    case 'rect':    return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
    case 'line':    return { x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2 };
    case 'hinge':   return { hinge: [...shape.hinge], jamb: [...shape.jamb] };
    case 'circle':  return { cx: shape.cx, cy: shape.cy };
    case 'polygon': return { points: shape.points.map(p => [...p]) };
    default:        return {};
  }
}

function translateShape(shape, orig, dx, dy, gridSize) {
  const spec = LAYOUT_SHAPES[shape.type];
  if (!spec) return;
  switch (spec.kind) {
    case 'rect':
      shape.x = snap(orig.x + dx, gridSize);
      shape.y = snap(orig.y + dy, gridSize);
      break;
    case 'line':
      shape.x1 = snap(orig.x1 + dx, gridSize); shape.y1 = snap(orig.y1 + dy, gridSize);
      shape.x2 = snap(orig.x2 + dx, gridSize); shape.y2 = snap(orig.y2 + dy, gridSize);
      break;
    case 'hinge':
      shape.hinge = [snap(orig.hinge[0] + dx, gridSize), snap(orig.hinge[1] + dy, gridSize)];
      shape.jamb = [snap(orig.jamb[0] + dx, gridSize), snap(orig.jamb[1] + dy, gridSize)];
      break;
    case 'circle':
      shape.cx = snap(orig.cx + dx, gridSize);
      shape.cy = snap(orig.cy + dy, gridSize);
      break;
    case 'polygon':
      shape.points = orig.points.map(([x, y]) => [snap(x + dx, gridSize), snap(y + dy, gridSize)]);
      break;
  }
}

/** The point a whole-shape click-then-click move treats as "this is what
 *  lands on the destination" — the shape's own first/primary coordinate,
 *  the same convention createShape() anchors new shapes at. */
export function shapeAnchor(shape) {
  const spec = LAYOUT_SHAPES[shape.type];
  if (!spec) return null;
  switch (spec.kind) {
    case 'rect':    return [shape.x, shape.y];
    case 'line':    return [shape.x1, shape.y1];
    case 'hinge':   return [shape.hinge[0], shape.hinge[1]];
    case 'circle':  return [shape.cx, shape.cy];
    case 'polygon': return [shape.points[0][0], shape.points[0][1]];
    default:        return null;
  }
}

/* ── Rect-kind corner resize (floor/room/entrance/counter/wallrect) ──
   Corner tags are compass points; the tag names which corner is being
   dragged, so the OPPOSITE corner is the one held fixed. Because a
   rect-kind shape is only ever {x,y,width,height}, this can never produce
   a non-rectangular result — there are no independent corner coordinates
   to fall out of sync. Dragging through the opposite corner flips the
   rectangle (standard resize-handle behaviour) rather than going negative;
   width/height are floored at 1 so the shape never disappears mid-drag. */

function cornerPointForTag(orig, tag) {
  const x = tag.includes('w') ? orig.x : orig.x + orig.width;
  const y = tag.includes('n') ? orig.y : orig.y + orig.height;
  return [x, y];
}

export function resizeRect(shape, tag, orig, newX, newY) {
  const anchorX = tag.includes('w') ? orig.x + orig.width : orig.x;
  const anchorY = tag.includes('n') ? orig.y + orig.height : orig.y;
  shape.x = Math.min(newX, anchorX);
  shape.y = Math.min(newY, anchorY);
  shape.width = Math.max(1, Math.abs(newX - anchorX));
  shape.height = Math.max(1, Math.abs(newY - anchorY));
}

/* ── 4-point outline corner-lock ──────────────────────────────────────
   An `outline` is a free polygon (a 6-point L-shape is a legitimate real
   room boundary), so this constraint applies only when it currently is a
   4-point axis-aligned rectangle — the shape a new outline starts as.
   Anything else (an L-shape, a hand-edited irregular polygon) keeps free
   per-vertex dragging, which is correct there. */

export function isAxisAlignedRect4(points) {
  if (!Array.isArray(points) || points.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % 4];
    if (Math.abs(x0 - x1) > 1e-6 && Math.abs(y0 - y1) > 1e-6) return false;
  }
  return true;
}

/** Drags vertex `draggedIdx` to (newX, newY); each of its two neighbours
 *  inherits whichever single axis it originally shared with that vertex
 *  (found from the pre-drag geometry, not assumed by position), so the
 *  diagonal-opposite vertex never moves and every edge stays axis-aligned —
 *  i.e. it can only ever resize as a rectangle, never skew. */
export function resizeRectOutline(shape, orig, draggedIdx, newX, newY) {
  const n = orig.points.length;
  const points = orig.points.map(p => [...p]);
  points[draggedIdx] = [newX, newY];
  const [dx0, dy0] = orig.points[draggedIdx];

  [(draggedIdx - 1 + n) % n, (draggedIdx + 1) % n].forEach(ni => {
    const [ox, oy] = orig.points[ni];
    if (Math.abs(ox - dx0) < 1e-6) points[ni][0] = newX;
    if (Math.abs(oy - dy0) < 1e-6) points[ni][1] = newY;
  });

  shape.points = points;
}

const RECT_CORNER_TAGS = ['nw', 'ne', 'se', 'sw'];

function movePoint(shape, point, orig, dx, dy, gridSize) {
  const spec = LAYOUT_SHAPES[shape.type];

  if (spec?.kind === 'rect' && RECT_CORNER_TAGS.includes(point)) {
    const [ox, oy] = cornerPointForTag(orig, point);
    resizeRect(shape, point, orig, snap(ox + dx, gridSize), snap(oy + dy, gridSize));
    return;
  }

  if (point === 'x1y1') {
    shape.x1 = snap(orig.x1 + dx, gridSize); shape.y1 = snap(orig.y1 + dy, gridSize);
    return;
  }
  if (point === 'x2y2') {
    shape.x2 = snap(orig.x2 + dx, gridSize); shape.y2 = snap(orig.y2 + dy, gridSize);
    return;
  }

  const idx = Number(point);
  if (Number.isInteger(idx) && orig.points?.[idx]) {
    const [ox, oy] = orig.points[idx];
    const newX = snap(ox + dx, gridSize);
    const newY = snap(oy + dy, gridSize);
    if (isAxisAlignedRect4(orig.points)) {
      resizeRectOutline(shape, orig, idx, newX, newY);
    } else {
      shape.points[idx] = [newX, newY];
    }
  }
}

/** Moves a whole selected device/shape so its anchor point lands exactly
 *  at `destPoint` — the click-then-click counterpart to drag-translate.
 *  Silently no-ops if the target no longer exists (e.g. deleted while a
 *  move was pending). */
function moveTargetTo(state, target, destPoint) {
  if (target.kind === 'device') {
    const device = state.data.devices[target.index];
    if (!device) return;
    device.left = snap(destPoint.x, state.gridSize);
    device.top = snap(destPoint.y, state.gridSize);
  } else if (target.kind === 'shape') {
    const shape = state.data.layout[target.index];
    if (!shape) return;
    const anchor = shapeAnchor(shape);
    if (!anchor) return;
    const orig = cloneShapeGeometry(shape);
    translateShape(shape, orig, destPoint.x - anchor[0], destPoint.y - anchor[1], state.gridSize);
  }
}

/**
 * Wires pointer interactions onto `svg`. `getState()` must return the live
 * editor state ({ data, tool, gridSize }) — mutations below write straight
 * into `state.data`. `onChange(patch)` is called after every meaningful
 * change (placement, drag step, selection, move) so the caller can merge
 * the patch and re-render.
 */
export function createToolController(svg, getState, onChange) {
  let drag = null;   // in-progress press-drag-release gesture
  let pending = null; // { kind, index } armed by a plain click, awaiting its destination click

  function pointerDown(evt) {
    if (evt.button !== undefined && evt.button !== 0) return;
    const state = getState();
    const p = clientToSvgPoint(svg, evt.clientX, evt.clientY);

    if (state.tool?.type === 'add-device') {
      const device = createDevice(
        state.data.devices, state.tool.deviceType,
        snap(p.y, state.gridSize), snap(p.x, state.gridSize),
      );
      state.data.devices.push(device);
      onChange({ selection: { kind: 'device', index: state.data.devices.length - 1 }, tool: { type: 'select' }, dirty: true });
      return;
    }

    if (state.tool?.type === 'add-shape') {
      const shape = createShape(state.tool.shapeType, snap(p.x, state.gridSize), snap(p.y, state.gridSize));
      state.data.layout.push(shape);
      onChange({ selection: { kind: 'shape', index: state.data.layout.length - 1 }, tool: { type: 'select' }, dirty: true });
      return;
    }

    // Click-then-click: this pointerdown is read as the destination, not a
    // new select/drag — the two modes never both act on the same click.
    if (pending) {
      moveTargetTo(state, pending, p);
      pending = null;
      onChange({ dirty: true });
      evt.preventDefault();
      return;
    }

    const hit = hitTest(evt);
    if (!hit) {
      onChange({ selection: null });
      return;
    }

    if (hit.kind === 'device') {
      const device = state.data.devices[hit.index];
      drag = { kind: 'device', index: hit.index, start: p, moved: false, orig: { top: device.top, left: device.left } };
    } else if (hit.kind === 'shape') {
      drag = { kind: 'shape', index: hit.index, start: p, moved: false, orig: cloneShapeGeometry(state.data.layout[hit.index]) };
    } else if (hit.kind === 'shape-point') {
      drag = { kind: 'shape-point', index: hit.index, point: hit.point, start: p, moved: false, orig: cloneShapeGeometry(state.data.layout[hit.index]) };
    }

    onChange({ selection: { kind: hit.kind === 'shape-point' ? 'shape' : hit.kind, index: hit.index } });
    evt.preventDefault();
  }

  function pointerMove(evt) {
    if (!drag) return;
    const state = getState();
    const p = clientToSvgPoint(svg, evt.clientX, evt.clientY);
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (Math.hypot(dx, dy) > CLICK_MOVE_THRESHOLD) drag.moved = true;

    if (drag.kind === 'device') {
      const device = state.data.devices[drag.index];
      device.left = snap(drag.orig.left + dx, state.gridSize);
      device.top = snap(drag.orig.top + dy, state.gridSize);
    } else if (drag.kind === 'shape') {
      translateShape(state.data.layout[drag.index], drag.orig, dx, dy, state.gridSize);
    } else if (drag.kind === 'shape-point') {
      movePoint(state.data.layout[drag.index], drag.point, drag.orig, dx, dy, state.gridSize);
    } else {
      return;
    }
    onChange({ dirty: true });
  }

  function pointerUp() {
    if (drag && !drag.moved && (drag.kind === 'device' || drag.kind === 'shape')) {
      // A plain click on a whole device/shape (not a handle, not a drag):
      // arm click-then-click mode instead of just leaving it selected.
      pending = { kind: drag.kind, index: drag.index };
    }
    drag = null;
  }

  function keydown(evt) {
    if (evt.key === 'Escape') pending = null;
  }

  svg.addEventListener('pointerdown', pointerDown);
  svg.addEventListener('pointermove', pointerMove);
  window.addEventListener('pointerup', pointerUp);
  document.addEventListener('keydown', keydown);

  return {
    destroy() {
      svg.removeEventListener('pointerdown', pointerDown);
      svg.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerUp);
      document.removeEventListener('keydown', keydown);
    },
  };
}
