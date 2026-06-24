/* ============================================================
   THE SCENE — CALENDAR VIEW
   ────────────────────────────────────────────────────────────
   A month-grid calendar surface — sibling to the gig guide.
   Same Directus endpoint, same data shape, same design system.

   What's here:
     • Month grid (7 cols × 5–6 rows) of the current month
     • Tier pips in each cell — coloured dots for Holographic / Gold /
       Silver events on that day (max 3, brightest tier first)
     • Selected-day panel below the grid — that day's events rendered
       as mini-cards per graphics manual §7
     • Prev / Next / Today month navigation
     • URL routing: ?day=YYYY-MM-DD pre-selects a day
                    ?month=YYYY-MM jumps to a month

   What's NOT here:
     • Filters — calendar's job is overview, not filtering
     • Search — same reason
   ============================================================ */

document.addEventListener('gesturestart',  e => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', e => e.preventDefault(), { passive: false });
document.addEventListener('gestureend',    e => e.preventDefault(), { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', e => {
  const now = Date.now();
  if (now - lastTouchEnd < 350) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

import { API, apiGet, fetchFeatured } from './api.js';
import {
  esc, isoDate, formatCardDate, formatLongDate,
  formatTime, getParam, imgUrl
} from './utils.js';

/* DOM */
const GRID_EL     = document.getElementById('cal-grid');
const DAY_EL      = document.getElementById('cal-day');
const PREV_BTN    = document.getElementById('cal-nav-prev');
const NEXT_BTN    = document.getElementById('cal-nav-next');
const MONTH_LABEL = document.getElementById('cal-nav-month-label');
const MODAL_EL    = document.getElementById('cal-modal');
const MODAL_CARD  = document.getElementById('cal-modal-card');
const PROMO_BD    = document.getElementById('promoter-backdrop');
const PROMO_SHEET = document.getElementById('promoter-sheet');
const PROMO_TITLE = document.getElementById('promoter-sheet-title');
const PROMO_BODY  = document.getElementById('promoter-sheet-body');
const PROMO_CLOSE = document.getElementById('promoter-sheet-close');

/* ============================================================
   STATE — minimal. Just the focused month and the selected day,
   plus a cache of events by ISO date so flipping months doesn't
   re-fetch already-loaded ranges.
   ============================================================ */
const state = {
  viewMonth:   null,     // first day of the focused month, as Date
  selectedDay: null,     // selected day as ISO string YYYY-MM-DD
  eventsByDate: new Map(), // ISO date -> array of events
  monthsLoaded: new Set(), // YYYY-MM keys we've already fetched
};

/* In-flight guard for month navigation — blocks overlapping swipes/taps
   from skipping months or interleaving renders while a change is animating
   or fetching. */
let navigating = false;

/* ============================================================
   DATE HELPERS — month-grid specific. The shared date/format
   helpers (isoDate, formatCardDate, formatLongDate, formatTime,
   getParam, imgUrl, esc) now live in utils.js, imported above.
   ============================================================ */
function isoMonth(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d)   { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }

function formatMonth(d) {
  return d.toLocaleDateString('en-ZA', { month: 'long' });
}

/* ============================================================
   TIER ASSIGNMENT — same rule as the gig guide:
     3+ curators → Holographic (tier 3)
     2 curators  → Gold        (tier 2)
     1 curator   → Silver      (tier 1)
     0 curators  → Uncurated   (tier 0)
   ============================================================ */
function gigTier(gig) {
  const curators = (gig.curators || []).map(c => c.curators_id).filter(Boolean);
  if (curators.length >= 3) return 3;
  if (curators.length === 2) return 2;
  if (curators.length === 1) return 1;
  return 0;
}

/* ============================================================
   THEATRE PARENT-CHILD COALESCING — identical contract to app.js.
   A theatre night inherits production-wide fields from its
   `parent_run`; per-instance + per-night relations stay on the child.
   Applied once when events are bucketed, so grid pips, day cards and
   the modal all read one uniform shape. Ordinary gigs pass through.
   NOTE: unlike app.js, the calendar lazy-loads `description` — but we
   DO request `parent_run.description` so a theatre night arrives with
   its blurb already coalesced (hydrateDescriptions then skips it).
   ============================================================ */
function resolveGig(event) {
  const run = event && event.parent_run;
  if (!run || typeof run !== 'object') return event;   // ordinary gig
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
    venue:             run.venue             ?? event.venue,
    _isRun: true,
  };
}

/* ============================================================
   DIRECTUS FETCH — same fields as app.js so the data is
   interchangeable across the two surfaces.
   ============================================================ */
async function fetchMonth(d) {
  const key = isoMonth(d);
  if (state.monthsLoaded.has(key)) return; // already cached

  const fromDate = isoDate(startOfMonth(d));
  const toDate   = isoDate(endOfMonth(d));

  // NOTE: `description` is deliberately NOT requested here — it's the heaviest
  // field and is only shown on the modal's flipped back face. It's hydrated
  // lazily per-day (see hydrateDescriptions). Loaded events therefore have
  // description === undefined, the sentinel for "not yet fetched".
  const fields = [
    'id', 'title', 'slug', 'date', 'doors_time',
    'short_description', 'ticket_url', 'poster',
    'is_free', 'ticket_tiers', 'age_restriction', 'tags',
    'venue.name',
    'venue.location',
    'event_category.id',
    'event_category.name',
    'event_category.slug',
    'artists.artists_id.name',
    'curators.curators_id.name',
    'curators.curators_id.logo',
    'promoters.promoters_id.id',
    'promoters.promoters_id.name',
    'promoters.promoters_id.profile_image',
    // Theatre parent run — production-wide fields a night inherits (see resolveGig).
    // `description` IS requested here (unlike for gigs) so theatre nights arrive
    // with their blurb already coalesced; ordinary gigs still lazy-load it.
    'parent_run.id',
    'parent_run.status',
    'parent_run.title',
    'parent_run.slug',
    'parent_run.short_description',
    'parent_run.description',
    'parent_run.ticket_url',
    'parent_run.poster',
    'parent_run.is_free',
    'parent_run.ticket_tiers',
    'parent_run.age_restriction',
    'parent_run.tags',
    'parent_run.venue.name',
    'parent_run.venue.location',
  ].join(',');

  // Generous base limit as a sanity bound. We intentionally avoid limit=-1:
  // if Directus has QUERY_LIMIT_MAX set, -1 is silently clamped server-side,
  // which would reintroduce the very silent-truncation bug we're guarding
  // against. meta=filter_count returns the TOTAL matching rows (ignoring the
  // limit) so we can detect — and self-heal — any overflow.
  const PAGE = 500;
  const params = new URLSearchParams({
    'filter[status][_eq]': 'published',
    'filter[date][_gte]':  fromDate,
    'filter[date][_lte]':  toDate,
    'sort':   'date,doors_time',
    'fields': fields,
    'limit':  String(PAGE),
    'meta':   'filter_count',
  });
  // Parent-status guard (same as app.js): show a child only if it has no parent
  // run, OR its parent run is published — so a published theatre night under a
  // draft/pending parent never leaks as a blank pip/card.
  params.set('filter[_or][0][parent_run][_null]', 'true');
  params.set('filter[_or][1][parent_run][status][_eq]', 'published');

  try {
    // apiGet throws on a bad response; the catch below logs it and marks the
    // month loaded (so we don't retry endlessly), same as the old inline guard.
    const json = await apiGet('/items/events', params);
    let events = json.data || [];

    // Overflow self-heal: if more rows match than we received, page through
    // the remainder and concatenate. This loop only runs in the (currently
    // impossible) case of a month exceeding PAGE events, so it costs nothing
    // on normal months — but it guarantees no day ever loses a pip silently.
    const total = json.meta?.filter_count ?? events.length;
    if (total > events.length) {
      console.warn(`[Calendar] ${key}: ${total} events exceed page size ${PAGE}; paginating remainder`);
      let offset = events.length;
      while (events.length < total) {
        const pageParams = new URLSearchParams(params);
        pageParams.set('offset', String(offset));
        pageParams.delete('meta'); // only need the count once
        const pageRes = await fetch(`${API}/items/events?${pageParams}`);
        if (!pageRes.ok) {
          console.error(`[Calendar] Directus ${pageRes.status} while paginating ${key}`);
          break;
        }
        const pageJson = await pageRes.json();
        const pageData = pageJson.data || [];
        if (pageData.length === 0) break; // defensive: avoid infinite loop
        events = events.concat(pageData);
        offset += pageData.length;
      }
    }

    // Bucket by ISO date. Normalize theatre nights (parent_run → coalesced
    // fields) here so grid pips, day cards and the modal all read one shape.
    for (const ev of events) {
      if (!ev.date) continue;
      if (!state.eventsByDate.has(ev.date)) {
        state.eventsByDate.set(ev.date, []);
      }
      state.eventsByDate.get(ev.date).push(resolveGig(ev));
    }
    state.monthsLoaded.add(key);
    console.log(`[Calendar] loaded ${events.length} events for ${key}`);
  } catch (err) {
    console.error('[Calendar] fetch failed', err);
    state.monthsLoaded.add(key);
  }
}

/* ============================================================
   DESCRIPTION HYDRATION — `description` is omitted from the month
   fetch (it's the heaviest field and only the modal back face uses
   it). We fetch it lazily for a small set of events and merge it
   back onto the same cached objects the modal reads, so by the time
   a user flips a card the text is already there.

   Sentinel: description === undefined → not yet fetched.
             description === null/''   → fetched, genuinely empty.
   ============================================================ */
async function hydrateDescriptions(events) {
  const pending = (events || []).filter(e => e && e.description === undefined);
  if (pending.length === 0) return;

  const ids = pending.map(e => e.id);
  const params = new URLSearchParams({
    'filter[id][_in]': ids.join(','),
    'fields':          'id,description',
    'limit':           String(ids.length),
  });

  try {
    const json = await apiGet('/items/events', params);
    const byId = new Map((json.data || []).map(r => [r.id, r.description ?? null]));
    // Merge onto the live cached objects (same references the modal holds).
    for (const ev of pending) {
      ev.description = byId.has(ev.id) ? byId.get(ev.id) : null;
    }
  } catch (err) {
    console.error('[Calendar] description hydrate failed', err);
    // Leave description === undefined; the modal renders its loading copy and
    // a later open will retry. Non-fatal.
  }
}

/* ============================================================
   GRID RENDER — build the 7×N month grid.
     · Days outside the current month render as faded "out" cells
       (Sun-of-the-first-week before, Sat-of-the-last-week after).
     · Each cell carries the day number + a row of tier pips.
     · The selected cell is highlighted, today is outlined separately.
   ============================================================ */
function renderGrid() {
  const month     = state.viewMonth;
  const firstDay  = startOfMonth(month);     // 1st of the focused month
  const lastDay   = endOfMonth(month);       // last day of the focused month
  const todayIso  = isoDate(new Date());

  // Sunday-start grid. Find the Sunday on or before the 1st.
  const gridStart = new Date(firstDay);
  gridStart.setDate(firstDay.getDate() - firstDay.getDay());

  // Always render 6 rows = 42 cells. Predictable height; no layout shift
  // between 5-week and 6-week months.
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + i);
    cells.push(cellDate);
  }

  // Trim trailing weeks that are entirely outside the focused month —
  // a 6-row grid with the last row all in next month looks padded.
  // We keep at minimum 5 rows. 6 only when the month actually needs it.
  let visibleCells = 42;
  while (visibleCells > 35) {
    const lastRowStart = visibleCells - 7;
    const rowAllOut = cells.slice(lastRowStart, visibleCells)
      .every(c => c.getMonth() !== month.getMonth());
    if (rowAllOut) visibleCells -= 7;
    else break;
  }

  let html = '';
  for (let i = 0; i < visibleCells; i++) {
    const d = cells[i];
    const iso = isoDate(d);
    const inMonth   = d.getMonth() === month.getMonth();
    const isToday   = iso === todayIso;
    const isSelected = iso === state.selectedDay;

    // Events on this day, sorted brightest-tier-first
    const events = state.eventsByDate.get(iso) || [];
    const tiers = events.map(gigTier).sort((a, b) => b - a);
    const uniqueTiers = [...new Set(tiers)];

    // Up to 3 pips. If there are more event tiers than fit, the third is
    // capped — the calendar shouldn't try to be a count display.
    const pipsHtml = uniqueTiers.slice(0, 3)
      .map(t => `<span class="cal-pip cal-pip--t${t}"></span>`)
      .join('');

    // Tiny event count below the pips when there are 2+ events. Single
    // event gets just the pip; multiple events surface the number so
    // dense days read as dense at a glance.
    const countHtml = events.length >= 2
      ? `<span class="cal-cell__count">${events.length}</span>`
      : '';

    const classes = [
      'cal-cell',
      inMonth ? 'cal-cell--in' : 'cal-cell--out',
      isToday ? 'cal-cell--today' : '',
      isSelected ? 'cal-cell--selected' : '',
      events.length > 0 ? 'cal-cell--has-events' : '',
    ].filter(Boolean).join(' ');

    html += `
      <button class="${classes}" type="button"
              data-iso="${iso}"
              aria-label="${formatLongDate(iso)}${events.length ? `, ${events.length} event${events.length === 1 ? '' : 's'}` : ''}"
              ${isSelected ? 'aria-current="date"' : ''}>
        <span class="cal-cell__num">${d.getDate()}</span>
        <span class="cal-cell__pips">${pipsHtml}</span>
        ${countHtml}
      </button>
    `;
  }

  GRID_EL.innerHTML = html;
  GRID_EL.style.setProperty('--cal-rows', String(visibleCells / 7));

  // Wire up tap-to-select on every cell
  GRID_EL.querySelectorAll('.cal-cell').forEach(btn => {
    btn.addEventListener('click', () => selectDay(btn.dataset.iso));
  });
}

