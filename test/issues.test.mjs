/**
 * issues.test.mjs — drives the real js/issues.js inside jsdom: the global
 * Issues view built over every room's real device roster + stored
 * inspection state, same mounting approach as room.test.mjs/campus.test.mjs.
 * Run: node test/issues.test.mjs
 */
import { JSDOM, VirtualConsole } from 'jsdom';

const results = [];
let bust = 0;

async function test(name, fn) {
  try { await fn(); results.push(['PASS', name, '']); }
  catch (err) { results.push(['FAIL', name, err.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

// Real navigation (window.location.href = ...) isn't implemented in jsdom —
// selecting an issue deliberately triggers it (same as room.js's own
// cross-room search result does), so a virtual console swallows just that
// expected "Not implemented" noise, same approach campus.test.mjs uses.
const silentConsole = new VirtualConsole();
silentConsole.on('jsdomError', () => {});

const ISSUES_BODY = `
  <p class="subtitle" id="issues-summary">Loading…</p>
  <div class="toolbar-row" id="issues-filter-row">
    <button type="button" class="filter-btn" data-filter="all" aria-pressed="true">All</button>
    <button type="button" class="filter-btn" data-filter="major" aria-pressed="false">Major</button>
    <button type="button" class="filter-btn" data-filter="minor" aria-pressed="false">Minor</button>
  </div>
  <div id="issues-root"></div>
`;

/** `roomDevices` is `{ [stem]: devices[] }` (lowercase file stems, as fetched
 *  from data/{stem}.json); `stateEntries` uses the real, uppercase ROOM_META
 *  ids ALL_ROOMS/state.js actually key on (e.g. "COMMONS_PC1"). `statusByStem`
 *  (optional) is `{ [stem]: 'draft' | 'final' }` — any stem in `roomDevices`
 *  not listed here defaults to 'final', so every existing call site (written
 *  before draft/final existed) keeps behaving exactly as it did. */
async function mountIssues(roomDevices = {}, stateEntries = {}, statusByStem = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${ISSUES_BODY}</body></html>`, {
    url: 'http://localhost/issues.html', virtualConsole: silentConsole,
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  if (Object.keys(stateEntries).length) {
    global.localStorage.setItem('it-room-monitor-v1', JSON.stringify(stateEntries));
  }
  global.fetch = async url => {
    const m = /data\/([a-z0-9-]+)\.json$/.exec(String(url));
    if (m && Object.prototype.hasOwnProperty.call(roomDevices, m[1])) {
      return { ok: true, json: async () => ({ devices: roomDevices[m[1]], status: statusByStem[m[1]] || 'final' }) };
    }
    return { ok: false, status: 404, statusText: 'Not Found' };
  };

  const { initIssuesPage } = await import(`../js/issues.js?b=${bust++}`);
  await initIssuesPage();
  return { dom, doc: dom.window.document };
}

function click(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
}

await test('with nothing minor/major anywhere, the page shows the empty state, not blank whitespace', async () => {
  const { doc } = await mountIssues({ commons: [{ id: 'PC1' }] }, {
    'COMMONS_PC1': { inspectionState: 'checked', condition: 'working', notes: '', updatedAt: null },
  });
  assertEqual(doc.getElementById('issues-summary').textContent, 'No issues.', 'expected the empty-state summary line');
  assert(/no issues/i.test(doc.getElementById('issues-root').textContent), 'expected an explicit "No issues" message, not blank whitespace');
});

await test('a minor/major device anywhere shows up, grouped under its campus and room, with its note', async () => {
  const { doc } = await mountIssues({
    commons: [{ id: 'PC1' }],
    annex: [{ id: 'PRINTER1' }],
  }, {
    'COMMONS_PC1': { inspectionState: 'checked', condition: 'major', notes: '', updatedAt: null },
    'ANNEX_PRINTER1': { inspectionState: 'checked', condition: 'minor', notes: 'toner low', updatedAt: null },
  });
  const root = doc.getElementById('issues-root');
  assert(root.textContent.includes('PC1'), 'expected PC1 in the issues list');
  assert(root.textContent.includes('PRINTER1'), 'expected PRINTER1 in the issues list');
  assert(root.textContent.includes('toner low'), 'expected the note to be shown for the entry that has one');
  assertEqual(doc.getElementById('issues-summary').textContent, '2 issues across 2 rooms — 1 major, 1 minor', 'unexpected summary line');
});

await test('working, unchecked, and not-applicable devices never appear in the issues list', async () => {
  const { doc } = await mountIssues({ commons: [{ id: 'PC1' }, { id: 'PC2' }, { id: 'PC3' }] }, {
    'COMMONS_PC1': { inspectionState: 'checked', condition: 'working', notes: '', updatedAt: null },
    'COMMONS_PC2': { inspectionState: 'not-applicable', condition: null, notes: '', updatedAt: null },
    // PC3 has no entry at all — untouched/unchecked.
  });
  assertEqual(doc.getElementById('issues-summary').textContent, 'No issues.', 'none of working/not-applicable/unchecked should count as an issue');
});

await test('the Major/Minor filter buttons narrow the list; All restores it', async () => {
  const { doc } = await mountIssues({ commons: [{ id: 'PC1' }, { id: 'PC2' }] }, {
    'COMMONS_PC1': { inspectionState: 'checked', condition: 'major', notes: '', updatedAt: null },
    'COMMONS_PC2': { inspectionState: 'checked', condition: 'minor', notes: '', updatedAt: null },
  });
  const root = doc.getElementById('issues-root');
  const majorBtn = doc.querySelector('.filter-btn[data-filter="major"]');
  const minorBtn = doc.querySelector('.filter-btn[data-filter="minor"]');
  const allBtn = doc.querySelector('.filter-btn[data-filter="all"]');

  click(majorBtn);
  assert(root.textContent.includes('PC1') && !root.textContent.includes('PC2'), 'Major filter should show only PC1');
  assertEqual(majorBtn.getAttribute('aria-pressed'), 'true', 'Major button should read pressed once selected');
  assertEqual(allBtn.getAttribute('aria-pressed'), 'false', 'All button should no longer read pressed');

  click(minorBtn);
  assert(!root.textContent.includes('PC1') && root.textContent.includes('PC2'), 'Minor filter should show only PC2');

  click(allBtn);
  assert(root.textContent.includes('PC1') && root.textContent.includes('PC2'), 'All should restore both entries');
});

await test('the summary line always reflects the TOTAL count, even while a filter narrows the visible list', async () => {
  const { doc } = await mountIssues({ commons: [{ id: 'PC1' }, { id: 'PC2' }] }, {
    'COMMONS_PC1': { inspectionState: 'checked', condition: 'major', notes: '', updatedAt: null },
    'COMMONS_PC2': { inspectionState: 'checked', condition: 'minor', notes: '', updatedAt: null },
  });
  click(doc.querySelector('.filter-btn[data-filter="major"]'));
  assertEqual(doc.getElementById('issues-summary').textContent, '2 issues across 1 room — 1 major, 1 minor', 'summary should still count both, not just the filtered-in one');
});

await test('each issue entry carries exactly the room stem + device id its click handler navigates with — the same ?focus= deep link cross-room search already uses', async () => {
  // jsdom can't observe a real `window.location.href = …` navigation (the
  // assignment is a non-configurable, non-writable own property — there's
  // no way to spy on it), so this checks the two ingredients the click
  // handler builds that URL from, rather than the navigation itself; the
  // handler's one-line `rooms/${stem}.html?focus=${id}` construction is
  // exercised directly, byte-for-byte, in js/issues.js.
  const { doc } = await mountIssues({ 'b2-210': [{ id: 'PC7' }] }, {
    'B2-210_PC7': { inspectionState: 'checked', condition: 'major', notes: '', updatedAt: null },
  });
  const item = doc.querySelector('.issue-item');
  assert(item, 'expected an issue entry to click');
  assertEqual(item.dataset.roomStem, 'b2-210', 'expected the real room file stem on the entry');
  assertEqual(item.dataset.deviceId, 'PC7', 'expected the device id on the entry');
});

await test('a draft (not-yet-finalized) room never contributes issues, even with real major/minor devices', async () => {
  const { doc } = await mountIssues({
    commons: [{ id: 'PC1' }],
    annex: [{ id: 'PC2' }],
  }, {
    'COMMONS_PC1': { inspectionState: 'checked', condition: 'major', notes: '', updatedAt: null },
    'ANNEX_PC2': { inspectionState: 'checked', condition: 'minor', notes: '', updatedAt: null },
  }, { annex: 'draft' });

  const root = doc.getElementById('issues-root');
  assert(root.textContent.includes('PC1'), 'the final room\'s issue should still appear');
  assert(!root.textContent.includes('PC2'), 'the draft room\'s issue should never appear');
  assertEqual(doc.getElementById('issues-summary').textContent, '1 issue across 1 room — 1 major, 0 minor', 'summary should only count the final room');
});

await test('a room whose data file fails to fetch degrades to contributing no issues, rather than throwing', async () => {
  const { doc } = await mountIssues({}, {
    'COMMONS_PC1': { inspectionState: 'checked', condition: 'major', notes: '', updatedAt: null },
  });
  assertEqual(doc.getElementById('issues-summary').textContent, 'No issues.', 'a device outside any successfully-fetched roster should not surface as an issue');
});

/* ── Report ────────────────────────────────────────────────────────── */

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
