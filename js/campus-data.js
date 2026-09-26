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

/**
 * Removes every floor referencing `roomId` (matched case-insensitively,
 * same convention canonicalRoomId in campus.js already uses — floor.roomId
 * is a lowercase file stem) from every building. A building left with no
 * floors afterward is dropped entirely, rather than kept around empty.
 * Operates on the raw/un-normalized data (not normalizeCampusData's output)
 * and only ever touches `buildings`/`floors`, so any other field a
 * hand-edited file carries is preserved untouched.
 *
 * Returns `{ data, removed }` — `removed` is `[{ buildingId, buildingLabel,
 * floorLabel }, …]` for every floor actually unlinked, so a caller (the
 * editor's Delete Room flow) can tell the person exactly what changed in
 * campus.json, a real change to campus structure they should know about —
 * not just silent bookkeeping. Empty `removed` means `roomId` wasn't
 * referenced anywhere, and `data` is returned unchanged in that case.
 */
export function removeRoomFromCampusData(data, roomId) {
  const target = String(roomId).toLowerCase();
  const removed = [];

  const buildings = (Array.isArray(data?.buildings) ? data.buildings : [])
    .map(b => {
      const floors = (Array.isArray(b?.floors) ? b.floors : []).filter(f => {
        if (String(f?.roomId ?? '').toLowerCase() !== target) return true;
        removed.push({ buildingId: b?.id, buildingLabel: b?.label || b?.id, floorLabel: f?.label || f?.roomId });
        return false;
      });
      return { ...b, floors };
    })
    .filter(b => b.floors.length > 0);

  if (!removed.length) return { data, removed };
  return { data: { ...data, buildings }, removed };
}

/**
 * Serializes back to data/campus.json's exact hand-authored style: 2-space
 * indent throughout, but each building's `shape` and each individual
 * `floors[]` entry collapsed onto one line rather than JSON.stringify's
 * default one-key-per-line expansion. Without this, the editor's Delete
 * Room flow (the only code that writes this file today) would reformat
 * every untouched building/floor the moment it touched the file at all —
 * same "diffs cleanly, doesn't silently reshuffle formatting" goal
 * schema.js's serializeRoomData already keeps for data/*.json.
 */
export function serializeCampusData(data) {
  const shapeLine = s => `{ "x": ${Number(s?.x) || 0}, "y": ${Number(s?.y) || 0}, "width": ${Number(s?.width) || 0}, "height": ${Number(s?.height) || 0} }`;
  const floorLine = f => `{ "roomId": ${JSON.stringify(String(f?.roomId ?? ''))}, "label": ${JSON.stringify(String(f?.label ?? ''))} }`;

  const buildings = (Array.isArray(data?.buildings) ? data.buildings : []).map(b => {
    const floors = Array.isArray(b?.floors) ? b.floors : [];
    const floorsBlock = floors.length
      ? `[\n${floors.map(f => `        ${floorLine(f)}`).join(',\n')}\n      ]`
      : '[]';
    return [
      '    {',
      `      "id": ${JSON.stringify(String(b?.id ?? ''))},`,
      `      "label": ${JSON.stringify(String(b?.label ?? ''))},`,
      `      "shape": ${shapeLine(b?.shape)},`,
      `      "floors": ${floorsBlock}`,
      '    }',
    ].join('\n');
  }).join(',\n');

  return `{\n  "canvasWidth": ${Number(data?.canvasWidth) || DEFAULT_CAMPUS_WIDTH},\n  "canvasHeight": ${Number(data?.canvasHeight) || DEFAULT_CAMPUS_HEIGHT},\n  "buildings": [\n${buildings}\n  ]\n}\n`;
}