/* ============================================================
   PRICE — mini version of app.js's priceMarkup, for the inline
   meta line on the mini-card.
   ============================================================ */
function priceLabel(gig) {
  if (gig.is_free) return 'Free';
  if (Array.isArray(gig.ticket_tiers) && gig.ticket_tiers.length > 0) {
    const prices = gig.ticket_tiers
      .map(t => parseFloat(t.price))
      .filter(p => !isNaN(p) && p > 0);
    if (prices.length > 0) return `R${Math.min(...prices)}`;
  }
  return 'TBA';
}

/* ============================================================
   DAY CARD — 16:9 poster card matching the manage-events style.
     [16:9 poster thumbnail] [title · venue · time · price]
   Preserves the poster's aspect ratio exactly as cropped.
   ============================================================ */
function renderDayCard(gig) {
  const tier = gigTier(gig);
  const curators = (gig.curators || []).map(c => c.curators_id).filter(Boolean);

  const posterSrc = imgUrl(gig.poster, { width: '320', height: '180', fit: 'contain' });
  const imageHtml = posterSrc
    ? `<img class="cal-day-card__img" src="${posterSrc}" alt="" loading="lazy">`
    : `<div class="cal-day-card__img cal-day-card__img--placeholder">${esc(gig.title.charAt(0).toUpperCase())}</div>`;

  // Meta line: curator count pill (only if curated) · time · price
  const curatorPill = curators.length > 0
    ? `<span class="cal-day-card__curators">${curators.length} curator${curators.length === 1 ? '' : 's'}</span>`
    : '';

  const venueName = gig.venue?.name ? esc(gig.venue.name) : '';
  const timeStr   = formatTime(gig.doors_time);
  const priceStr  = priceLabel(gig);

  const metaSegments = [curatorPill, timeStr ? `<span>${esc(timeStr)}</span>` : '', `<span>${esc(priceStr)}</span>`]
    .filter(Boolean);
  const metaHtml = metaSegments.length > 0
    ? `<div class="cal-day-card__meta">${metaSegments.join('<span class="cal-day-card__sep">·</span>')}</div>`
    : '';

  // Always render as a button — tapping opens the event detail modal,
  // not a direct navigation to ticket_url. The modal's back face has the CTA.
  return `
    <button class="cal-day-card cal-day-card--t${tier}" type="button" data-event-id="${esc(String(gig.id))}">
      <div class="cal-day-card__poster">
        ${imageHtml}
      </div>
      <div class="cal-day-card__body">
        <div class="cal-day-card__title">${esc(gig.title)}</div>
        ${venueName ? `<div class="cal-day-card__venue">${venueName}</div>` : ''}
        ${metaHtml}
      </div>
    </button>
  `;
}

