/**
 * main.js — entry point.
 *   • On index.html   → window.ROOM_META is undefined → initMenuPage() +
 *                        initCampusPage() (the birds-eye nav prototype)
 *   • On a room page  → window.ROOM_META is set        → fetch its data
 *                        file (+ the project-wide assets.json lookup,
 *                        tolerant of it being missing) and
 *                        initRoomPage(fullConfig)
 *   • On issues.html  → window.ISSUES_PAGE is set       → initIssuesPage()
 */
import { initMenuPage } from './menu.js';
import { initRoomPage } from './room.js';
import { initCampusPage } from './campus.js';
import { initIssuesPage } from './issues.js';

/** Never rejects — a missing/unreadable assets.json degrades to "no asset
 *  info available" rather than blocking the room page from loading. */
function fetchAssets(url) {
  return fetch(url).then(res => (res.ok ? res.json() : {})).catch(() => ({}));
}

if (window.ROOM_META) {
  const { dataUrl, ...meta } = window.ROOM_META;
  const assetsUrl = dataUrl.slice(0, dataUrl.lastIndexOf('/') + 1) + 'assets.json';
  Promise.all([
    fetch(dataUrl).then(res => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json();
    }),
    fetchAssets(assetsUrl),
  ])
    .then(([data, assets]) => initRoomPage({ ...meta, ...data, assets }))
    .catch(err => {
      document.getElementById('room-root').innerHTML =
        `<p style="padding:24px;font-family:sans-serif;color:#b91c1c">
           Couldn't load room data (${dataUrl}): ${err.message}<br>
           Note: this page must be served over http(s) — opening the .html
           file directly (file://) will block the data fetch.
         </p>`;
    });
} else if (window.ISSUES_PAGE) {
  initIssuesPage();
} else {
  initMenuPage();
  initCampusPage();
}
