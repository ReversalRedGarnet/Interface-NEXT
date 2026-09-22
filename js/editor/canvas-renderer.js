/**
 * canvas-renderer.js — draws the editable SVG floor-plan surface: layout
 * shapes and device boxes as real DOM nodes (not an HTML string, unlike
 * room.js's read-only drawLayout), each tagged with data-kind/data-index so
 * tools.js can hit-test and drag them. Deliberately independent of
 * room.js — the editor never imports it and room.js is never touched.
 *
 * Browser-only (uses the DOM/SVG API directly); not covered by
 * editor.test.mjs for that reason, same as room.js's own rendering isn't
 * unit-tested beyond the DOM state it produces.
 */
import { deviceBoxSize } from './schema.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const GRID_PATTERN_ID = 'editor-grid-pattern';

function el(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function handle(x, y, index, point) {
  return el('circle', {
    cx: x, cy: y, r: 5, class: 'ed-handle',
    'data-kind': 'shape-point', 'data-index': index, 'data-point': point,
  });
}

/** Mirrors room.js's layoutCenter(): used to pick which side an entrance swings into. */
function computeLayoutCenter(layout, w, h) {
  const shapes = layout.filter(o => o.type === 'floor' || o.type === 'room');
  if (shapes.length) {
    let sx = 0, sy = 0;
    shapes.forEach(s => { sx += s.x + s.width / 2; sy += s.y + s.height / 2; });
    return [sx / shapes.length, sy / shapes.length];
  }
  const outline = layout.find(o => o.type === 'outline');
  if (outline) {
    let sx = 0, sy = 0;
    outline.points.forEach(p => { sx += p[0]; sy += p[1]; });
    return [sx / outline.points.length, sy / outline.points.length];
  }
  return [w / 2, h / 2];
}

function renderOutline(shape, index) {
  const g = el('g', { class: 'ed-shape ed-outline', 'data-kind': 'shape', 'data-index': index });
  const d = 'M' + shape.points.map(p => p.join(',')).join(' L') + ' Z';
  g.appendChild(el('path', { d, class: 'ed-rect-body ed-hit-line' }));
  shape.points.forEach((p, k) => g.appendChild(handle(p[0], p[1], index, String(k))));
  return g;
}

function renderWall(shape, index) {
  const g = el('g', { class: 'ed-shape ed-wall', 'data-kind': 'shape', 'data-index': index });
  g.appendChild(el('line', { x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2, class: 'ed-wall-line ed-hit-line' }));
  g.appendChild(handle(shape.x1, shape.y1, index, 'x1y1'));
  g.appendChild(handle(shape.x2, shape.y2, index, 'x2y2'));
  return g;
}

/** Renders the `door`-shaped JSON entry the editor's UI presents as
 *  "entrance" (see schema.js). Whole-shape drag/click-move only — no
 *  per-point handles, since entrances are a fixed standard width with no
 *  per-instance resizing. */
function renderDoor(shape, index, center) {
  const g = el('g', { class: 'ed-shape ed-door', 'data-kind': 'shape', 'data-index': index });

  if (shape.hinge && shape.jamb) {
    const [hx, hy] = shape.hinge;
    const [jx, jy] = shape.jamb;
    const dx = jx - hx, dy = jy - hy;
    const width = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / width, uy = dy / width;
    const p1 = [-uy, ux], p2 = [uy, -ux];
    const [cx, cy] = center;
    const toCenter = [cx - hx, cy - hy];
    const perp = (p1[0] * toCenter[0] + p1[1] * toCenter[1]) >= 0 ? p1 : p2;
    const tipX = hx + perp[0] * width, tipY = hy + perp[1] * width;
    const sweepFlag = (ux * perp[1] - uy * perp[0]) > 0 ? 1 : 0;

    g.appendChild(el('line', { x1: hx, y1: hy, x2: jx, y2: jy, class: 'ed-hit-line' }));
    g.appendChild(el('line', { x1: hx, y1: hy, x2: tipX, y2: tipY, class: 'ed-door-leaf' }));
    g.appendChild(el('path', { d: `M${tipX},${tipY} A${width},${width} 0 0 ${sweepFlag} ${jx},${jy}`, class: 'ed-door-arc' }));
  } else {
    g.appendChild(el('line', { x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2, class: 'ed-door-leaf ed-hit-line' }));
  }
  return g;
}

/** Corner tags are compass points ('nw'/'ne'/'se'/'sw'), consumed by
 *  tools.js's resizeRect() — dragging one only ever changes x/y/width/height,
 *  so the shape can't become a non-rectangular quadrilateral: the schema
 *  itself has no independent corner coordinates to skew. */
function renderRect(shape, index, cls) {
  const g = el('g', { class: `ed-shape ${cls}`, 'data-kind': 'shape', 'data-index': index });
  g.appendChild(el('rect', { x: shape.x, y: shape.y, width: shape.width, height: shape.height, class: 'ed-rect-body' }));
  if (shape.label) {
    const text = el('text', {
      x: shape.x + shape.width / 2, y: shape.y + shape.height / 2,
      class: 'ed-shape-label', 'text-anchor': 'middle', 'dominant-baseline': 'middle',
    });
    text.textContent = shape.label;
    g.appendChild(text);
  }
  g.appendChild(handle(shape.x, shape.y, index, 'nw'));
  g.appendChild(handle(shape.x + shape.width, shape.y, index, 'ne'));
  g.appendChild(handle(shape.x + shape.width, shape.y + shape.height, index, 'se'));
  g.appendChild(handle(shape.x, shape.y + shape.height, index, 'sw'));
  return g;
}

function renderShape(shape, index, center) {
  switch (shape.type) {
    case 'outline':  return renderOutline(shape, index);
    case 'wall':     return renderWall(shape, index);
    case 'door':     return renderDoor(shape, index, center);
    case 'floor':    return renderRect(shape, index, 'ed-floor');
    case 'room':     return renderRect(shape, index, 'ed-room');
    case 'entrance': return renderRect(shape, index, 'ed-entrance');
    case 'counter':  return renderRect(shape, index, 'ed-counter');
    case 'wallrect': return renderRect(shape, index, 'ed-wallrect');
    default:         return null; // unknown type — skip drawing, but it's preserved on save (schema.js passes it through)
  }
}

function renderDevice(device, index) {
  const { width, height } = deviceBoxSize(device);
  const g = el('g', {
    class: `ed-device ed-device-${device.type || 'pc'}`,
    'data-kind': 'device', 'data-index': index,
    transform: `translate(${device.left || 0}, ${device.top || 0})`,
  });
  g.appendChild(el('rect', { width, height, rx: 6, class: 'ed-device-body' }));
  const text = el('text', {
    x: width / 2, y: height / 2, class: 'ed-device-label',
    'text-anchor': 'middle', 'dominant-baseline': 'middle',
  });
  text.textContent = device.type === 'printer' ? '⎙' : (device.label || device.id || '?');
  g.appendChild(text);
  return g;
}

function buildGridBackground(w, h, gridSize) {
  const defs = el('defs');
  const pattern = el('pattern', { id: GRID_PATTERN_ID, width: gridSize, height: gridSize, patternUnits: 'userSpaceOnUse' });
  pattern.appendChild(el('path', { d: `M ${gridSize} 0 L 0 0 0 ${gridSize}`, class: 'ed-grid-line' }));
  defs.appendChild(pattern);
  return [defs, el('rect', { x: 0, y: 0, width: w, height: h, fill: `url(#${GRID_PATTERN_ID})`, class: 'ed-grid-bg' })];
}

/** Rebuilds the whole canvas from scratch. Rooms here are small (a few
 *  dozen devices, a dozen shapes), so a full rebuild per change is simpler
 *  than incremental patching and still cheap. */
export function render(svg, data, opts = {}) {
  const { selection = null, gridSize = 0, showGrid = true } = opts;
  const w = data.canvasWidth, h = data.canvasHeight;

  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  if (showGrid && gridSize > 0) {
    buildGridBackground(w, h, gridSize).forEach(node => svg.appendChild(node));
  } else {
    svg.appendChild(el('rect', { x: 0, y: 0, width: w, height: h, class: 'ed-canvas-bg' }));
  }

  const center = computeLayoutCenter(data.layout, w, h);
  const layoutGroup = el('g', { class: 'ed-layout' });
  data.layout.forEach((shape, i) => {
    const node = renderShape(shape, i, center);
    if (node) layoutGroup.appendChild(node);
  });
  svg.appendChild(layoutGroup);

  const deviceGroup = el('g', { class: 'ed-devices' });
  data.devices.forEach((device, i) => deviceGroup.appendChild(renderDevice(device, i)));
  svg.appendChild(deviceGroup);

  if (selection) {
    const target = svg.querySelector(`[data-kind="${selection.kind}"][data-index="${selection.index}"]`);
    if (target) target.classList.add('ed-selected');
  }
}

/** Reads which element (if any) a pointer event landed on. */
export function hitTest(evt) {
  const target = evt.target.closest?.('[data-kind]');
  if (!target) return null;
  return {
    kind: target.dataset.kind,
    index: Number(target.dataset.index),
    point: target.dataset.point,
  };
}

/** Client (screen) coordinates → the SVG's own user-space coordinates,
 *  independent of however CSS is currently scaling the element. */
export function clientToSvgPoint(svg, clientX, clientY) {
  if (typeof svg.createSVGPoint === 'function' && typeof svg.getScreenCTM === 'function') {
    const ctm = svg.getScreenCTM();
    if (ctm) {
      const pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      const transformed = pt.matrixTransform(ctm.inverse());
      return { x: transformed.x, y: transformed.y };
    }
  }
  // Fallback for engines without SVG geometry support.
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox && svg.viewBox.baseVal;
  const w = vb && vb.width ? vb.width : (rect.width || 1);
  const h = vb && vb.height ? vb.height : (rect.height || 1);
  return {
    x: ((clientX - rect.left) / (rect.width || 1)) * w,
    y: ((clientY - rect.top) / (rect.height || 1)) * h,
  };
}