/* formatCardDate now imported from utils.js (was a byte-identical
   copy of app.js's). */

/* priceMarkup — exact copy of app.js priceMarkup so the price
   HTML structure (price / price__prefix / price__value) is identical. */
function priceMarkup(gig) {
  if (gig.is_free) {
    return `
      <div class="price price--free">
        <span class="price__prefix">Entry</span>
        <span class="price__value">Free</span>
      </div>`;
  }
  if (Array.isArray(gig.ticket_tiers) && gig.ticket_tiers.length > 0) {
    const prices = gig.ticket_tiers
      .map(t => parseFloat(t.price))
      .filter(p => !isNaN(p) && p > 0);
    if (prices.length > 0) {
      const low    = Math.min(...prices);
      const prefix = prices.length > 1 ? 'From' : 'Tickets';
      return `
        <div class="price">
          <span class="price__prefix">${prefix}</span>
          <span class="price__value">R${low}</span>
        </div>`;
    }
  }
  return `
    <div class="price">
      <span class="price__prefix">Tickets</span>
      <span class="price__value">TBA</span>
    </div>`;
}

/* ============================================================
   EVENT DETAIL MODAL — hero-expand from tapped cal-day-card.
   Opens a full gig-card (front + flippable back) in a centred
   modal overlay. Origin point tracks the tapped card's rect so
   the card appears to expand from where the user touched.
   ============================================================ */

