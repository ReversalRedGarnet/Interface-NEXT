/**
 * photo-trace.js — the reusable core of "click points onto a loaded photo,
 * never persisting the photo itself": pixel-coordinate conversion, the
 * photo-decode step, polygon rendering, and a bounding-box helper.
 *
 * Extracted out of admin/trace.js (the internal campus-building tracer) so
 * the editor's own "Trace from Photo" New Room option can reuse the exact
 * same click-trace mechanic for a room's `outline` layout shape, without
 * admin/trace.js's own building-name/floor-count/campus.json-shaped export
 * steps — those stay exactly where they are, untouched, in admin/trace.js.
 * This module has no opinion about what the traced points are FOR (a
 * campus building's bounding box, or a room's full outline polygon) —
 * that's entirely up to whichever "finish" step a caller builds on top.
 *
 * The photo itself is never uploaded or stored: `loadPhotoFile` decodes it
 * into an <img> via a short-lived `URL.createObjectURL`/`revokeObjectURL`
 * pair and nothing else ever touches the file after that.
 */

/** Canvas click clientX/clientY → native photo-pixel coordinates, correcting
 *  for the canvas's CSS-scaled *display* size vs its internal resolution
 *  (the canvas's width/height attributes are set to the photo's natural
 *  size — see loadPhotoFile — so this is the photo's own pixel space). */
export function toImageCoords(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return [
    Math.round((clientX - rect.left) * scaleX),
    Math.round((clientY - rect.top) * scaleY),
  ];
}

/** Decodes `file` into a ready-to-draw <img>, revoking the blob URL the
 *  moment decoding finishes (success or failure) either way — the file is
 *  never read again after this resolves, and nothing derived from it is
 *  ever written anywhere. */
export function loadPhotoFile(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(objectUrl); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Could not load that file as an image.')); };
    img.src = objectUrl;
  });
}

/** Draws an in-progress or finished point list onto `ctx`. `canvasWidth` is
 *  only used to scale stroke width/point radius sensibly across different
 *  photo resolutions (matching admin/trace.js's original sizing exactly). */
export function drawPolygon(ctx, canvasWidth, points, { stroke, fill, closed }) {
  if (points.length < 2 && !fill) {
    // still draw the single point as a dot below
  } else {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    if (closed) ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(2, canvasWidth / 400);
    ctx.stroke();
  }
  ctx.fillStyle = stroke;
  const r = Math.max(3, canvasWidth / 250);
  points.forEach(([x, y]) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  });
}

/** Axis-aligned bounding box of a point list — admin/trace.js's own export
 *  still reduces a traced shape to this (campus.json buildings have no
 *  polygon shape); the room-outline tracer doesn't use this at all (a
 *  room's `outline` keeps the full point list), but it stays here so both
 *  callers can share one implementation instead of two. */
export function boundingBox(points) {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y) };
}
