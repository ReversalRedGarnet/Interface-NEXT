/**
 * disclosure.js — the collapsible-section chrome shared by room.js's
 * Legend & Stats and the editor's Legend: a toggle button whose own label
 * text carries the open/closed state (▴/▾), aria-expanded on the button,
 * and `hidden` on the body — the same disclosure convention menu.js's own
 * site-toggle already established. Each page supplies its own label text
 * and body content ("each page supplies its own legend entries... one
 * shared rendering/collapse implementation"); this module only ever manages
 * open/closed state, never the content inside the body.
 */
export function createDisclosure({ toggleBtn, body, openLabel, closedLabel, defaultOpen = false }) {
  function setOpen(open) {
    body.hidden = !open;
    toggleBtn.setAttribute('aria-expanded', String(open));
    toggleBtn.textContent = open ? openLabel : closedLabel;
  }
  function isOpen() { return !body.hidden; }

  toggleBtn.addEventListener('click', () => setOpen(!isOpen()));
  setOpen(defaultOpen);

  return { setOpen, isOpen };
}
