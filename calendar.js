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
                    ?promoter=slug scopes the whole calendar to one
                      promoter (festival mode): identity header, month
                      fetch filtered, featured carousel suppressed, and
                      the view auto-jumps to the first upcoming event's
                      month/day (explicit ?day / ?month win over the jump)

   What's NOT here:
     • Filters — calendar's job is overview, not filtering
       (the ?promoter URL mode above is a scoped VIEW, not a filter UI)
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
  formatTime, getParam, imgUrl, gigTier,
  resolveGig
} from './utils.js';
import { renderGigCard, renderDayCard, renderFeaturedCard } from './gig-card.js';
import { createCardModal } from './card-modal.js';
import { createProfileSheet } from './profile-sheet.js';

/* DOM */
const GRID_EL     = document.getElementById('cal-grid');
const DAY_EL      = document.getElementById('cal-day');
const PREV_BTN    = document.getElementById('cal-nav-prev');
const NEXT_BTN    = document.getElementById('cal-nav-next');
const MONTH_LABEL = document.getElementById('cal-nav-month-label');
const MONTH_TEXT  = document.getElementById('cal-nav-month-text');
const MODAL_EL    = document.getElementById('cal-modal');
const MODAL_CARD  = document.getElementById('cal-modal-card');
const PROFILE_BD    = document.getElementById('profile-backdrop');
const PROFILE_SHEET = document.getElementById('profile-sheet');
const PROFILE_TITLE = document.getElementById('profile-sheet-title');
const PROFILE_BODY  = document.getElementById('profile-sheet-body');
const PROFILE_CLOSE = document.getElementById('profile-sheet-close');

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
  promoterSlug: null,      // ?promoter=slug — scopes every month fetch (festival mode)
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

// TIER ASSIGNMENT — gigTier is single-sourced in utils.js (2=silver, 3=gold, 4+=holo).

/* ============================================================
   THEATRE PARENT-CHILD COALESCING — identical contract to app.js.
   resolveGig() and publicVenue() now live in utils.js, shared with
   app.js and map.js. NOTE: unlike app.js, the calendar lazy-loads
   `description` — but we DO request `parent_run.description` so a
   theatre night arrives with its blurb already coalesced
   (hydrateDescriptions then skips it).
   ============================================================ */

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
    'venue.status',
    'event_category.id',
    'event_category.name',
    'event_category.slug',
    'genre.genres_id.name',           // live-music genre vocabulary (modal tags)
    'genre.genres_id.slug',
    'dj_genres.dj_genres_id.name',    // DJ genre vocabulary (modal tags)
    'dj_genres.dj_genres_id.slug',
    'artists.artists_id.name',
    'curators.curators_id.id',      // needed by the curator profile sheet
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
    'parent_run.venue.status',
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

  // Promoter mode (?promoter=slug): scope the month to that promoter's events.
  // Same deep M2M-junction filter as app.js's promoter feed. Fixed for the
  // lifetime of the page load, so the month caches above stay valid — and the
  // pagination clone below copies params wholesale, so it inherits the filter.
  if (state.promoterSlug) {
    params.set('filter[promoters][promoters_id][slug][_eq]', state.promoterSlug);
  }

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

  // Promoter mode: render only the weeks that hold this promoter's events —
  // a festival sitting in the first two weeks shouldn't drag two dead weeks
  // below it. Adjacent-month filler days don't count toward keeping a week
  // (their pips are suppressed anyway). If NO week has events, keep the full
  // grid: an empty month reads more honestly than a vanished one.
  let cellIdxs = [...Array(visibleCells).keys()];
  if (state.promoterSlug) {
    const keptWeeks = [];
    for (let w = 0; w < visibleCells; w += 7) {
      const hasEvents = cells.slice(w, w + 7).some(d =>
        d.getMonth() === month.getMonth() &&
        (state.eventsByDate.get(isoDate(d)) || []).length > 0);
      if (hasEvents) keptWeeks.push(w);
    }
    if (keptWeeks.length) {
      cellIdxs = keptWeeks.flatMap(w => [...Array(7).keys()].map(k => w + k));
    }
  }

  let html = '';
  for (const i of cellIdxs) {
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
  GRID_EL.style.setProperty('--cal-rows', String(cellIdxs.length / 7));

  // Wire up tap-to-select on every cell
  GRID_EL.querySelectorAll('.cal-cell').forEach(btn => {
    btn.addEventListener('click', () => selectDay(btn.dataset.iso));
  });
}

