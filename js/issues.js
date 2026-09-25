/**
 * issues.js — wiring for issues.html: a read-only, roster-complete rollup
 * of every device currently minor/major, across every room. Built entirely
 * on the existing inspectionState/condition data (state.js) and each room's
 * existing device roster (data/*.json) — no new Issue-object model, no
 * lifecycle, no history. Selecting an entry reuses the exact same
 * cross-room navigation search results already use (`?focus=` deep link
 * into the room page, which room.js's own init already honors via its
 * shared focusDevice()) rather than reimplementing focus/pan/zoom here.
 */
import { ALL_ROOMS, fetchRoomDevices } from './export.js';
import { loadState } from './state.js';
import { roomFileStem } from './editor/room-scaffold.js';
import { collectIssues, sortIssues, filterIssues, summarizeIssues } from './issues-logic.js';

const CONDITION_LABELS = { major: 'Major', minor: 'Minor' };

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Groups already-sorted issues into building → room → issues[], preserving order. */
function groupIssues(issues) {
  const buildings = [];
  let building = null, room = null;
  for (const issue of issues) {
    if (!building || building.campus !== issue.campus) {
      building = { campus: issue.campus, rooms: [] };
      buildings.push(building);
      room = null;
    }
    if (!room || room.roomId !== issue.roomId) {
      room = { roomId: issue.roomId, roomLabel: issue.roomLabel, issues: [] };
      building.rooms.push(room);
    }
    room.issues.push(issue);
  }
  return buildings;
}

function renderIssueItem(issue) {
  const stem = roomFileStem(issue.roomId);
  return `
    <button type="button" class="search-result issue-item" data-room-stem="${escapeHTML(stem)}" data-device-id="${escapeHTML(issue.deviceId)}">
      <span class="issue-item-main">
        <span class="status-dot ${issue.condition}" aria-hidden="true"></span>
        ${escapeHTML(issue.deviceLabel)}
      </span>
      <span class="search-result-room">${CONDITION_LABELS[issue.condition]}</span>
      ${issue.notes ? `<span class="issue-item-note">${escapeHTML(issue.notes)}</span>` : ''}
    </button>`;
}

function renderGroups(buildings) {
  return buildings.map(b => `
    <section class="issues-group">
      <h2>${escapeHTML(b.campus || 'Other')}</h2>
      ${b.rooms.map(r => `
        <div class="issues-room-group">
          <h3>${escapeHTML(r.roomLabel)}</h3>
          <div class="issues-list">
            ${r.issues.map(renderIssueItem).join('')}
          </div>
        </div>`).join('')}
    </section>`).join('');
}

export async function initIssuesPage() {
  const root = document.getElementById('issues-root');
  const summaryEl = document.getElementById('issues-summary');
  const filterRow = document.getElementById('issues-filter-row');
  if (!root) return;

  root.innerHTML = '<p class="search-hint">Loading issues…</p>';

  const roomDevices = {};
  await Promise.all(ALL_ROOMS.map(async room => {
    roomDevices[room.id] = await fetchRoomDevices(room);
  }));

  const state = loadState();
  const allIssues = sortIssues(collectIssues(ALL_ROOMS, roomDevices, state));
  let filter = 'all';

  function render() {
    const summary = summarizeIssues(allIssues);
    summaryEl.textContent = summary.total
      ? `${summary.total} issue${summary.total === 1 ? '' : 's'} across ${summary.rooms} room${summary.rooms === 1 ? '' : 's'} — ${summary.major} major, ${summary.minor} minor`
      : 'No issues.';

    const issues = filterIssues(allIssues, filter);
    if (!issues.length) {
      root.innerHTML = `<p class="search-hint">${allIssues.length ? 'No issues match this filter.' : 'No issues.'}</p>`;
      return;
    }
    root.innerHTML = renderGroups(groupIssues(issues));
  }

  filterRow.addEventListener('click', e => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    filter = btn.dataset.filter;
    filterRow.querySelectorAll('.filter-btn').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    render();
  });

  root.addEventListener('click', e => {
    const item = e.target.closest('[data-room-stem]');
    if (!item) return;
    window.location.href = `rooms/${item.dataset.roomStem}.html?focus=${encodeURIComponent(item.dataset.deviceId)}`;
  });

  render();
}
