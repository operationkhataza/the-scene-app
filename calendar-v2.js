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
const MODAL_EL    = document.getElementById('cal-modal');
const MODAL_CARD  = document.getElementById('cal-modal-card');

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
    'short_description', 'description', 'ticket_url', 'poster',
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

/* formatCardDate — matches app.js exactly */
function formatCardDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
}

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

  // Promoters — "Presented by" line, no tap logic for now
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
          return `<span class="gig-card__promoter-link">${logoEl}${esc(p.name)}</span>`;
        }).join(', ')
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

  // Back face description
  const backDesc = gig.description
    ? `<div class="gig-card__back-desc">${esc(gig.description)}</div>`
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

// Close on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeCardModal();
});

// Flip delegation — wired once on the card container. Avoids stacking
// listeners every time a new card is opened.
MODAL_CARD.addEventListener('click', e => {
  if (!MODAL_EL.classList.contains('is-open')) return;
  // Pass-through: links and the close button handle themselves
  if (e.target.closest('.gig-card__back-cta'))   return;
  if (e.target.closest('.gig-card__ticket-pill')) return;

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
    // Anywhere on the front face: flip to back if there's content
    const gig = MODAL_EL._activeGig;
    if (gig && (gig.description || gig.short_description)) {
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

if (window.HoloShader) window.HoloShader.init();

init();
