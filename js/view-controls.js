/**
 * view-controls.js — the zoom/pan/fit chrome shared by room.js and the
 * editor: wires the View section's five buttons, Ctrl/Cmd+wheel zoom, and
 * click-drag panning to the pure fit-math in room-logic.js
 * (computeContentBounds/computeFitScale/computeFitPan). Previously each page
 * carried its own byte-for-byte copy of this wiring; this module is that one
 * copy, parameterized by what differs between the two callers:
 *
 *  - room.js transforms a fixed-size `#room` against a `contentBounds`
 *    computed once at load; the editor transforms `#canvas-frame` against
 *    bounds it recomputes on every fit, since the room DATA changes as it's
 *    edited. Both are supplied as `getCanvasSize`/`getContentBounds`
 *    callbacks rather than read directly, so this module never needs to know
 *    which case it's in.
 *  - room.js has no "current tool" concept, so any pointerdown off a device
 *    chip may start a pan; the editor only pans in its Select tool, and
 *    excludes shapes/devices instead of just devices. `shouldPan(e)` default
 *    matches room.js's own original check; the editor overrides it.
 *  - the editor's canvas is meaningless before a room is loaded (`state.data`
 *    is null) — `isReady()` (default: always true, matching room.js, which
 *    is only ever initialized once its data exists) gates every operation
 *    that would otherwise read canvas size/content bounds too early.
 */
import { computeFitScale as fitScaleFor, computeFitPan as fitPanFor, zoomModifierLabel } from './room-logic.js';

const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
const PAN_DRAG_THRESHOLD = 3;
/** Small, consistent breathing room around a fit — not large empty padding.
 *  Screen-space px, mirrors --space-4 (16px). */
const FIT_MARGIN = 16;

