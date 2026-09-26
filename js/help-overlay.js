/**
 * help-overlay.js — the keyboard-shortcuts/help popup shared by room.js and
 * the editor: each page supplies its own list of shortcut rows as plain
 * data, this renders them into the popup's shortcut-list <dl> and manages
 * opening/closing it.
 *
 * `focusManagement` mirrors room.js's own pre-existing generic overlay
 * behavior (shared there with its Reset/Search dialogs, which stay
 * page-specific and untouched): save+restore focus across open/close, trap
 * Tab inside while open, auto-focus the first focusable element on open.
 * It defaults to off, matching the editor's simpler current behavior (a
 * bare open/close toggle, no focus management) — room.js turns it on so its
 * own behavior is unchanged by this extraction.
 */
export function renderShortcutRows(list, rows) {
  list.innerHTML = rows.map(([kbd, desc]) => `
    <div><dt class="kbd">${kbd}</dt><dd>${desc}</dd></div>`).join('');
}

function focusables(overlay) {
  return [...overlay.querySelectorAll('button, textarea, [href], input, select')]
    .filter(el => !el.disabled);
}

export function createHelpOverlay({ overlay, list, rows, openBtn, closeBtn, focusManagement = false }) {
  renderShortcutRows(list, rows);

  let lastFocused = null;

  function isOpen() { return overlay.classList.contains('open'); }

  function open() {
    if (focusManagement) {
      lastFocused = document.activeElement;
      overlay.classList.add('open');
      focusables(overlay)[0]?.focus?.();
    } else {
      overlay.classList.add('open');
    }
  }

  function close() {
    if (!isOpen()) return;
    overlay.classList.remove('open');
    if (focusManagement) {
      if (lastFocused?.isConnected) lastFocused.focus?.();
      lastFocused = null;
    }
  }

  overlay.addEventListener('keydown', e => {
    if (!focusManagement || e.key !== 'Tab') return;
    const items = focusables(overlay);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  openBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  return { open, close, isOpen };
}