/* Build the full gig-card HTML for the modal.
   Mirrors app.js renderCard() exactly — same HTML structure, same CSS
   class names, same data shape — so all tier/foil/curator styles apply
   identically. (No animation-delay needed since this is a single card.) */
function renderModalCard(gig) {
  const AREA_LABELS = {
    'southern-suburbs':   'Southern Suburbs',
    'northern-suburbs':   'Northern Suburbs',
    'southern-peninsula': 'Southern Peninsula',
    'cbd':                'CBD',
    'cape-flats':         'Cape Flats',
    'atlantic-seaboard':  'Atlantic Seaboard',
  };

  // Poster
  const posterSrc = imgUrl(gig.poster, { width: '800', fit: 'contain' });
  const poster = posterSrc
    ? `<img class="gig-card__poster" src="${posterSrc}" alt="${esc(gig.title)} poster" loading="lazy">`
    : `<div class="gig-card__poster-placeholder">The Scene</div>`;

  // Meta line: DATE · DOORS TIME  (matches app.js exactly)
  const metaParts = gig.date ? [formatCardDate(gig.date)] : [];
  const timeStr = formatTime(gig.doors_time);
  if (timeStr) metaParts.push(timeStr);
  const metaStr = metaParts.join(' · ');

  // Venue + area
  const areaName = gig.venue?.location ? (AREA_LABELS[gig.venue.location] || gig.venue.location) : null;
  const venueHtml = gig.venue?.name
    ? `<p class="gig-card__venue"><span class="gig-card__venue-name">${esc(gig.venue.name)}</span>${areaName ? `<span class="gig-card__venue-area">${esc(areaName)}</span>` : ''}</p>`
    : '';

  // Artists
  const artistNames = (gig.artists || []).map(a => a.artists_id?.name).filter(Boolean);
  const artistsHtml = artistNames.length > 0
    ? `<p class="gig-card__artists"><span class="gig-card__artists-label">Featuring</span>${esc(artistNames.join(', '))}</p>`
    : '';

  // Short description (front face)
  const descHtml = gig.short_description
    ? `<p class="gig-card__desc">${esc(gig.short_description)}</p>`
    : '';

  // Tags: category (teal) + freeform tags + age restriction (neutral)
  // event_category arrives as an expanded object { id, name, slug } because
  // the fields query requests event_category.name etc.
  const catName = gig.event_category?.name || null;
  const freeformTags = Array.isArray(gig.tags) ? gig.tags : [];
  const ageTag = gig.age_restriction && gig.age_restriction !== 'all-ages'
    ? [gig.age_restriction.replace(/-/g, ' ')]
    : [];
  const allNeutral = [...freeformTags, ...ageTag];
  const tagsHtml = (catName || allNeutral.length > 0)
    ? `<div class="gig-card__tags">
        ${catName ? `<span class="tag">${esc(catName)}</span>` : ''}
        ${allNeutral.map(t => `<span class="tag tag--neutral">${esc(t)}</span>`).join('')}
      </div>`
    : '';

  // Curators — exact match to app.js curatorHtml structure
  const curators = (gig.curators || []).map(c => c.curators_id).filter(Boolean);
  const curatedLevel = curators.length >= 3 ? 3
                     : curators.length === 2 ? 2
                     : curators.length === 1 ? 1
                     : 0;
  const curatorHtml = curators.length > 0
    ? `<div class="curators">
        <span class="curators__label">Curated by</span>
        ${curators.map(c => {
          const logo = imgUrl(c.logo, { width: '60', height: '60', fit: 'cover' });
          const logoEl = logo
            ? `<img class="curator-badge__logo" src="${logo}" alt="">`
            : `<span class="curator-badge__logo curator-badge__logo--placeholder"></span>`;
          return `<span class="curator-badge">${logoEl}${esc(c.name)}</span>`;
        }).join('')}
      </div>`
    : '';

  // Promoters — "Presented by" line with tappable pill
  const promoterObjs = (gig.promoters || []).map(p => {
    const pid = p.promoters_id;
    if (!pid) return null;
    const id            = typeof pid === 'object' ? pid.id            : null;
    const name          = typeof pid === 'object' ? pid.name          : null;
    const profile_image = typeof pid === 'object' ? pid.profile_image : null;
    return (id && name) ? { id, name, profile_image } : null;
  }).filter(Boolean);
  const promoterHtml = promoterObjs.length > 0
    ? `<p class="promoter"><span class="promoter__label">Presented by</span>${
        promoterObjs.map(p => {
          const logoSrc = p.profile_image
            ? imgUrl(p.profile_image, { width: '40', height: '40', fit: 'cover' })
            : null;
          const logoEl = logoSrc
            ? `<img class="promoter-pill__logo" src="${logoSrc}" alt="">`
            : `<span class="promoter-pill__logo promoter-pill__logo--placeholder"></span>`;
          return `<button class="gig-card__promoter-link" type="button" data-promoter-id="${p.id}">${logoEl}${esc(p.name)}</button>`;
        }).join('')
      }</p>`
    : '';

  // Ticket URL
  const hasTickets = !!gig.ticket_url;
  const ticketUrl  = hasTickets ? esc(gig.ticket_url) : '';

  // Front face footer — exact match to app.js frontFooter
  const frontFooter = `
    <div class="gig-card__footer">
      <div class="gig-card__footer-row">
        ${priceMarkup(gig)}
        ${hasTickets ? `<a class="gig-card__ticket-pill" href="${ticketUrl}" target="_blank" rel="noopener noreferrer">Tickets ↗</a>` : ''}
      </div>
      <button type="button" class="gig-card__read-more">Read more →</button>
    </div>`;

  // Back face description. description === undefined means it hasn't been
  // hydrated yet (see hydrateDescriptions) — show a brief loading state rather
  // than a false "empty" so a fast flip mid-fetch never misreads as no content.
  const backDesc = gig.description
    ? `<div class="gig-card__back-desc">${esc(gig.description)}</div>`
    : gig.description === undefined
      ? `<div class="gig-card__back-desc gig-card__back-desc--loading">Loading…</div>`
      : `<div class="gig-card__back-desc gig-card__back-desc--empty">No description added yet.</div>`;

  // Back face meta — exact match to app.js backMetaParts
  const backMetaParts = [metaStr];
  if (gig.is_free) {
    backMetaParts.push('Free entry');
  } else if (Array.isArray(gig.ticket_tiers) && gig.ticket_tiers.length > 0) {
    const prices = gig.ticket_tiers.map(t => parseFloat(t.price)).filter(p => !isNaN(p) && p > 0);
    if (prices.length > 0) backMetaParts.push(`From R${Math.min(...prices)}`);
  }

  // Back face CTA
  const backCta = hasTickets
    ? `<a class="gig-card__back-cta" href="${ticketUrl}" target="_blank" rel="noopener noreferrer">Buy tickets →</a>`
    : '';

  const curatedAttr = curatedLevel > 0 ? ` data-curated="${curatedLevel}"` : '';

  return `
    <div class="gig-card"${curatedAttr}>
      <div class="gig-card__inner">

        <div class="gig-card__front">
          ${poster}
          <div class="gig-card__body">
            <div class="gig-card__meta">${esc(metaStr)}</div>
            <h2 class="gig-card__title">${esc(gig.title)}</h2>
            ${venueHtml}
            ${artistsHtml}
            ${descHtml}
            ${tagsHtml}
            ${curatorHtml}
            ${promoterHtml}
            ${frontFooter}
          </div>
        </div>

        <div class="gig-card__back">
          <button type="button" class="gig-card__close" aria-label="Close">✕</button>
          <h3 class="gig-card__back-title">${esc(gig.title)}</h3>
          <div class="gig-card__back-divider"></div>
          ${backDesc}
          <div class="gig-card__back-meta">${esc(backMetaParts.join(' · '))}</div>
          ${backCta}
        </div>

      </div>
    </div>`;
}

