/** format.js — small date helpers shared across modules. */

/** Human-facing, locale-formatted — used in the popups and summaries. */
export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Machine-friendly local timestamp: YYYY-MM-DD HH:MM.
 *
 * Used for CSV export instead of formatDate(). Locale formats are ambiguous
 * in a spreadsheet (03/04/2026 is two different days depending on who opens
 * it) and sort alphabetically rather than chronologically; this one doesn't.
 */
export function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}