/* ============================================================
   EVENT DETAIL MODAL — hero-expand from tapped cal-day-card.
   Opens a full gig-card (front + flippable back) in a centred
   modal overlay. Origin point tracks the tapped card's rect so
   the card appears to expand from where the user touched.

   priceLabel, renderDayCard, priceMarkup and the card builder
   itself now live in gig-card.js, shared with app.js and map.js.
   No categoryLookup is passed here — fetchMonth's fields query
   already requests event_category expanded, so gigCategoryRefs's
   expanded-object branch resolves it without one.
   ============================================================ */
function renderModalCard(gig) {
  return renderGigCard(gig, { dismiss: true });
}

/* The open/close/backdrop/Escape/flip machinery now lives in
   card-modal.js, shared with app.js and map.js. This surface's own
   quirk is the hydration race guard in onOpen — description is
   deliberately omitted from fetchMonth (see hydrateDescriptions
   above), so a card whose prefetch hasn't landed yet needs a patch
   applied to the DOM after the fact, and only if the user hasn't
   since moved on to a different gig. */
const cardModal = createCardModal({
  modal: MODAL_EL,
  card: MODAL_CARD,
  render: renderModalCard,
  blockedBy: [PROFILE_SHEET],
  onProfilePill: openProfileSheet,
  onOpen: gig => {
    if (gig.description === undefined) {
      hydrateDescriptions([gig]).then(() => {
        if (cardModal.activeItem !== gig) return; // user already moved on
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
  },
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
      if (gig) cardModal.open(gig, cardEl);
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
  MONTH_TEXT.textContent = `${monthName} ${year}`;
}

/* ============================================================
   FEATURED CAROUSEL — paid/curated spotlight inside the header.
   A flyer-forward card (poster fills the card; date/time/venue/artist
   ride on top as frosted pills) — dressier than the day-panel cards.
   Tapping opens the same event modal (openCardModal). Hidden when
   there are no active featured slots. Fire-and-forget from init().
   renderFeaturedCard itself now lives in gig-card.js (shared with
   app.js).
   ============================================================ */

async function renderFeatured() {
  const section = document.getElementById('featured-carousel');
  const track   = document.getElementById('featured-carousel-track');
  if (!section || !track) return;

  // Promoter mode: no spotlight — a promoter/festival calendar must not
  // advertise unrelated events. Mirrors app.js, which suppresses the
  // carousel whenever a URL mode (?day/?curator/?promoter) is active.
  if (state.promoterSlug) { section.hidden = true; return; }

  let events = [];
  try { events = (await fetchFeatured()).map(resolveGig); } catch (_) { /* helper already logs */ }

  if (!events.length) { section.hidden = true; return; }

  track.innerHTML = events.map(renderFeaturedCard).join('');
  section.hidden = false;

  // Tap a featured card → open the full modal (events and whole runs alike).
  // Match by string id so a run's "run:<n>" id resolves too.
  track.querySelectorAll('.featured-card[data-event-id]').forEach(cardEl => {
    cardEl.addEventListener('click', () => {
      const gig = events.find(e => String(e.id) === cardEl.dataset.eventId);
      if (gig) cardModal.open(gig, cardEl);
    });
  });

  startFeaturedAutoscroll(track);
}

/* Auto-advance the featured carousel one card every 3s, looping back to the
   start after the last. Pauses while the user is interacting and resumes from
   wherever they left it. No-op for a single card or under reduced-motion. */
function startFeaturedAutoscroll(track) {
  if (!track) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (track.querySelectorAll('.featured-card').length < 2) return;
  clearInterval(track._autoscroll);

  let paused = false, resumeTimer = null;
  const pause      = () => { paused = true; clearTimeout(resumeTimer); };
  const resumeSoon = () => { clearTimeout(resumeTimer); resumeTimer = setTimeout(() => { paused = false; }, 4000); };
  track.addEventListener('pointerdown', pause,      { passive: true });
  track.addEventListener('pointerup',   resumeSoon, { passive: true });
  track.addEventListener('touchstart',  pause,      { passive: true });
  track.addEventListener('touchend',    resumeSoon, { passive: true });

  track._autoscroll = setInterval(() => {
    if (paused) return;
    const cards = track.querySelectorAll('.featured-card');
    if (cards.length < 2) return;
    const padLeft = parseFloat(getComputedStyle(track).paddingLeft) || 0;
    const anchor  = track.getBoundingClientRect().left + padLeft;
    // Current card = the one whose left edge sits nearest the rail's start.
    let curIdx = 0, best = Infinity;
    cards.forEach((c, i) => {
      const d = Math.abs(c.getBoundingClientRect().left - anchor);
      if (d < best) { best = d; curIdx = i; }
    });
    const next  = (curIdx + 1) % cards.length;
    const delta = cards[next].getBoundingClientRect().left - anchor;
    track.scrollBy({ left: delta, behavior: 'smooth' });   // wraps: next=0 scrolls back to start
  }, 3000);
}

/* ============================================================
   PROMOTER MODE (?promoter=slug) — festival/promoter-scoped calendar.
   Mirrors the gig guide's promoter feed: the same slug drives both
   surfaces, so a festival gets a feed URL and a calendar URL.
   ============================================================ */

/* Fetch the promoter's identity for the header. Mirrors app.js
   loadPromoter — warn-and-null on error/not-found; the header then
   just stays generic while the event filter still applies. */
async function loadPromoter(slug) {
  try {
    const json = await apiGet(`/items/promoters?filter[slug][_eq]=${encodeURIComponent(slug)}&fields=id,name,slug,profile_image,bio,cover_image&limit=1`);
    return json.data?.[0] || null;
  } catch (err) {
    console.warn('[Calendar] Could not load promoter:', err);
    return null;
  }
}

/* Swap the header into the promoter's identity card. Setting the title
   text and unhiding the avatar is the whole mode switch — the dark
   identity styling is pure CSS (:has() on the visible avatar), shared
   with the gig guide. Avatar only unhides when there's an image, same
   as app.js (no image → light header with just the name swapped). */
function renderPromoterHeader(promoter) {
  const titleEl  = document.getElementById('calendar-eyebrow');
  const avatarEl = document.getElementById('cal-header-avatar');
  const bioEl    = document.getElementById('cal-header-bio');
  if (titleEl) titleEl.textContent = promoter?.name || 'Promoter Events';
  if (avatarEl && promoter?.profile_image) {
    avatarEl.src    = imgUrl(promoter.profile_image, { width: '128', height: '128', fit: 'cover' });
    avatarEl.alt    = promoter.name ? `${promoter.name} logo` : '';
    avatarEl.hidden = false;
  }
  // Bio under the title (200-char field). textContent — no HTML injection.
  // Its own class, NOT .gigs-header__curator-byline: unhiding the byline would
  // trip the curator-mode :has() CSS (cyan identity card) on this header.
  if (bioEl && promoter?.bio) {
    bioEl.textContent = promoter.bio;
    bioEl.hidden = false;
  }
  // Cover image → whole-page background (festival mode, v2 experiment).
  // When the promoter has a cover_image, the art becomes the fixed
  // background of the ENTIRE calendar page (body.has-cover-bg repurposes
  // the bloom layer, body::before) and the header ribbon becomes a heavy
  // frosted-glass pane over it — no navy, no image inside the ribbon.
  // See the "--cover" rules in styles.css. The custom property lives on
  // <body> so it inherits everywhere (incl. the header, if ever needed).
  // Null cover → classes never added, the plain navy identity card stays.
  if (promoter?.cover_image) {
    // Request the cover at the device's real pixel size (screen × DPR,
    // capped at 3x). A fixed width-1280 request gets upscaled to fill a
    // full-viewport cover on a high-DPR phone (height is the binding
    // dimension there) and reads blurry. fit=cover with both dims makes
    // Directus serve the same centre crop CSS shows, at native sharpness;
    // it never upscales past the source file. screen.* is orientation-
    // normalised via the window aspect (iOS reports portrait-fixed,
    // Android swaps — this handles both).
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const sw = window.screen.width  || 390;
    const sh = window.screen.height || 844;
    const landscape = window.innerWidth > window.innerHeight;
    const coverW = Math.round((landscape ? Math.max(sw, sh) : Math.min(sw, sh)) * dpr);
    const coverH = Math.round((landscape ? Math.min(sw, sh) : Math.max(sw, sh)) * dpr);
    document.body.style.setProperty(
      '--promoter-cover',
      `url("${imgUrl(promoter.cover_image, { width: String(coverW), height: String(coverH), fit: 'cover' })}")`
    );
    document.body.classList.add('has-cover-bg');
    const headerEl = document.querySelector('.calendar-header');
    if (headerEl) headerEl.classList.add('gigs-header--cover');
  }
}

/* Auto-jump lookahead: the promoter's first upcoming event date, so the
   calendar can land on a month that actually has content (a festival may
   sit wholly in next month). One tiny query — date only, limit 1, same
   guards as fetchMonth. Null on none/error → caller stays on today. */
async function fetchFirstPromoterEventDate() {
  const params = new URLSearchParams({
    'filter[status][_eq]': 'published',
    'filter[date][_gte]':  isoDate(new Date()),
    'filter[promoters][promoters_id][slug][_eq]': state.promoterSlug,
    'sort':   'date',
    'fields': 'date',
    'limit':  '1',
  });
  params.set('filter[_or][0][parent_run][_null]', 'true');
  params.set('filter[_or][1][parent_run][status][_eq]', 'published');
  try {
    const json = await apiGet('/items/events', params);
    return json.data?.[0]?.date || null;
  } catch (err) {
    console.warn('[Calendar] first-event lookahead failed', err);
    return null;
  }
}

/* ============================================================
   BOOT
   ============================================================ */
/* ============================================================
   SKELETON — placeholder month grid + day-panel cards painted on
   first load while the month fetches. renderGrid() / renderDay()
   overwrite these when data arrives, so there's no layout jump.
   Initial load only — month navigation keeps its own spinner.
   ============================================================ */
function renderGridSkeleton() {
  let cells = '';
  for (let i = 0; i < 42; i++) cells += '<div class="skeleton sk-cell"></div>';
  GRID_EL.innerHTML = cells;

  const dayCard = `
    <div class="sk-day-card">
      <div class="skeleton sk-day-card__poster"></div>
      <div class="sk-day-card__lines">
        <div class="skeleton sk-line sk-line--title"></div>
        <div class="skeleton sk-line sk-line--short"></div>
      </div>
    </div>`;
  DAY_EL.innerHTML = `<div class="skeleton sk-day__header"></div>` + dayCard.repeat(3);
}

async function init() {
  const today = new Date();

  // ?day=YYYY-MM-DD pre-selects a day. ?month=YYYY-MM jumps a month
  // without selecting any day. ?promoter=slug scopes the calendar to one
  // promoter (see PROMOTER MODE above). Defaults: focused month = today's
  // month, selected day = today.
  const dayParam   = getParam('day');
  const monthParam = getParam('month');
  state.promoterSlug = getParam('promoter') || null;

  // Page-level promoter-mode hook for CSS (black calendar chrome — see the
  // .cal-promoter rules in styles.css). The header's :has(avatar) switch
  // can't serve this: it only fires once the avatar loads, and the grid
  // lives outside the header anyway.
  if (state.promoterSlug) document.body.classList.add('cal-promoter');

  // Paint the loading skeleton immediately — before ANY awaits (in promoter
  // mode the auto-jump lookahead below runs before the month fetch).
  renderGridSkeleton();

  // Promoter identity header — independent of the month data, so it loads in
  // parallel and lands whenever it lands (null → header just stays generic).
  if (state.promoterSlug) {
    loadPromoter(state.promoterSlug).then(renderPromoterHeader);
  }

  let focused = today;
  let selected = isoDate(today);

  if (dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam)) {
    selected = dayParam;
    focused  = new Date(dayParam + 'T00:00:00');
  } else if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    focused  = new Date(monthParam + '-01T00:00:00');
    selected = isoDate(focused); // select the 1st of that month
  } else if (state.promoterSlug) {
    // Auto-jump: land on the promoter's first upcoming event (month AND day),
    // so a festival that sits wholly in next month opens with content instead
    // of an empty grid. Explicit ?day / ?month above win over the jump — deep
    // links stay deterministic. No upcoming events → stay on today (the empty
    // grid is the honest state).
    const firstDate = await fetchFirstPromoterEventDate();
    if (firstDate && /^\d{4}-\d{2}-\d{2}$/.test(firstDate)) {
      selected = firstDate;
      focused  = new Date(firstDate + 'T00:00:00');
    }
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
   PROFILE SHEET — fetch/render/open/close now live in
   profile-sheet.js, shared with app.js and map.js. Opens on top of
   the event detail modal when a promoter or curator pill is tapped.
   ============================================================ */
const profileSheet = createProfileSheet({
  sheet: PROFILE_SHEET,
  backdrop: PROFILE_BD,
  title: PROFILE_TITLE,
  body: PROFILE_BODY,
});
function openProfileSheet(kind, id) {
  return profileSheet.open(kind, id);
}
function closeProfileSheet() {
  profileSheet.close();
}

// Promoter/curator pill inside the event modal card is wired via
// createCardModal's onProfilePill (see the EVENT DETAIL MODAL section).

PROFILE_CLOSE.addEventListener('click', closeProfileSheet);
PROFILE_BD.addEventListener('click', closeProfileSheet);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && PROFILE_SHEET.classList.contains('is-open')) closeProfileSheet();
});

init();
