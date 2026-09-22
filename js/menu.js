/** menu.js — wiring for index.html: campus toggles, export-all, backup/restore. */
import { exportAllRooms, exportStateJSON, importStateJSON } from './export.js';

export function initMenuPage() {
  document.querySelectorAll('.campus-toggle').forEach(btn => {
    const target = document.getElementById(btn.dataset.target);
    if (!target) return;

    // Room lists start expanded: an intern's whole reason for opening this
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
