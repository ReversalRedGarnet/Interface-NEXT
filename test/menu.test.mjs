/**
 * menu.test.mjs — feedback loop for menu.js's hideNonFinalRoomLinks(): the
 * one piece of index.html's static "Browse all rooms" fallback list that
 * needs a runtime check, since the editor patches a room-link into that
 * list at creation time regardless of draft/final status (see js/menu.js's
 * own header comment and js/editor/room-scaffold.js's patchIndexHtml).
 * Run: node test/menu.test.mjs
 */
import { JSDOM } from 'jsdom';

const results = [];

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

const { hideNonFinalRoomLinks } = await import('../js/menu.js');

const FIXTURE = `
  <div class="room-list" id="rooms-northgate">
    <a class="room-link" href="rooms/commons.html">Commons</a>
    <a class="room-link" href="rooms/b2-210.html">B2-210</a>
  </div>
  <div class="room-list" id="rooms-riverside">
    <a class="room-link" href="rooms/annex.html">Annex Lab</a>
  </div>
`;

function mountDoc(html = FIXTURE) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'http://localhost/index.html' });
  return dom.window.document;
}

/** `statusByStem` is `{ [stem]: 'draft' | 'final' | undefined }` — a stem
 *  not listed at all simulates a failed/404 fetch (fail-safe → excluded). */
function fetchFor(statusByStem) {
  return async url => {
    const m = /data\/([a-z0-9-]+)\.json$/.exec(String(url));
    const stem = m?.[1];
    if (!stem || !Object.prototype.hasOwnProperty.call(statusByStem, stem)) {
      return { ok: false, status: 404, statusText: 'Not Found' };
    }
    return { ok: true, json: async () => ({ status: statusByStem[stem] }) };
  };
}

await test('a final room\'s link stays; a draft room\'s link is removed', async () => {
  const doc = mountDoc();
  global.fetch = fetchFor({ commons: 'final', 'b2-210': 'draft', annex: 'final' });
  await hideNonFinalRoomLinks(doc, stem => `data/${stem}.json`);

  assert(doc.querySelector('a[href="rooms/commons.html"]'), 'a final room\'s link should stay');
  assert(!doc.querySelector('a[href="rooms/b2-210.html"]'), 'a draft room\'s link should be removed');
  assert(doc.querySelector('a[href="rooms/annex.html"]'), 'a final room in a different site list should stay');
});

await test('a room whose data file fails to fetch is removed (fail safe, not fail open)', async () => {
  const doc = mountDoc('<div class="room-list"><a class="room-link" href="rooms/unreadable.html">Unreadable</a></div>');
  global.fetch = fetchFor({}); // nothing listed → every fetch 404s
  await hideNonFinalRoomLinks(doc, stem => `data/${stem}.json`);
  assert(!doc.querySelector('a[href="rooms/unreadable.html"]'), 'a room whose status can\'t be confirmed should be hidden, not shown by default');
});

await test('a missing/unrecognized status value is treated as draft, same as normalizeRoomStatus\'s default', async () => {
  const doc = mountDoc('<div class="room-list"><a class="room-link" href="rooms/weird.html">Weird</a></div>');
  global.fetch = fetchFor({ weird: 'Final' }); // wrong case — not the literal string "final"
  await hideNonFinalRoomLinks(doc, stem => `data/${stem}.json`);
  assert(!doc.querySelector('a[href="rooms/weird.html"]'), 'a non-"final" status string should still hide the room');
});

await test('a room-list left with no rooms after filtering shows a short note instead of just being empty', async () => {
  const doc = mountDoc('<div class="room-list" id="only-drafts"><a class="room-link" href="rooms/draft1.html">Draft 1</a></div>');
  global.fetch = fetchFor({ draft1: 'draft' });
  await hideNonFinalRoomLinks(doc, stem => `data/${stem}.json`);
  const list = doc.getElementById('only-drafts');
  assert(list.children.length === 1 && list.querySelector('.room-list-empty'), 'expected exactly the empty-state note left in the list');
  assert(/no finalized rooms/i.test(list.textContent), 'expected a clear "no finalized rooms yet" message');
});

await test('a genuinely empty .room-list elsewhere on the page (e.g. campus.js\'s own floor-picker list, before any building is clicked) never gets the empty-state note — only lists that actually held a candidate link do', async () => {
  const doc = mountDoc(`
    ${FIXTURE}
    <div class="room-list" id="floor-picker-list"></div>
  `);
  global.fetch = fetchFor({ commons: 'final', 'b2-210': 'final', annex: 'final' });
  await hideNonFinalRoomLinks(doc, stem => `data/${stem}.json`);
  const pickerList = doc.getElementById('floor-picker-list');
  assertEqual(pickerList.children.length, 0, 'an unrelated empty .room-list (campus.js\'s floor-picker, not yet opened) should be left completely untouched');
});

await test('a room-list that still has a final room left does not get an empty-state note', async () => {
  const doc = mountDoc();
  global.fetch = fetchFor({ commons: 'final', 'b2-210': 'draft', annex: 'final' });
  await hideNonFinalRoomLinks(doc, stem => `data/${stem}.json`);
  assert(!doc.getElementById('rooms-northgate').querySelector('.room-list-empty'), 'a list that still has a real room should not show the empty-state note');
});

/* ── Report ────────────────────────────────────────────────────── */

const failed = results.filter(r => r[0] === 'FAIL');
for (const [status, name, msg] of results) {
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}${msg ? `\n        → ${msg}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
