/* ============================================================
   THE SCENE — SHARED UTILS (public app)
   ────────────────────────────────────────────────────────────
   Pure helpers single-sourced for the gig guide + calendar.
   Previously copy-pasted into app.js and calendar.js; lifted here
   verbatim so behaviour is byte-identical. No DOM/app state — just
   strings, dates, and URL building.
   ============================================================ */

import { API } from './api.js';

/* ---- URL / query ---- */
export function getParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

/* ---- Date helpers ---- */
export function isoDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
export function formatCardDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
}
export function formatLongDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' });
}
export function formatTime(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':');
  const hour = parseInt(h, 10);
  const ampm = hour >= 12 ? 'pm' : 'am';
  const h12 = hour % 12 || 12;
  return m === '00' ? `${h12}${ampm}` : `${h12}:${m}${ampm}`;
}
export function dateForDayName(dayName) {
  const map = {sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6};
  const target = map[dayName.toLowerCase()];
  if (target === undefined) return null;
  const today = new Date();
  let daysAhead = target - today.getDay();
  if (daysAhead < 0) daysAhead += 7;
  return addDays(today, daysAhead);
}

/* ---- Asset URL builder ---- */
export function imgUrl(fileId, opts = {}) {
  if (!fileId) return null;
  const params = new URLSearchParams({ format: 'webp', quality: '80', ...opts });
  return `${API}/assets/${fileId}?${params.toString()}`;
}

/* ---- HTML escaping ---- */
export function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
