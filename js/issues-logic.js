/**
 * issues-logic.js — pure aggregation over data that already exists: which
 * devices are currently minor/major (for the global Issues view), and
 * per-building rollups (for the campus view's stats). No new data model —
 * every value here is derived from state.js's inspectionState/condition
 * entries and each room's existing device roster (data/*.json), using the
 * same computeStats room.js's own toolbar already relies on. No DOM —
 * testable directly under Node, same split as room-logic.js/campus-data.js.
 */
import { stateKey } from './state.js';
import { computeStats } from './room-logic.js';

function inspectionFor(state, roomId, device) {
  const entry = state[stateKey(roomId, device.id)];
  return { inspectionState: entry?.inspectionState || 'unchecked', condition: entry?.condition || null };
}

/**
 * One row per device currently minor/major, across every room. `roomDevices`
 * is `{ [roomId]: devices[] }` — the caller fetches each room's roster (the
 * lazy per-room fetch pattern search/export already use); this function only
 * reads what it's given.
 */
export function collectIssues(rooms, roomDevices, state) {
  const issues = [];
  for (const room of rooms) {
    const devices = roomDevices[room.id] || [];
    for (const device of devices) {
      const { inspectionState, condition } = inspectionFor(state, room.id, device);
      if (inspectionState !== 'checked') continue;
      if (condition !== 'minor' && condition !== 'major') continue;
      const entry = state[stateKey(room.id, device.id)];
      issues.push({
        roomId: room.id,
        roomLabel: room.label || room.id,
        campus: room.campus || '',
        deviceId: device.id,
        deviceLabel: device.label || device.id,
        condition,
        notes: entry?.notes || '',
      });
    }
  }
  return issues;
}

const CONDITION_ORDER = { major: 0, minor: 1 };

/** Group-friendly order: building, then room, then worst condition first. */
export function sortIssues(issues) {
  return [...issues].sort((a, b) => {
    if (a.campus !== b.campus) return a.campus.localeCompare(b.campus);
    if (a.roomLabel !== b.roomLabel) return a.roomLabel.localeCompare(b.roomLabel, undefined, { numeric: true });
    const rank = CONDITION_ORDER[a.condition] - CONDITION_ORDER[b.condition];
    if (rank !== 0) return rank;
    return a.deviceId.localeCompare(b.deviceId, undefined, { numeric: true });
  });
}

export function filterIssues(issues, filterKey) {
  if (filterKey === 'major' || filterKey === 'minor') return issues.filter(i => i.condition === filterKey);
  return issues;
}

/** The header summary line's numbers: "N issues across M rooms — X major, Y minor". */
export function summarizeIssues(issues) {
  const rooms = new Set(issues.map(i => i.roomId));
  return {
    total: issues.length,
    rooms: rooms.size,
    major: issues.filter(i => i.condition === 'major').length,
    minor: issues.filter(i => i.condition === 'minor').length,
  };
}

/**
 * A building's rollup: each floor's stats (via room-logic.js's own
 * computeStats — the exact same counts a room's own toolbar shows) summed
 * across every floor in the building.
 */
export function buildingStats(floors, roomDevices, state) {
  const totals = { total: 0, inspected: 0, unchecked: 0, notApplicable: 0, issues: 0 };
  for (const floor of floors) {
    const devices = roomDevices[floor.roomId] || [];
    const stats = computeStats(devices, d => inspectionFor(state, floor.roomId, d));
    totals.total += stats.total;
    totals.inspected += stats.inspected;
    totals.unchecked += stats.unchecked;
    totals.notApplicable += stats.notApplicable;
    totals.issues += stats.issues;
  }
  return totals;
}

/**
 * Overall building state for the static corner marker: has-issues takes
 * priority over the other three regardless of how much is left unchecked.
 */
export function buildingStatusKey(stats) {
  if (stats.issues > 0) return 'has-issues';
  if (stats.total === 0 || stats.unchecked >= stats.total) return 'not-inspected';
  if (stats.unchecked === 0) return 'complete';
  return 'in-progress';
}
