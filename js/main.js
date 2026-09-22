/**
 * main.js — entry point.
 *   • On index.html   → window.ROOM_META is undefined → initMenuPage()
 *   • On a room page  → window.ROOM_META is set        → fetch its data
 *                        file and initRoomPage(fullConfig)
 */
import { initMenuPage } from './menu.js';
import { initRoomPage } from './room.js';

if (window.ROOM_META) {
  const { dataUrl, ...meta } = window.ROOM_META;
  fetch(dataUrl)
    .then(res => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json();
    })
    .then(data => initRoomPage({ ...meta, ...data }))
    .catch(err => {
      document.getElementById('room-root').innerHTML =
        `<p style="padding:24px;font-family:sans-serif;color:#b91c1c">
           Couldn't load room data (${dataUrl}): ${err.message}<br>
           Note: this page must be served over http(s) — opening the .html
           file directly (file://) will block the data fetch.
         </p>`;
    });
} else {
  initMenuPage();
}