/* Open the modal, animating from the origin of the tapped card element. */
function openCardModal(gig, originEl) {
  // Compute transform-origin as percentages from the viewport centre
  // so the card appears to grow out of the tapped card's position.
  if (originEl) {
    const rect   = originEl.getBoundingClientRect();
    const vw     = window.innerWidth;
    const vh     = window.innerHeight;
    const cardCX = rect.left + rect.width  / 2;
    const cardCY = rect.top  + rect.height / 2;
    // Express origin relative to the modal card's own centre (which is
    // centred in the viewport). We use viewport percentages clamped to
    // something sensible so the animation always looks grounded.
    const ox = Math.round((cardCX / vw) * 100);
    const oy = Math.round((cardCY / vh) * 100);
    MODAL_CARD.style.setProperty('--origin-x', `${ox}%`);
    MODAL_CARD.style.setProperty('--origin-y', `${oy}%`);
  } else {
    MODAL_CARD.style.setProperty('--origin-x', '50%');
    MODAL_CARD.style.setProperty('--origin-y', '50%');
  }

  MODAL_CARD.innerHTML = renderModalCard(gig);
  MODAL_EL.classList.remove('is-closing');
  MODAL_EL.classList.add('is-open');

  // Mount holographic shader on tier-3 cards. We wait two rAF ticks so the
  // modal is fully painted and getBoundingClientRect() returns real dimensions
  // before the canvas is sized and the first frame is drawn.
  if (window.HoloShader) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.HoloShader.refresh();
      window.HoloShader.forceRender();
    }));
  }

  // Store current gig on the modal element so the delegated flip handler
  // can check whether there's content to flip to. Avoids stacking listeners.
  MODAL_EL._activeGig = gig;

  // Race guard: if the description hasn't been hydrated yet (the day-select
  // prefetch may not have landed, or was skipped), fetch it now and patch the
  // back face in place — but only if the modal is still showing this gig.
  if (gig.description === undefined) {
    hydrateDescriptions([gig]).then(() => {
      if (MODAL_EL._activeGig !== gig) return; // user already moved on
      const descEl = MODAL_CARD.querySelector('.gig-card__back-desc');
      if (!descEl) return;
      if (gig.description) {
        descEl.className = 'gig-card__back-desc';
        descEl.textContent = gig.description; // textContent — no HTML injection
      } else {
        descEl.className = 'gig-card__back-desc gig-card__back-desc--empty';
        descEl.textContent = 'No description added yet.';
      }
    });
  }
}

function closeCardModal() {
  if (!MODAL_EL.classList.contains('is-open')) return;
  MODAL_EL.classList.add('is-closing');
  MODAL_EL.classList.remove('is-open');

  // Clear card content after the exit animation finishes (130ms)
  setTimeout(() => {
    if (!MODAL_EL.classList.contains('is-open')) {
      // Refresh shader to tear down any canvas on the departing card
      // before we wipe the HTML, so the Map/observer don't hold stale refs.
      if (window.HoloShader) window.HoloShader.refresh();
      MODAL_CARD.innerHTML = '';
      MODAL_EL.classList.remove('is-closing');
    }
  }, 160);
}

// Close when tapping outside the card — the scroll container fills
// the viewport so we check whether the click landed on the .gig-card
// itself or on the surrounding padding area.
MODAL_CARD.addEventListener('click', e => {
  if (!MODAL_EL.classList.contains('is-open')) return;
  if (!e.target.closest('.gig-card')) closeCardModal();
}, true); // capture phase so it fires before the flip handler

// Close on Escape key — only if the promoter sheet isn't on top
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !PROMO_SHEET.classList.contains('is-open')) closeCardModal();
});

