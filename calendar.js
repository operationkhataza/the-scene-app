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
     • The bottom-sheet promoter card — that lives in the gig guide
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

const API = 'https://api.thescenecapetown.co.za';

/* DOM */
const GRID_EL     = document.getElementById('cal-grid');
const DAY_EL      = document.getElementById('cal-day');
const PREV_BTN    = document.getElementById('cal-nav-prev');
const NEXT_BTN    = document.getElementById('cal-nav-next');
const MONTH_LABEL = document.getElementById('cal-nav-month-label');

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

/* ============================================================
   DATE HELPERS — mirror app.js's contract so anything that
   formats a date elsewhere in the app reads the same.
   ============================================================ */
function isoDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
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
function formatLongDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' });
}
function formatTime(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':');
  const hour = parseInt(h, 10);
  const ampm = hour >= 12 ? 'pm' : 'am';
  const h12 = hour % 12 || 12;
  return m === '00' ? `${h12}${ampm}` : `${h12}:${m}${ampm}`;
}

function imgUrl(fileId, opts = {}) {
  if (!fileId) return null;
  const params = new URLSearchParams({ format: 'webp', quality: '80', ...opts });
  return `${API}/assets/${fileId}?${params.toString()}`;
}
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function getParam(key) {
  return new URLSearchParams(window.location.search).get(key);
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
   DIRECTUS FETCH — same fields as app.js so the data is
   interchangeable across the two surfaces.
   ============================================================ */
async function fetchMonth(d) {
  const key = isoMonth(d);
  if (state.monthsLoaded.has(key)) return; // already cached

  const fromDate = isoDate(startOfMonth(d));
  const toDate   = isoDate(endOfMonth(d));

  const fields = [
    'id', 'title', 'slug', 'date', 'doors_time',
    'short_description', 'ticket_url', 'poster',
    'is_free', 'ticket_tiers',
    'venue.name',
    'venue.location',
    'curators.curators_id.name',
    'curators.curators_id.logo',
  ].join(',');

  const params = new URLSearchParams({
    'filter[status][_eq]': 'published',
    'filter[date][_gte]':  fromDate,
    'filter[date][_lte]':  toDate,
    'sort':   'date,doors_time',
    'fields': fields,
    'limit':  '300',
  });

  try {
    const res = await fetch(`${API}/items/events?${params}`);
    if (!res.ok) {
      console.error(`[Calendar] Directus ${res.status}`);
      state.monthsLoaded.add(key); // don't retry endlessly on error
      return;
    }
    const json = await res.json();
    const events = json.data || [];

    // Bucket by ISO date
    for (const ev of events) {
      if (!ev.date) continue;
      if (!state.eventsByDate.has(ev.date)) {
        state.eventsByDate.set(ev.date, []);
      }
      state.eventsByDate.get(ev.date).push(ev);
    }
    state.monthsLoaded.add(key);
    console.log(`[Calendar] loaded ${events.length} events for ${key}`);
  } catch (err) {
    console.error('[Calendar] fetch failed', err);
    state.monthsLoaded.add(key);
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

  const tag = gig.ticket_url ? 'a' : 'div';
  const attrs = gig.ticket_url
    ? `href="${esc(gig.ticket_url)}" target="_blank" rel="noopener noreferrer"`
    : '';

  return `
    <${tag} class="cal-day-card cal-day-card--t${tier}" ${attrs}>
      <div class="cal-day-card__poster">
        ${imageHtml}
      </div>
      <div class="cal-day-card__body">
        <div class="cal-day-card__title">${esc(gig.title)}</div>
        ${venueName ? `<div class="cal-day-card__venue">${venueName}</div>` : ''}
        ${metaHtml}
      </div>
    </${tag}>
  `;
}

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

  // Update URL without reloading — bookmarkable / shareable links
  const url = new URL(window.location);
  url.searchParams.set('day', iso);
  window.history.replaceState({}, '', url);
}

async function goToMonth(d) {
  state.viewMonth = startOfMonth(d);
  updateHeader();
  // Show the spinner while fetching if this month isn't cached
  if (!state.monthsLoaded.has(isoMonth(d))) {
    GRID_EL.innerHTML = `
      <div class="state">
        <div class="spinner"></div>
        <p class="state__text" style="margin-top: 0.75rem;">Loading ${esc(formatMonth(d))}…</p>
      </div>
    `;
  }
  await fetchMonth(state.viewMonth);
  renderGrid();
  // If the selected day isn't visible in this month, clear the day panel
  if (state.selectedDay) {
    const sel = new Date(state.selectedDay + 'T00:00:00');
    if (sel.getMonth() !== state.viewMonth.getMonth()
        || sel.getFullYear() !== state.viewMonth.getFullYear()) {
      DAY_EL.innerHTML = '';
    }
  }
}

function updateHeader() {
  const monthName = formatMonth(state.viewMonth);
  const year      = String(state.viewMonth.getFullYear());
  MONTH_LABEL.textContent = `${monthName} ${year}`;
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
}

PREV_BTN.addEventListener('click', () => goToMonth(addMonths(state.viewMonth, -1)));
NEXT_BTN.addEventListener('click', () => goToMonth(addMonths(state.viewMonth,  1)));

init();
