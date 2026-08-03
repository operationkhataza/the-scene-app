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

/* ============================================================
   CURATION TIER — single source of truth for the whole app.
   ────────────────────────────────────────────────────────────
   Visual ladder (raised 29 Jul 2026; was 3+/2/1):
     4+ curators → tier 3 (rainbow holographic, WebGL HoloShader)
     3 curators  → tier 2 (gold sheen)
     2 curators  → tier 1 (silver sheen)
     0-1 curator → tier 0 (plain card)

   TIER vs RANK are deliberately different and must stay that way.
   A single-curator event renders plain (no sheen) but still sorts
   above a wholly uncurated one, so `curatorRank` counts raw curators
   while `gigTier` applies the thresholds. Don't collapse them.

   The `.map(...).filter(Boolean)` form below is required — a
   `.filter(c => c.curators_id)` shape has bitten us before by leaving
   junction rows in place of curator records.

   This lives here because the ladder was previously copy-pasted into
   eight places across app.js / calendar.js / map.js and drifted.
   ============================================================ */
function curatorList(gig) {
  return (gig.curators || []).map(c => c.curators_id).filter(Boolean);
}

/* Visual tier 0-3 — drives data-curated, cal-pip--t*, map-pin--t*,
   featured-card--t* and the holo shader selector. */
export function gigTier(gig) {
  const n = curatorList(gig).length;
  if (n >= 4) return 3;
  if (n === 3) return 2;
  if (n === 2) return 1;
  return 0;
}

/* Sort priority only — higher appears first. Raw curator count capped
   at 4 so every extra curator still lifts an event, including the
   first one that earns no visual treatment. */
export function curatorRank(gig) {
  return Math.min(curatorList(gig).length, 4);
}

/* ---- HTML escaping ---- */
export function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ============================================================
   VENUE / THEATRE-RUN COALESCING
   ────────────────────────────────────────────────────────────
   A pending (unapproved) venue must not have its name shown publicly:
   the event still lists, but its venue reads blank until an editor
   flips the venue to `published`. The public Directus read policy
   deliberately RETURNS pending venues (the submit form's
   venue-suggestion flow needs to read the new row's id back — see
   docs/directus.md), so the leak can't be closed at the policy layer
   without breaking suggestions; we blank it here at ingestion instead.
   Whole-object blank (not just the name) so a pending venue's area
   vanishes too. A venue with no `status` in the payload is left
   untouched (safe fallback). Previously copy-pasted into app.js,
   calendar.js, map.js and exhibitions.js — lifted here verbatim.
   ============================================================ */
export function publicVenue(venue) {
  return (venue && typeof venue === 'object' && venue.status && venue.status !== 'published')
    ? null
    : venue;
}

/* A theatre night inherits production-wide fields from its `parent_run`;
   per-instance + per-night relations (artists/curators/promoters, date/
   time) stay on the child. Applied once when events are bucketed, so
   grid pips, day cards and the modal all read one uniform shape.
   Ordinary gigs pass through untouched. Previously copy-pasted into
   app.js, calendar.js and map.js — lifted here verbatim. */
export function resolveGig(event) {
  const run = event && event.parent_run;
  if (!run || typeof run !== 'object') {               // ordinary gig
    if (event) event.venue = publicVenue(event.venue);
    return event;
  }
  return {
    ...event,
    title:             run.title             ?? event.title,
    slug:              run.slug              ?? event.slug,
    short_description: run.short_description ?? event.short_description,
    description:       run.description       ?? event.description,
    poster:            run.poster            ?? event.poster,
    ticket_url:        run.ticket_url        ?? event.ticket_url,
    is_free:           run.is_free           ?? event.is_free,
    ticket_tiers:      run.ticket_tiers      ?? event.ticket_tiers,
    age_restriction:   run.age_restriction   ?? event.age_restriction,
    tags:              run.tags              ?? event.tags,
    venue:             publicVenue(run.venue ?? event.venue),
    _isRun: true,   // marker for any run-aware UI later (e.g. a "multi-night" hint)
  };
}
