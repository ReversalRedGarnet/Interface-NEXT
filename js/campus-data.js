/**
 * campus-data.js — pure data helpers for the campus/building/floor
 * navigation prototype (data/campus.json). No DOM, so it's testable
 * directly under Node — same split as schema.js vs canvas-renderer.js/
 * tools.js.
 *
 * A "floor" here is just a pointer at one of the app's existing room pages
 * (data/{roomId}.json + rooms/{roomId}.html) — this module and campus.js
 * never read or write room/device data themselves.
 */

export const DEFAULT_CAMPUS_WIDTH = 1000;
export const DEFAULT_CAMPUS_HEIGHT = 460;

function normalizeBuilding(b) {
  const shape = b?.shape || {};
  return {
    id: String(b?.id ?? ''),
    label: b?.label || b?.id || '',
    shape: {
      x: Number(shape.x) || 0,
      y: Number(shape.y) || 0,
      width: Number(shape.width) || 100,
      height: Number(shape.height) || 100,
    },
    floors: Array.isArray(b?.floors)
      ? b.floors.map(f => ({ roomId: String(f?.roomId ?? ''), label: f?.label || f?.roomId || '' }))
      : [],
  };
}

/** Fills in defaults for anything missing/malformed, tolerating a hand-edited file. */
export function normalizeCampusData(data) {
  return {
    canvasWidth: Number(data?.canvasWidth) || DEFAULT_CAMPUS_WIDTH,
    canvasHeight: Number(data?.canvasHeight) || DEFAULT_CAMPUS_HEIGHT,
    buildings: Array.isArray(data?.buildings) ? data.buildings.map(normalizeBuilding) : [],
  };
}

export function findBuilding(data, buildingId) {
  return data.buildings.find(b => b.id === buildingId) || null;
}

/**
 * Where clicking a building should go: straight into its one floor's room
 * page, or a floor picker when it has more than one. `{ kind: 'none' }` for
 * a building with no floors defined yet, so callers never navigate to
 * `undefined`.
 */
export function buildingDestination(building) {
  if (!building || !building.floors.length) return { kind: 'none' };
  if (building.floors.length === 1) return { kind: 'room', roomId: building.floors[0].roomId };
  return { kind: 'floor-picker', floors: building.floors };
}
