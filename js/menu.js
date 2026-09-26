/** menu.js — wiring for index.html: site toggles, export-all, backup/restore,
 *  and hiding not-yet-finalized rooms from the static "Browse all rooms"
 *  fallback list (the birds-eye campus view handles this on its own — see
 *  campus.js — but that static list is plain HTML the editor patches in
 *  directly at creation time, draft or not, so it needs its own runtime
 *  check here; see hideNonFinalRoomLinks). */
import { exportAllRooms, exportStateJSON, importStateJSON, fetchRoomStatus } from './export.js';

/**
 * Removes (or, if a whole site's list ends up empty, replaces with a short
 * note) any `.room-link` whose room isn't "final" yet — every entry here
 * came from `href="rooms/{stem}.html"`, so the room's own data file is
 * `data/{stem}.json`, fetched directly rather than needing ALL_ROOMS. Runs
 * once at page load; a room finalized after that still needs a reload to
 * appear, same as any other statically-rendered part of this page. Exported
 * (and given `doc`/`dataUrlFor` params, mirroring export.js's own
 * `dataUrlFor` convention) so it's testable directly under jsdom.
 */
export async function hideNonFinalRoomLinks(doc = document, dataUrlFor = stem => `data/${stem}.json`) {
  const links = [...doc.querySelectorAll('.room-link[href^="rooms/"]')];
  // Only lists that actually held at least one candidate link are ours to
  // touch — campus.js's own (legitimately, normally empty until a building
  // is clicked) #floor-picker-list matches `.room-list` too, and must never
  // get an empty-state note stuck in it just because nothing's landed there
  // yet.
  const affectedLists = new Set(links.map(link => link.closest('.room-list')).filter(Boolean));

  await Promise.all(links.map(async link => {
    const stem = link.getAttribute('href').replace(/^rooms\//, '').replace(/\.html$/i, '');
    const status = await fetchRoomStatus({ id: stem }, dataUrlFor);
    if (status !== 'final') link.remove();
  }));

  affectedLists.forEach(list => {
    if (list.children.length === 0 && !list.querySelector('.room-list-empty')) {
      const note = doc.createElement('p');
      note.className = 'room-list-empty search-hint';
      note.textContent = 'No finalized rooms yet — a room only appears here once it\'s been reviewed and marked Final in the editor.';
      list.appendChild(note);
    }
  });
}

export function initMenuPage() {
  hideNonFinalRoomLinks();

  document.querySelectorAll('.site-toggle').forEach(btn => {
    const target = document.getElementById(btn.dataset.target);
    if (!target) return;

    // Room lists start expanded: a checker's whole reason for opening this
    // page is to get into a room, and the collapsed default cost them a tap
    // on every visit. The toggle is still there for collapsing.
    const setOpen = open => {
      target.style.display = open ? 'flex' : 'none';
      target.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? 'Hide Rooms ▴' : 'View Rooms ▾';
    };

    setOpen(true);
    btn.addEventListener('click', () => setOpen(btn.getAttribute('aria-expanded') !== 'true'));
  });

  document.getElementById('btn-export-all').addEventListener('click', () => exportAllRooms());

  document.getElementById('btn-backup-state').addEventListener('click', () => exportStateJSON());

  const restoreInput = document.getElementById('restore-state-input');
  document.getElementById('btn-restore-state').addEventListener('click', () => restoreInput.click());
  restoreInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await importStateJSON(file);
      alert('State restored from backup. Reloading…');
      window.location.reload();
    } catch (err) {
      alert('Could not restore that file: ' + err.message);
    } finally {
      restoreInput.value = '';
    }
  });
}