// Flip delegation — wired once on the card container. Avoids stacking
// listeners every time a new card is opened.
MODAL_CARD.addEventListener('click', e => {
  if (!MODAL_EL.classList.contains('is-open')) return;
  // Pass-through: links, the close button and the promoter pill handle themselves
  if (e.target.closest('.gig-card__back-cta'))   return;
  if (e.target.closest('.gig-card__ticket-pill')) return;
  if (e.target.closest('.gig-card__promoter-link')) return;

  const inner    = MODAL_CARD.querySelector('.gig-card__inner');
  const closeBtn = e.target.closest('.gig-card__close');
  if (!inner) return;

  if (closeBtn) {
    // ✕ on the back face: flip back to front (don't close modal)
    e.stopPropagation();
    inner.classList.remove('is-flipped');
    return;
  }

  if (inner.classList.contains('is-flipped')) {
    // Anywhere on the back face (not CTA): flip back
    inner.classList.remove('is-flipped');
  } else {
    // Anywhere on the front face: flip to back if there's content.
    // description === undefined means it's still hydrating — allow the flip
    // optimistically; the back face shows its loading state until it lands.
    const gig = MODAL_EL._activeGig;
    if (gig && (gig.description || gig.short_description || gig.description === undefined)) {
      inner.classList.add('is-flipped');
    }
  }
});

/* ============================================================
   DAY PANEL RENDER — the stack of mini-cards below the grid.
   Empty days get a single quiet line; loaded days render every
   event for that date sorted by doors time.
   ============================================================ */
function renderDay() {
  const iso = state.selectedDay;
  if (!iso) {
    DAY_EL.innerHTML = '';
    return;
  }

  const events = (state.eventsByDate.get(iso) || [])
    .slice()
    .sort((a, b) => (a.doors_time || '').localeCompare(b.doors_time || ''));

  const heading = `
    <header class="cal-day__header">
      <p class="cal-day__eyebrow">Selected day</p>
      <h2 class="cal-day__title">${esc(formatLongDate(iso))}</h2>
      <p class="cal-day__count">
        ${events.length === 0 ? 'Nothing on'
          : events.length === 1 ? '1 event'
          : `${events.length} events`}
      </p>
    </header>
  `;

  if (events.length === 0) {
    DAY_EL.innerHTML = heading + `
      <div class="cal-day__empty">
        <p>No events listed yet.</p>
        <p class="cal-day__empty-sub">Check back closer to the date — or jump to a busier day on the grid.</p>
      </div>
    `;
    return;
  }

  const list = events.map(renderDayCard).join('');
  DAY_EL.innerHTML = heading + `<div class="cal-day__list">${list}</div>`;

  // Delegate card taps to open the event detail modal
  DAY_EL.querySelectorAll('.cal-day-card[data-event-id]').forEach(cardEl => {
    cardEl.addEventListener('click', () => {
      const id = parseInt(cardEl.dataset.eventId, 10);
      const gig = events.find(e => e.id === id);
      if (gig) openCardModal(gig, cardEl);
    });
  });
}

/* ============================================================
   SELECTION + NAVIGATION
   ============================================================ */
async function selectDay(iso) {
  state.selectedDay = iso;

  // If the selected day is outside the current month, jump the view
  const d = new Date(iso + 'T00:00:00');
  if (d.getMonth() !== state.viewMonth.getMonth()
      || d.getFullYear() !== state.viewMonth.getFullYear()) {
    state.viewMonth = startOfMonth(d);
    await fetchMonth(state.viewMonth);
    updateHeader();
  }

  renderGrid();
  renderDay();

  // Prefetch this day's descriptions so a card flip is instant. Fire-and-forget
  // — runs while the user is still looking at the day panel's front faces.
  hydrateDescriptions(state.eventsByDate.get(iso) || []);

  // Update URL without reloading — bookmarkable / shareable links
  const url = new URL(window.location);
  url.searchParams.set('day', iso);
  window.history.replaceState({}, '', url);
}

/* Slide-out duration — must match the .cal-grid--out-* animation in CSS. */
const SLIDE_OUT_MS = 140;