export function createViewController({
  viewport,
  frame,
  getCanvasSize,
  getContentBounds,
  isReady = () => true,
  shouldPan = e => !e.target.closest?.('[data-id]'),
  buttons = {},
  hintEl,
}) {
  let view = { scale: 1, x: 0, y: 0 };
  /** True whenever `view` still reflects the last computed fit — set on
   *  every fitToScreen() call, cleared the moment the user deliberately
   *  changes scale (the zoom buttons, Ctrl/Cmd+wheel, or Actual Size).
   *  Pan-only actions (drag, the resize handler's own re-clamp) never touch
   *  it. This is what lets a live window resize re-fit automatically right
   *  up until the user has manually zoomed away from fit — after that,
   *  resizing only re-clamps pan at their chosen scale instead of silently
   *  overriding it (see handleResize below). */
  let fitIsCurrent = true;

  function clampScale(s) { return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)); }

  function computeFitScale() {
    const { w, h } = getCanvasSize();
    const vw = viewport.clientWidth || w, vh = viewport.clientHeight || h;
    return fitScaleFor(getContentBounds(), vw, vh, FIT_MARGIN);
  }

  function clampPanAxis(pos, scaledSize, viewSize) {
    if (scaledSize <= viewSize) return 0;
    return Math.min(0, Math.max(viewSize - scaledSize, pos));
  }

  function clampPan(x, y, scale) {
    const { w, h } = getCanvasSize();
    const vw = viewport.clientWidth || w, vh = viewport.clientHeight || h;
    return {
      x: clampPanAxis(x, w * scale, vw),
      y: clampPanAxis(y, h * scale, vh),
    };
  }

  function applyView() {
    frame.style.transformOrigin = 'top left';
    frame.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  }

  function setView(scale, x, y) {
    if (scale !== view.scale) fitIsCurrent = false;
    view.scale = clampScale(scale);
    const clamped = clampPan(x, y, view.scale);
    view.x = clamped.x;
    view.y = clamped.y;
    applyView();
  }

  function zoomAt(viewportX, viewportY, newScale) {
    newScale = clampScale(newScale);
    const roomX = (viewportX - view.x) / view.scale;
    const roomY = (viewportY - view.y) / view.scale;
    setView(newScale, viewportX - roomX * newScale, viewportY - roomY * newScale);
  }

  function zoomByFactor(factor) {
    if (!isReady()) return;
    const { w, h } = getCanvasSize();
    const vw = viewport.clientWidth || w, vh = viewport.clientHeight || h;
    zoomAt(vw / 2, vh / 2, view.scale * factor);
  }

  /**
   * True maximum contain-fit: centers the content's actual bounding box (not
   * its raw (0,0) canvas origin) in the viewport at the largest scale that
   * fits. Deliberately bypasses setView()/clampPan() — that clamp is
   * calibrated to the full nominal canvas size for ordinary interactive
   * pan/zoom, and would fight a deliberately off-(0,0) centered pan for
   * content that doesn't start at the canvas origin.
   */
  function fitToScreen() {
    if (!isReady()) return;
    const { w, h } = getCanvasSize();
    const vw = viewport.clientWidth || w, vh = viewport.clientHeight || h;
    const scale = clampScale(computeFitScale());
    const { x, y } = fitPanFor(getContentBounds(), vw, vh, scale);
    view.scale = scale;
    view.x = x;
    view.y = y;
    applyView();
    fitIsCurrent = true;
  }

  function actualSize() {
    if (!isReady()) return;
    setView(1, 0, 0);
  }

  /** For a freshly loaded/created room: fits immediately, then re-fits one
   *  frame later once real layout has definitely settled — the synchronous
   *  fit above can run before the browser has laid out DOM just injected,
   *  when clientWidth/Height may still read 0 (silently treated as "no
   *  room, use scale 1" instead of a true fit). */
  function resetView() {
    fitToScreen();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fitToScreen());
  }

  /** Re-fits on any viewport size change — window resize, or (via the
   *  ResizeObserver below) a layout change that isn't a window resize at
   *  all, like a split-screen/multi-window drag — but only while the view
   *  still reflects the last fit. Once the user has manually zoomed away
   *  from fit, resizing instead re-clamps pan at their chosen scale so a
   *  deliberate zoom survives a resize rather than getting silently
   *  overridden back to fit. */
  function handleResize() {
    if (!isReady()) return;
    if (fitIsCurrent) fitToScreen();
    else setView(view.scale, view.x, view.y);
  }

  buttons.zoomOut?.addEventListener('click', () => zoomByFactor(0.8));
  buttons.zoomIn?.addEventListener('click', () => zoomByFactor(1.25));
  buttons.zoomFit?.addEventListener('click', fitToScreen);
  buttons.zoom100?.addEventListener('click', actualSize);
  buttons.zoomFullscreen?.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else viewport.requestFullscreen?.();
  });

  if (hintEl) hintEl.textContent = `${zoomModifierLabel()}+scroll to zoom`;

  // Plain wheel scroll behaves like normal page scroll (the event is left
  // alone) — zoom only kicks in with Ctrl/Cmd held, matching the browser's
  // own "zoom the page" gesture so it never hijacks an ordinary scroll.
  viewport.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!isReady()) return;
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, view.scale * factor);
  }, { passive: false });

  let panDrag = null;
  viewport.addEventListener('pointerdown', e => {
    if (!isReady()) return;
    if (!shouldPan(e)) return;
    if (e.button !== undefined && e.button !== 0) return;
    panDrag = { startX: e.clientX, startY: e.clientY, origX: view.x, origY: view.y, moved: false };
  });
  window.addEventListener('pointermove', e => {
    if (!panDrag) return;
    const dx = e.clientX - panDrag.startX, dy = e.clientY - panDrag.startY;
    if (Math.hypot(dx, dy) > PAN_DRAG_THRESHOLD) panDrag.moved = true;
    if (!panDrag.moved) return;
    setView(view.scale, panDrag.origX + dx, panDrag.origY + dy);
  });
  window.addEventListener('pointerup', () => { panDrag = null; });

  window.addEventListener('resize', handleResize);
  if (typeof ResizeObserver === 'function') new ResizeObserver(handleResize).observe(viewport);

  return {
    zoomByFactor,
    fitToScreen,
    actualSize,
    setView,
    resetView,
    computeFitScale,
    get scale() { return view.scale; },
  };
}