function prefersReducedMotion() {
  return window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

/* direction: +1 = forward (next), -1 = back (prev), 0 = no slide animation.
   Animate only when moving directionally AND the target month is already
   cached — an uncached month shows the loading spinner instead of sliding,
   which keeps the spinner visible during the fetch (the slide would fade it
   out). The next month is prefetched on init, so forward swipes animate. */
async function goToMonth(d, direction = 0) {
  if (navigating) return;
  navigating = true;
  try {
    state.viewMonth = startOfMonth(d);
    updateHeader();

    const animate = direction !== 0
      && !prefersReducedMotion()
      && state.monthsLoaded.has(isoMonth(d));

    // Directional navigation deselects the day and fades its panel out — a
    // same-month day tap goes through selectDay()/renderDay() and is untouched.
    // Capture whether there's a panel to fade BEFORE clearing the selection.
    const fadingDay = direction !== 0
      && !prefersReducedMotion()
      && state.selectedDay
      && DAY_EL.innerHTML.trim() !== '';
    if (direction !== 0) state.selectedDay = null;

    // Begin exit animations (grid slide + day-panel fade run concurrently).
    if (animate) {
      // Old content exits in the travel direction.
      GRID_EL.classList.add(direction > 0 ? 'cal-grid--out-next' : 'cal-grid--out-prev');
    } else if (!state.monthsLoaded.has(isoMonth(d))) {
      // Show the spinner while fetching if this month isn't cached
      GRID_EL.innerHTML = `
        <div class="state">
          <div class="spinner"></div>
          <p class="state__text" style="margin-top: 0.75rem;">Loading ${esc(formatMonth(d))}…</p>
        </div>
      `;
    }
    if (fadingDay) DAY_EL.classList.add('cal-day--fading');

    // Hold for the exit animation if either the grid or the day panel is
    // animating out, so the fade is visible even when the grid shows a spinner.
    if (animate || fadingDay) await wait(SLIDE_OUT_MS);

    await fetchMonth(state.viewMonth);
    renderGrid();

    if (animate) {
      // Swap the exit class for the enter class in the same synchronous tick
      // (before any paint) so the grid never flashes at centre between the
      // two animations. New content arrives from the opposite side.
      GRID_EL.classList.remove('cal-grid--out-next', 'cal-grid--out-prev');
      const inClass = direction > 0 ? 'cal-grid--in-next' : 'cal-grid--in-prev';
      GRID_EL.classList.add(inClass);
      GRID_EL.addEventListener('animationend',
        () => GRID_EL.classList.remove(inClass), { once: true });
    }

    // Directional navigation cleared the selection above, so empty the panel
    // and reset its opacity (removing the fade class) for the next selection.
    if (direction !== 0) {
      DAY_EL.innerHTML = '';
      DAY_EL.classList.remove('cal-day--fading');
    } else if (state.selectedDay) {
      // Fallback (direction === 0): clear only if the selected day is off-view.
      const sel = new Date(state.selectedDay + 'T00:00:00');
      if (sel.getMonth() !== state.viewMonth.getMonth()
          || sel.getFullYear() !== state.viewMonth.getFullYear()) {
        DAY_EL.innerHTML = '';
      }
    }

    // Silently prefetch the next month in the travel direction so a second
    // consecutive swipe lands on a cached month and stays animated (rather
    // than dropping to the spinner). Mirrors the init-time prefetch.
    if (direction !== 0) {
      fetchMonth(addMonths(state.viewMonth, direction)).catch(() => {});
    }
  } finally {
    navigating = false;
  }
}

function updateHeader() {
  const monthName = formatMonth(state.viewMonth);
  const year      = String(state.viewMonth.getFullYear());
  MONTH_LABEL.textContent = `${monthName} ${year}`;
}

/* ============================================================
   FEATURED CAROUSEL — paid/curated spotlight above the month nav.
   Reuses the same 16:9 ticket card as the day panel (renderDayCard)
   and the same event modal (openCardModal). Hidden when there are
   no active featured slots. Fire-and-forget from init().
   ============================================================ */
async function renderFeatured() {
  const section = document.getElementById('featured-carousel');
  const track   = document.getElementById('featured-carousel-track');
  if (!section || !track) return;

  let events = [];
  try { events = (await fetchFeatured()).map(resolveGig); } catch (_) { /* helper already logs */ }

  if (!events.length) { section.hidden = true; return; }

  track.innerHTML = events.map(renderDayCard).join('');
  section.hidden = false;

  // Tap a featured card → open the full event modal (same as a day-panel card).
  track.querySelectorAll('.cal-day-card[data-event-id]').forEach(cardEl => {
    cardEl.addEventListener('click', () => {
      const id  = parseInt(cardEl.dataset.eventId, 10);
      const gig = events.find(e => e.id === id);
      if (gig) openCardModal(gig, cardEl);
    });
  });
}

/* ============================================================
   BOOT
   ============================================================ */
async function init() {
  const today = new Date();

  // ?day=YYYY-MM-DD pre-selects a day. ?month=YYYY-MM jumps a month
  // without selecting any day. Defaults: focused month = today's month,
  // selected day = today.
  const dayParam   = getParam('day');
  const monthParam = getParam('month');

  let focused = today;
  let selected = isoDate(today);

  if (dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam)) {
    selected = dayParam;
    focused  = new Date(dayParam + 'T00:00:00');
  } else if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    focused  = new Date(monthParam + '-01T00:00:00');
    selected = isoDate(focused); // select the 1st of that month
  }

  state.viewMonth   = startOfMonth(focused);
  state.selectedDay = selected;

  updateHeader();
  await fetchMonth(state.viewMonth);

  // Prefetch next month silently — most people who land on a calendar
  // will at minimum glance at "what's coming up". Tiny win, big polish.
  fetchMonth(addMonths(state.viewMonth, 1)).catch(() => {});

  renderGrid();
  renderDay();

  // Featured spotlight — independent of the month data, so fire-and-forget.
  renderFeatured();
}

PREV_BTN.addEventListener('click', () => goToMonth(addMonths(state.viewMonth, -1), -1));
NEXT_BTN.addEventListener('click', () => goToMonth(addMonths(state.viewMonth,  1),  1));

/* ============================================================
   SWIPE NAVIGATION — horizontal flick on the grid changes month.
     swipe left  → next month   (forward)
     swipe right → previous month (back)
   Attached to the grid only, so the weekday strip and the day
   panel below keep their normal behaviour. Passive listeners —
   we never preventDefault, so vertical scroll and the global
   double-tap guard are untouched. The axis-lock + threshold below
   ensures a vertical drag never triggers a month change.
   ============================================================ */
const SWIPE_THRESHOLD = 50;   // px of horizontal travel to count as a swipe
const SWIPE_MAX_MS    = 600;  // a flick, not a slow drag / long-press
let swipeStartX = 0, swipeStartY = 0, swipeStartTime = 0, swipeTracking = false;

GRID_EL.addEventListener('touchstart', e => {
  if (e.touches.length !== 1) { swipeTracking = false; return; }
  swipeStartX = e.touches[0].clientX;
  swipeStartY = e.touches[0].clientY;
  swipeStartTime = Date.now();
  swipeTracking = true;
}, { passive: true });

GRID_EL.addEventListener('touchend', e => {
  if (!swipeTracking) return;
  swipeTracking = false;
  const t = e.changedTouches[0];
  if (!t) return;
  const dx = t.clientX - swipeStartX;
  const dy = t.clientY - swipeStartY;
  const elapsed = Date.now() - swipeStartTime;
  if (elapsed > SWIPE_MAX_MS) return;
  if (Math.abs(dx) < SWIPE_THRESHOLD) return;
  if (Math.abs(dx) < Math.abs(dy) * 1.5) return; // mostly-vertical → ignore
  if (dx < 0) goToMonth(addMonths(state.viewMonth,  1),  1); // left → next
  else        goToMonth(addMonths(state.viewMonth, -1), -1); // right → prev
}, { passive: true });

GRID_EL.addEventListener('touchcancel', () => { swipeTracking = false; }, { passive: true });

if (window.HoloShader) window.HoloShader.init();

/* ============================================================
   PROMOTER PROFILE SHEET — mirrors the gig guide implementation.
   Opens on top of the event detail modal when a promoter pill is
   tapped. Fetches promoter bio/socials + upcoming events list.
   ============================================================ */
async function fetchPromoter(id) {
  const json = await apiGet(
    `/items/promoters/${id}?fields=id,name,bio,profile_image,website,social_links`
  );
  return json.data;
}

async function fetchPromoterEvents(promoterId) {
  const today = isoDate(new Date());
  const params = new URLSearchParams({
    'filter[promoters][promoters_id][_eq]': promoterId,
    'filter[status][_eq]':                 'published',
    'filter[date][_gte]':                  today,
    'fields':                              'id,title,date,doors_time,poster,venue.name,ticket_url',
    'sort':                                'date,doors_time',
    'limit':                               '20'
  });
  const json = await apiGet('/items/events', params);
  return json.data || [];
}

function renderPromoterProfile(promoter, events) {
  const avatarSrc  = promoter.profile_image
    ? imgUrl(promoter.profile_image, { width: '120', height: '120', fit: 'cover' })
    : null;
  const avatarHtml = avatarSrc
    ? `<img class="promoter-sheet__avatar" src="${avatarSrc}" alt="${esc(promoter.name)} logo">`
    : `<div class="promoter-sheet__avatar promoter-sheet__avatar--placeholder">${esc(promoter.name.charAt(0).toUpperCase())}</div>`;

  const bioHtml     = promoter.bio
    ? `<p class="promoter-sheet__bio">${esc(promoter.bio)}</p>`
    : '';
  const websiteHtml = promoter.website
    ? `<a class="promoter-sheet__website" href="${esc(promoter.website)}" target="_blank" rel="noopener noreferrer">Visit website ↗</a>`
    : '';

  const PLATFORM_LABELS = {
    instagram: 'Instagram', facebook: 'Facebook',
    x: 'X', youtube: 'YouTube', tiktok: 'TikTok',
    soundcloud: 'SoundCloud', spotify: 'Spotify', bandcamp: 'Bandcamp'
  };
  const socials    = Array.isArray(promoter.social_links) ? promoter.social_links : [];
  const socialHtml = socials.length > 0
    ? `<div class="promoter-sheet__socials">
        ${socials.map(s => {
          const rawPlatform = s.Platforms || s.platform || '';
          const url         = s.URL       || s.url      || '';
          if (!url) return '';
          const label = PLATFORM_LABELS[rawPlatform.toLowerCase()]
            || (rawPlatform.charAt(0).toUpperCase() + rawPlatform.slice(1))
            || url;
          return `<a class="promoter-sheet__social-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
        }).filter(Boolean).join('')}
      </div>`
    : '';

  const eventsHtml = events.length > 0
    ? `<div class="promoter-sheet__events">
        <p class="promoter-sheet__events-title">Upcoming Events</p>
        <ul class="promoter-sheet__event-list">
          ${events.map(ev => {
            const timeStr   = formatTime(ev.doors_time);
            const meta      = [formatCardDate(ev.date), timeStr, ev.venue?.name].filter(Boolean).join(' · ');
            const thumbSrc  = ev.poster ? imgUrl(ev.poster, { width: '144', fit: 'contain' }) : null;
            const thumbHtml = thumbSrc
              ? `<img class="promoter-sheet__event-thumb" src="${thumbSrc}" alt="" loading="lazy">`
              : `<div class="promoter-sheet__event-thumb promoter-sheet__event-thumb--placeholder"></div>`;
            const textHtml  = `
              <div class="promoter-sheet__event-text">
                <div class="promoter-sheet__event-title">${esc(ev.title)}</div>
                <div class="promoter-sheet__event-meta">${esc(meta)}</div>
              </div>`;
            return ev.ticket_url
              ? `<li class="promoter-sheet__event-item"><a href="${esc(ev.ticket_url)}" target="_blank" rel="noopener noreferrer" class="promoter-sheet__event-link">${thumbHtml}${textHtml}</a></li>`
              : `<li class="promoter-sheet__event-item">${thumbHtml}${textHtml}</li>`;
          }).join('')}
        </ul>
      </div>`
    : `<p class="promoter-sheet__no-events">No upcoming events scheduled.</p>`;

  return `
    <div class="promoter-sheet">
      <div class="promoter-sheet__header">
        <div class="promoter-sheet__accent-bg"></div>
        ${avatarHtml}
        <h3 class="promoter-sheet__name">${esc(promoter.name)}</h3>
        ${bioHtml}
        ${websiteHtml}
        ${socialHtml}
      </div>
      ${eventsHtml}
    </div>`;
}

function openPromoterSheet(promoterId) {
  PROMO_TITLE.textContent = 'Loading…';
  PROMO_BODY.innerHTML    = `<div class="promoter-sheet__loading"><div class="spinner"></div></div>`;
  PROMO_SHEET.classList.add('is-open');
  PROMO_BD.classList.add('is-open');
  document.body.style.overflow = 'hidden';

  fetchPromoter(promoterId)
    .then(async promoter => {
      PROMO_TITLE.textContent = promoter.name;
      let events = [];
      try { events = await fetchPromoterEvents(promoterId); } catch (_) {}
      PROMO_BODY.innerHTML = renderPromoterProfile(promoter, events);
    })
    .catch(err => {
      console.error('[Scene] fetchPromoter failed:', err);
      PROMO_BODY.innerHTML    = `<div class="state" style="padding:2rem 1rem;"><p class="state__text">Couldn't load promoter details.</p></div>`;
      PROMO_TITLE.textContent = 'Promoter';
    });
}

function closePromoterSheet() {
  PROMO_SHEET.classList.remove('is-open');
  PROMO_BD.classList.remove('is-open');
  document.body.style.overflow = '';
}

// Tap a promoter pill inside the event modal card
MODAL_CARD.addEventListener('click', e => {
  const pill = e.target.closest('.gig-card__promoter-link[data-promoter-id]');
  if (!pill) return;
  e.stopPropagation();
  openPromoterSheet(Number(pill.dataset.promoterId));
});

PROMO_CLOSE.addEventListener('click', closePromoterSheet);
PROMO_BD.addEventListener('click', closePromoterSheet);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && PROMO_SHEET.classList.contains('is-open')) closePromoterSheet();
});

init();
