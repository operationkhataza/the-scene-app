/* ============================================================
   THE SCENE — GIG GUIDE (v2)
   ────────────────────────────────────────────────────────────
   Preserves Benji's Directus fetch, routing, and date helpers.
   Adds:
     • Multi-select filter UI (Type, Area) with bottom sheet
     • Curated-first / Other-events-below hierarchy
     • Subtle load animations (CSS-driven)
     • Age restriction moved from meta line to tags area

   URL routing (unchanged from v1):
     ?day=today | tomorrow | monday | ... | 2026-04-25
     ?curator=slug | ?promoter=slug   entity-filtered feeds
   With no params the guide shows the upcoming 7-day week feed.
   ============================================================ */

/* Native-webview zoom lock.
   viewport meta handles Android and modern iOS; these JS listeners close the
   last gaps — specifically iOS Safari's `gesturestart` pinch and double-tap
   zoom that the meta can be flaky about in older iOS webviews.
   All non-passive to guarantee preventDefault() actually runs. */
document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', e => e.preventDefault(), { passive: false });
document.addEventListener('gestureend', e => e.preventDefault(), { passive: false });
// Block double-tap-to-zoom by catching the second tap within 350ms
let lastTouchEnd = 0;
document.addEventListener('touchend', e => {
  const now = Date.now();
  if (now - lastTouchEnd < 350) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

import { API, apiGet, fetchFeatured } from './api.js';
import {
  esc, isoDate, addDays, formatCardDate,
  formatTime, dateForDayName, getParam, imgUrl, curatorRank,
  resolveGig
} from './utils.js';
import {
  gigCategoryRefs as gigCategoryRefsBase, gigGenreRefs,
  renderGigCard, renderFeaturedCard
} from './gig-card.js';
import { createCardModal, attachCardFlip } from './card-modal.js';
import { createProfileSheet } from './profile-sheet.js';
import { applyCoverMode } from './cover-mode.js';

// Dev preview: ?holo=test forces every event card into the holographic tier
// so the WebGL shader is visible regardless of curator count in Directus.
// Remove the query param to restore real curator-based tier assignment.
const TEST_HOLO = new URLSearchParams(window.location.search).get('holo') === 'test';

const LIST_EL      = document.getElementById('gig-list');
const TOOLBAR_EL   = document.getElementById('toolbar');
const CLEAR_EL     = document.getElementById('toolbar-clear');
const DAY_NAV_EL    = document.getElementById('day-nav');
const DAY_NAV_PREV  = document.getElementById('day-nav-prev');
const DAY_NAV_NEXT  = document.getElementById('day-nav-next');
const DAY_NAV_LABEL = document.getElementById('day-nav-label');
const BTN_TYPE     = document.getElementById('btn-type');
const BTN_AREA     = document.getElementById('btn-area');
const BTN_PRICE    = document.getElementById('btn-price');
const BTN_GENRE    = document.getElementById('btn-genre');
const BADGE_TYPE   = document.getElementById('badge-type');
const BADGE_AREA   = document.getElementById('badge-area');
const BADGE_PRICE  = document.getElementById('badge-price');
const BADGE_GENRE  = document.getElementById('badge-genre');
const SHEET        = document.getElementById('sheet');
const SHEET_BD     = document.getElementById('sheet-backdrop');
const SHEET_TITLE  = document.getElementById('sheet-title');
const SHEET_BODY   = document.getElementById('sheet-body');
const SHEET_CLOSE  = document.getElementById('sheet-close');
const SHEET_CLEAR  = document.getElementById('sheet-clear');
const SHEET_APPLY  = document.getElementById('sheet-apply');
const MODAL_EL     = document.getElementById('cal-modal');
const MODAL_CARD   = document.getElementById('cal-modal-card');

/* ============================================================
   STATE
   ============================================================ */

// Price slider — continuous value from 0 (Free) to PRICE_MAX (300+) in PRICE_STEP increments.
// Shows all events priced at or below the selected value. Null means no price filter active.
const PRICE_MIN = 0;
const PRICE_MAX = 300;
const PRICE_STEP = 50;
const PRICE_TICK_VALUES = [0, 50, 100, 150, 200, 250, 300]; // for tick labels under the slider

// Genre terms that are data-entry escape hatches, not real genres — kept in
// Directus (submitters still need them) but never offered as a filter option.
// Card display is unaffected; this only trims computeFilterOptions()'s genre list.
const GENRE_DENYLIST = new Set(['multiple', 'other']);

const state = {
  allGigs: [],
  categories: [],
  areas: [],
  typeOptions: [],
  areaOptions: [],
  genreOptions: [],
  selectedTypes: new Set(),
  selectedAreas: new Set(),
  selectedGenres: new Set(),
  selectedPriceMax: null,  // null = no filter; number = show gigs priced ≤ this value
  searchQuery: '',         // name search string
  currentSheet: null,      // 'type' | 'area' | 'price' | 'genre' | null
  activeSheetContent: null, // 'filter' | 'promoter' | 'curator' | null
  sheetDraft: new Set(),   // working copy while sheet open (type/area/genre)
  sheetDraftPrice: null,   // working copy while price sheet open
  dayCache: new Map(),     // iso date -> resolved gigs[], single-day view chevron nav
};

// Race guard for day-nav chevron taps, mirrors map.js's fetchToken: bumped on
// every goToDay() call so a stale in-flight response (from a fast double-tap)
// can be discarded instead of clobbering a newer one.
let dayFetchToken = 0;

/* ============================================================
   HELPERS — esc / imgUrl / date helpers / getParam now live in
   utils.js (imported at top); slugify moved into gig-card.js with
   the genre accessor it exists for.
   ============================================================ */

/* ============================================================
   FILTER OPTIONS — derived from loaded taxonomies + event counts
   ────────────────────────────────────────────────────────────
   Source of truth for names/slugs is Directus (state.categories,
   state.areas). We only SHOW options that have events in the
   current view, so the filter never lists empty categories.
   ============================================================ */

/* ============================================================
   CATEGORY ACCESSORS — shape-agnostic
   ────────────────────────────────────────────────────────────
   The shape-handling itself now lives in gig-card.js (shared with
   calendar.js and map.js). What's app-specific is the lookup: this
   surface's fields query sends event_category as a scalar FK, so a
   scalar id needs resolving against state.categories (loaded
   separately) — these wrappers close over that lookup so the rest
   of this file's call sites don't need to know it exists.
   ============================================================ */

function lookupCategory(id) {
  // IDs from Directus can arrive as number or string; normalise on both sides
  const n = Number(id);
  const cat = state.categories.find(c => Number(c.id) === n);
  return cat ? { slug: cat.slug, name: cat.name } : null;
}

function gigCategoryRefs(gig) {
  return gigCategoryRefsBase(gig, lookupCategory);
}

function gigCategorySlugs(gig) {
  return gigCategoryRefs(gig).map(r => r.slug);
}

function gigCategoryNames(gig) {
  return gigCategoryRefs(gig).map(r => r.name);
}

/* ============================================================
   GENRE ACCESSOR — gigGenreRefs itself now lives in gig-card.js
   (shared with calendar.js and map.js); gigGenreSlugs is a thin
   filter-only wrapper unique to this surface.
   ============================================================ */
function gigGenreSlugs(gig) {
  return gigGenreRefs(gig).map(r => r.slug);
}

/* venue.area is a flat Dropdown string on the venues collection,
   e.g. "cbd", "southern_suburbs". Returns null if not set. */
function gigAreaSlug(gig) {
  return gig.venue?.location || null;
}

/* Returns the minimum ticket price in ZAR, 0 for free, or null if unknown. */
function gigMinPrice(gig) {
  if (gig.is_free) return 0;
  if (Array.isArray(gig.ticket_tiers) && gig.ticket_tiers.length > 0) {
    const prices = gig.ticket_tiers
      .map(t => parseFloat(t.price))
      .filter(p => !isNaN(p) && p >= 0);
    if (prices.length > 0) return Math.min(...prices);
  }
  return null;
}

/* True when the gig's minimum price is at or below the selected threshold.
   At the slider maximum (PRICE_MAX), events priced above it are still included
   because that end of the slider represents "everything at this price or higher too". */
function matchesPriceFilter(gig) {
  if (state.selectedPriceMax === null) return true;
  const price = gigMinPrice(gig);
  if (price === null) return false;
  if (state.selectedPriceMax >= PRICE_MAX) return true; // "300+" = show everything with a price
  return price <= state.selectedPriceMax;
}

function computeFilterOptions() {
  const typeCounts = new Map();
  const areaCounts = new Map();
  const genreCounts = new Map(); // slug -> { slug, name, count }

  state.allGigs.forEach(gig => {
    gigCategorySlugs(gig).forEach(slug => {
      typeCounts.set(slug, (typeCounts.get(slug) || 0) + 1);
    });
    const areaSlug = gigAreaSlug(gig);
    if (areaSlug) {
      areaCounts.set(areaSlug, (areaCounts.get(areaSlug) || 0) + 1);
    }
    gigGenreRefs(gig).forEach(ref => {
      if (GENRE_DENYLIST.has(ref.slug)) return;
      const existing = genreCounts.get(ref.slug);
      if (existing) existing.count++;
      else genreCounts.set(ref.slug, { slug: ref.slug, name: ref.name, count: 1 });
    });
  });

  state.typeOptions = state.categories
    .filter(cat => typeCounts.has(cat.slug))
    .map(cat => ({ slug: cat.slug, name: cat.name, count: typeCounts.get(cat.slug) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  state.areaOptions = state.areas
    .filter(a => areaCounts.has(a.slug))
    .map(a => ({ slug: a.slug, name: a.name, count: areaCounts.get(a.slug) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  state.genreOptions = [...genreCounts.values()]
    .sort((a, b) => a.name.localeCompare(b.name));

  // No genre-tagged events in the current view (e.g. a curator/promoter feed
  // with no live-music or DJ events yet) — grey the pill out instead of
  // letting it open onto an empty sheet.
  if (BTN_GENRE) BTN_GENRE.disabled = state.genreOptions.length === 0;
}

/* ============================================================
   FILTER APPLICATION
   ============================================================ */
function applyFilters(gigs) {
  return gigs.filter(gig => {
    if (state.selectedTypes.size > 0) {
      const gigSlugs = gigCategorySlugs(gig);
      const hasMatch = gigSlugs.some(s => state.selectedTypes.has(s));
      if (!hasMatch) return false;
    }
    if (state.selectedAreas.size > 0) {
      const areaSlug = gigAreaSlug(gig);
      if (!areaSlug || !state.selectedAreas.has(areaSlug)) return false;
    }
    if (state.selectedGenres.size > 0) {
      const gigGenreSlugsList = gigGenreSlugs(gig);
      const hasMatch = gigGenreSlugsList.some(s => state.selectedGenres.has(s));
      if (!hasMatch) return false;
    }
    if (!matchesPriceFilter(gig)) return false;
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      if (!gig.title.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

function updateFilterBadges() {
  const t = state.selectedTypes.size;
  const a = state.selectedAreas.size;
  const g = state.selectedGenres.size;
  const priceActive = state.selectedPriceMax !== null;
  BADGE_TYPE.hidden = t === 0;
  BADGE_TYPE.textContent = t;
  BTN_TYPE.classList.toggle('is-active', t > 0);
  BADGE_AREA.hidden = a === 0;
  BADGE_AREA.textContent = a;
  BTN_AREA.classList.toggle('is-active', a > 0);
  if (BADGE_GENRE) {
    BADGE_GENRE.hidden = g === 0;
    BADGE_GENRE.textContent = g;
  }
  if (BTN_GENRE) BTN_GENRE.classList.toggle('is-active', g > 0);
  BADGE_PRICE.hidden = !priceActive;
  // Show the chosen ceiling on the button badge (e.g. "200", "300+" as max)
  BADGE_PRICE.textContent = priceActive
    ? (state.selectedPriceMax >= PRICE_MAX ? `${PRICE_MAX}+` : `${state.selectedPriceMax}`)
    : '';
  BTN_PRICE.classList.toggle('is-active', priceActive);

  const anyActive = t > 0 || a > 0 || g > 0 || priceActive || !!state.searchQuery;
  if (CLEAR_EL) CLEAR_EL.hidden = !anyActive;
}

/* ============================================================
   SHEET — open, close, render options, commit
   ============================================================ */
function openSheet(kind) {
  state.currentSheet = kind;
  state.activeSheetContent = 'filter';
  SHEET.removeAttribute('data-mode');
  if (kind === 'price') {
    // Seed the draft from the current committed value, defaulting to PRICE_MIN if none
    state.sheetDraftPrice = state.selectedPriceMax !== null ? state.selectedPriceMax : PRICE_MIN;
  } else {
    const selected = kind === 'type' ? state.selectedTypes
                    : kind === 'genre' ? state.selectedGenres
                    : state.selectedAreas;
    state.sheetDraft = new Set(selected);
  }
  SHEET_TITLE.textContent = kind === 'type' ? 'Filter by type'
                          : kind === 'area' ? 'Filter by area'
                          : kind === 'genre' ? 'Filter by genre'
                          : 'Filter by price';
  renderSheetOptions();
  SHEET.classList.add('is-open');
  SHEET_BD.classList.add('is-open');
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  SHEET.classList.remove('is-open');
  SHEET_BD.classList.remove('is-open');
  document.body.style.overflow = '';
  state.currentSheet = null;
  state.activeSheetContent = null;
  // Defer data-mode removal until after the slide-down animation completes.
  // Removing it immediately causes the hidden footer to reappear mid-transition,
  // changing the sheet height so translateY(100%) snaps to a new baseline — the jump.
  SHEET.addEventListener('transitionend', () => {
    SHEET.removeAttribute('data-mode');
    scheduleRefractUpdate();
  }, { once: true });
}

/* ============================================================
   PROFILE SHEET — lazy-loaded promoter / curator bottom sheet.
   Fetch/render/open now live in profile-sheet.js, shared with
   calendar.js and map.js. This surface's own quirk: it reuses the
   filter sheet's elements rather than a dedicated pair, so the
   profile sheet has no dedicated close path here — closeSheet()
   below (shared with the filter sheet) handles both, and onOpen
   is only used to keep state.activeSheetContent in sync.
   ============================================================ */
const profileSheet = createProfileSheet({
  sheet: SHEET,
  backdrop: SHEET_BD,
  title: SHEET_TITLE,
  body: SHEET_BODY,
  onOpen: kind => { state.activeSheetContent = kind; },
});
function openProfileSheet(kind, id) {
  return profileSheet.open(kind, id);
}

function renderSheetOptions() {
  if (state.currentSheet === 'price') {
    renderPriceSlider();
    return;
  }

  const options = state.currentSheet === 'type' ? state.typeOptions
                 : state.currentSheet === 'genre' ? state.genreOptions
                 : state.areaOptions;

  if (!options || options.length === 0) {
    SHEET_BODY.innerHTML = `
      <div class="state" style="padding: 2rem 1rem;">
        <p class="state__text">No ${state.currentSheet} options yet for this view.</p>
      </div>`;
    return;
  }

  SHEET_BODY.innerHTML = options.map(opt => {
    const selected = state.sheetDraft.has(opt.slug);
    return `
      <div class="sheet-option ${selected ? 'is-selected' : ''}" data-slug="${esc(opt.slug)}" role="option" aria-selected="${selected}" tabindex="0">
        <span class="sheet-option__label">${esc(opt.name)}</span>
        <span class="sheet-option__count">${opt.count}</span>
        <span class="sheet-option__check" aria-hidden="true">
          <svg viewBox="0 0 14 14" fill="none">
            <path d="M2.5 7.5L5.5 10.5L11.5 3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
      </div>
    `;
  }).join('');

  SHEET_BODY.querySelectorAll('.sheet-option').forEach(el => {
    el.addEventListener('click', () => {
      const slug = el.dataset.slug;
      if (state.sheetDraft.has(slug)) state.sheetDraft.delete(slug);
      else state.sheetDraft.add(slug);
      el.classList.toggle('is-selected');
      el.setAttribute('aria-selected', el.classList.contains('is-selected'));
    });
  });
}

/* Price slider UI: shows current value, range input, tick labels, matching event count.
   Label reads "Free" at 0, "R{n}+" at the max, "Up to R{n}" otherwise. */
function renderPriceSlider() {
  const value = state.sheetDraftPrice;
  const tickCols = PRICE_TICK_VALUES.map(v =>
    `<span>${v === 0 ? 'Free' : v === PRICE_MAX ? `${v}+` : v}</span>`
  ).join('');

  SHEET_BODY.innerHTML = `
    <div class="price-slider">
      <div class="price-slider__value-row">
        <span class="price-slider__label">Maximum price</span>
        <span class="price-slider__value" id="price-slider-value"></span>
      </div>
      <input type="range"
        class="price-slider__range"
        id="price-slider-input"
        min="${PRICE_MIN}"
        max="${PRICE_MAX}"
        step="${PRICE_STEP}"
        value="${value}">
      <div class="price-slider__ticks">${tickCols}</div>
      <p class="price-slider__count" id="price-slider-count"></p>
    </div>
  `;

  const input = document.getElementById('price-slider-input');
  const valueEl = document.getElementById('price-slider-value');
  const countEl = document.getElementById('price-slider-count');

  const renderSliderReadout = v => {
    const n = Number(v);
    const fillPct = ((n - PRICE_MIN) / (PRICE_MAX - PRICE_MIN)) * 100;
    input.style.setProperty('--slider-fill', fillPct + '%');

    if (n === 0) {
      valueEl.textContent = 'Free';
      valueEl.classList.add('price-slider__value--free');
    } else if (n >= PRICE_MAX) {
      valueEl.textContent = `R${PRICE_MAX}+`;
      valueEl.classList.remove('price-slider__value--free');
    } else {
      valueEl.textContent = `Up to R${n}`;
      valueEl.classList.remove('price-slider__value--free');
    }

    // Live count of events matching the draft threshold
    const matching = state.allGigs.filter(gig => {
      const price = gigMinPrice(gig);
      if (price === null) return false;
      if (n >= PRICE_MAX) return true;
      return price <= n;
    }).length;
    countEl.innerHTML = `<strong>${matching}</strong> ${matching === 1 ? 'event' : 'events'} match`;
  };

  renderSliderReadout(value);
  input.addEventListener('input', e => {
    state.sheetDraftPrice = Number(e.target.value);
    renderSliderReadout(state.sheetDraftPrice);
  });
}

function applySheet() {
  if (state.currentSheet === 'type')  state.selectedTypes = new Set(state.sheetDraft);
  if (state.currentSheet === 'area')  state.selectedAreas = new Set(state.sheetDraft);
  if (state.currentSheet === 'genre') state.selectedGenres = new Set(state.sheetDraft);
  if (state.currentSheet === 'price') {
    // Slider at 0 (Free) with no engagement means "show only free" — distinct from "no filter".
    // But if the user never touched the slider, committing it anyway is expected behaviour.
    state.selectedPriceMax = state.sheetDraftPrice;
  }
  updateFilterBadges();
  renderFromState();
  closeSheet();
}

function clearSheet() {
  if (state.currentSheet === 'price') {
    state.sheetDraftPrice = PRICE_MIN;
    renderSheetOptions();
  } else {
    state.sheetDraft = new Set();
    renderSheetOptions();
  }
}

/* ============================================================
   THEATRE PARENT-CHILD COALESCING
   ────────────────────────────────────────────────────────────
   A theatre performance is a normal `events` row that points at a
   shared `theatre_runs` parent via `parent_run`. The child carries
   only per-instance data (date/time/status) and per-night relations
   (artists/curators/promoters); production-wide fields (title, poster,
   venue, blurb, pricing…) live on the parent.

   resolveGig() (utils.js, shared with calendar.js and map.js) runs
   once at ingestion so every downstream consumer (filters, search,
   sort, day-grouping, renderCard) sees one uniform shape. Parent wins
   for production fields; the child keeps its own id/date/time/status/
   category and curators/promoters (curation is per-night, exactly
   like a gig). Ordinary gigs pass through untouched. publicVenue
   (utils.js) is resolveGig's own venue-blanking helper, also used
   directly by the profile sheet's event list.
   ============================================================ */

/* ============================================================
   DIRECTUS FETCH
   ============================================================ */
async function fetchEvents({ fromDate, toDate, curatorSlug = null, promoterSlug = null }) {
  const fields = [
    'id', 'title', 'slug', 'date', 'doors_time',
    'short_description', 'description', 'ticket_url', 'poster',
    'is_free', 'ticket_tiers', 'age_restriction', 'tags',
    'venue.name',
    'venue.location',
    'venue.status',
    'event_category',       // works for M2O (scalar) or M2M (array); accessor handles both
    'genre.genres_id.name',           // live-music genre vocabulary (gigGenreRefs)
    'genre.genres_id.slug',
    'dj_genres.dj_genres_id.name',    // DJ genre vocabulary (gigGenreRefs)
    'dj_genres.dj_genres_id.slug',
    'artists.artists_id.name',
    'curators.curators_id.id',      // needed by the curator profile sheet
    'curators.curators_id.name',
    'curators.curators_id.logo',
    'promoters.promoters_id.id',
    'promoters.promoters_id.name',
    'promoters.promoters_id.profile_image',
    // Theatre parent run — production-wide fields a theatre night inherits.
    // resolveGig() coalesces these over the (empty) child fields at ingestion.
    // Per-night relations (artists/curators/promoters) and date/time stay on the child.
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
    'parent_run.venue.status'
  ].join(',');

  const params = new URLSearchParams({
    'filter[status][_eq]': 'published',
    'filter[date][_gte]': fromDate,
    'filter[date][_lte]': toDate,
    'sort': 'date,doors_time',
    'fields': fields,
    'limit': '200'
  });

  // Parent-status guard: show a child only if it has no parent run, OR its parent
  // run is itself published. Prevents a published theatre night whose parent is
  // still draft/pending from leaking onto the guide as a blank card.
  // ([parent_run][_null] checks the raw FK, so theatre children with a hidden
  //  (non-published) parent fail both branches and are excluded entirely.)
  params.set('filter[_or][0][parent_run][_null]', 'true');
  params.set('filter[_or][1][parent_run][status][_eq]', 'published');

  // Curator mode: filter to only events this curator has endorsed
  if (curatorSlug) {
    params.set('filter[curators][curators_id][slug][_eq]', curatorSlug);
  }

  // Promoter mode: filter to only events this promoter has presented
  if (promoterSlug) {
    params.set('filter[promoters][promoters_id][slug][_eq]', promoterSlug);
    params.set('limit', '500'); // wider date window can exceed the default 200
  }

  const res = await fetch(`${API}/items/events?${params}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Directus ${res.status}:`, body);
    throw new Error(`API ${res.status}`);
  }
  const json = await res.json();
  return json.data || [];
}

/* ============================================================
   IDENTITY HEADER (curator / promoter modes)
   ────────────────────────────────────────────────────────────
   Paints the promoter/curator name, avatar and bio into the shared
   header, and kicks off cover mode. Deliberately NOT coupled to the
   events feed: the profile is one tiny row and lands in ~100-200ms,
   while the feed is a much larger query. Keeping these together (they
   used to share one Promise.all) meant the header stayed hidden behind
   the loading hold until the SLOWEST request in the batch finished, so
   on a cold connection a slow load looked like a broken page rather
   than a loading one. See the loading-hold note in init().

   Returns a promise that resolves when the view is safe to reveal:
   identity painted, and the cover artwork (if any) actually downloaded
   rather than merely requested.
   ============================================================ */
function renderIdentityHeader(profile, { curatorSlug, promoterSlug }) {
  const titleEl    = document.getElementById('gigs-header-title');
  const subtitleEl = document.getElementById('gigs-header-subtitle');
  const bioEl      = document.getElementById('gigs-header-bio');

  if (curatorSlug) {
    const curatorBylineEl = document.getElementById('gigs-header-curator-byline');
    const avatarEl = document.getElementById('gigs-header-curator-avatar');
    if (titleEl) titleEl.textContent = profile?.name || 'Curator Picks';
    if (subtitleEl) subtitleEl.textContent = 'Curated picks';
    if (curatorBylineEl) { curatorBylineEl.hidden = false; curatorBylineEl.textContent = ''; }
    // Avatar: profile_image is optional on curators, logo is required, so fall
    // back logo-ward, same rule the profile sheet uses.
    const curatorAvatarSrc = profile?.profile_image || profile?.logo;
    if (avatarEl && curatorAvatarSrc) {
      avatarEl.src    = imgUrl(curatorAvatarSrc, { width: '128', height: '128', fit: 'cover' });
      avatarEl.alt    = profile?.name ? `${profile.name} logo` : '';
      avatarEl.hidden = false;
    }
  } else if (promoterSlug) {
    const avatarEl = document.getElementById('gigs-header-promoter-avatar');
    if (titleEl)    titleEl.textContent    = profile?.name || 'Promoter Events';
    if (subtitleEl) subtitleEl.textContent = 'Events';
    if (avatarEl && profile?.profile_image) {
      avatarEl.src    = imgUrl(profile.profile_image, { width: '128', height: '128', fit: 'cover' });
      avatarEl.alt    = profile.name ? `${profile.name} logo` : '';
      avatarEl.hidden = false;
    }
  }

  // Bio under the title block. Curator field has a 300-char soft limit, promoter
  // a 200-char hard one; both render into the same element. textContent only,
  // no HTML injection.
  if (bioEl && profile?.bio) {
    bioEl.textContent = profile.bio;
    bioEl.hidden = false;
  }

  return applyCoverMode(
    profile?.cover_image, profile?.cover_text_tone, profile?.cover_focal,
    document.querySelector('.gigs-header')
  );
}

/* ============================================================
   LOAD TAXONOMIES — categories (always) and areas (if present)
   These populate the filter UI. Both are fetched separately
   from the events call so the filter shows ALL options from
   Directus, not just options that happen to appear in the
   current date range.
   ============================================================ */
async function loadCategories() {
  try {
    const json = await apiGet('/items/event_category?fields=id,name,slug&sort=name');
    return json.data || [];
  } catch (err) {
    console.warn('Could not load event categories; Type filter will be empty', err);
    return [];
  }
}

async function loadAreas() {
  return [
    { id: 'cbd',                slug: 'cbd',                name: 'CBD' },
    { id: 'southern-suburbs',   slug: 'southern-suburbs',   name: 'Southern Suburbs' },
    { id: 'northern-suburbs',   slug: 'northern-suburbs',   name: 'Northern Suburbs' },
    { id: 'atlantic-seaboard',  slug: 'atlantic-seaboard',  name: 'Atlantic Seaboard' },
    { id: 'southern-peninsula', slug: 'southern-peninsula', name: 'Southern Peninsula' },
    { id: 'cape-flats',         slug: 'cape-flats',         name: 'Cape Flats' },
  ];
}

/* ============================================================
   LOAD CURATOR — fetches name, avatar and bio for curator-mode
   views (?curator=slug). profile_image is optional on curators
   and logo is required, so the header falls back logo-ward.
   Keep the field list inside the Public read allow-list: Directus
   rejects the WHOLE request if any named field is outside it.
   ============================================================ */
async function loadCurator(slug) {
  try {
    const json = await apiGet(`/items/curators?filter[slug][_eq]=${encodeURIComponent(slug)}&fields=id,name,slug,bio,profile_image,logo,cover_image,cover_text_tone,cover_focal&limit=1`);
    return json.data?.[0] || null;
  } catch (err) {
    console.warn('[Scene] Could not load curator:', err);
    return null;
  }
}

/* ============================================================
   LOAD PROMOTER — fetches name and avatar for promoter-mode
   views (?promoter=slug)
   ============================================================ */
async function loadPromoter(slug) {
  try {
    const json = await apiGet(`/items/promoters?filter[slug][_eq]=${encodeURIComponent(slug)}&fields=id,name,slug,profile_image,bio,cover_image,cover_text_tone,cover_focal&limit=1`);
    return json.data?.[0] || null;
  } catch (err) {
    console.warn('[Scene] Could not load promoter:', err);
    return null;
  }
}

/* ============================================================
   CARD
   ────────────────────────────────────────────────────────────
   priceMarkup + the card builder now live in gig-card.js, shared
   with the featured-carousel modal below and with calendar.js /
   map.js. TEST_HOLO maps to opts.forceTier.
   ============================================================ */
function renderCard(gig, index, eager = false) {
  return renderGigCard(gig, { index, eager, categoryLookup: lookupCategory, forceTier: TEST_HOLO });
}

/* ============================================================
   RENDER LIST
   ────────────────────────────────────────────────────────────
   Weekly view  → one horizontal swipe strip per day (today first,
                  rolling 7-day window). Empty days hidden.
   Single-day   → full-width vertical list of that day's gigs.

   Curation tier (see gigTier in utils.js) drives the holographic
   shader on each card via data-curated — it does NOT affect card
   position (that's curatorRank, also in utils.js).
   ============================================================ */

/* Format a day strip header label.
   Today → "Today"
   Any future date → "Tuesday · 28 Apr" */
function formatDayLabel(dateStr) {
  const today = isoDate(new Date());
  if (dateStr === today) return 'Today';
  const d = new Date(dateStr + 'T00:00:00');
  const dayName = d.toLocaleDateString('en-ZA', { weekday: 'long' });
  const day = d.getDate();
  const month = d.toLocaleDateString('en-ZA', { month: 'short' });
  return `${dayName} · ${day} ${month}`;
}

/* Sort by curator rank (highest first — see gigTier/curatorRank in utils.js;
   a 1-curator event still outranks an uncurated one even though both render
   plain), then chronologically by doors_time within each rank. */
function sortByTime(gigs) {
  return [...gigs].sort((a, b) => {
    const tierDiff = curatorRank(b) - curatorRank(a);
    if (tierDiff !== 0) return tierDiff;
    const ta = a.doors_time || '';
    const tb = b.doors_time || '';
    return ta.localeCompare(tb);
  });
}

/* Poster eager-loading budget. Deliberately expressed as "the first couple of
   cards in the first couple of rows" rather than a flat count of cards: the
   weekly view is horizontal strips, so a flat count would eagerly load three
   cards of the FIRST day only, two of which are off the right edge, while the
   second day's visible card stayed lazy. Rows are what stack down the screen,
   so that is the axis that matches what's actually on screen at first paint. */
const EAGER_ROWS = 2;
const EAGER_PER_ROW = 2;

/* One horizontal swipe strip for a single day. `rowIndex` is the strip's
   position down the page, used only for the eager-poster budget above. */
function renderDayStrip(dateStr, gigs, rowIndex = 0) {
  if (!gigs.length) return '';
  const sorted = sortByTime(gigs);
  const label = formatDayLabel(dateStr);
  const count = `${gigs.length} event${gigs.length === 1 ? '' : 's'}`;
  const cards = sorted
    .map((g, i) => renderCard(g, i, rowIndex < EAGER_ROWS && i < EAGER_PER_ROW))
    .join('');
  return `
    <div class="day-strip">
      <div class="day-strip__header">
        <span class="day-strip__label">${esc(label)}</span>
        <span class="day-strip__count">${count}</span>
      </div>
      <div class="day-strip__track">${cards}</div>
    </div>`;
}

/* Vertical full-width list for single-day (?day=) view. One card per row here,
   so the eager budget is simply the top few. */
function renderFlatList(gigs) {
  return sortByTime(gigs)
    .map((g, i) => renderCard(g, i, i < EAGER_ROWS))
    .join('');
}

function renderList(gigs, { groupByDate = false, singleDay = null } = {}) {
  const anyFilters = state.selectedTypes.size + state.selectedAreas.size + (state.selectedPriceMax !== null ? 1 : 0) > 0;
  const anySearch = !!state.searchQuery;

  if (!gigs.length) {
    LIST_EL.innerHTML = `
      <div class="state">
        <h2 class="state__title">${anyFilters || anySearch ? 'Nothing matches' : 'No gigs scheduled'}</h2>
        <p class="state__text">${anyFilters || anySearch
          ? 'Try adjusting your search or clearing a filter.'
          : "Nothing lined up for this view just yet. Check back soon — new events are added every week."}</p>
        ${anyFilters || anySearch ? '<button class="state__action" onclick="clearAllFilters()">Clear all</button>' : ''}
      </div>
    `;
    refreshRefractionRefs();
    return;
  }

  let html = '';

  if (singleDay) {
    // ── SINGLE-DAY VIEW — vertical full-width cards. Date is shown by the
    // #day-nav pill above the list, not repeated here (see goToDay()/init()). ──
    html += renderFlatList(gigs);
  } else {
    // ── WEEKLY VIEW — one horizontal strip per day ──
    // Group by date, then render in date order (Directus returns date-sorted
    // already, so Object.keys().sort() preserves the rolling 7-day order).
    const grouped = gigs.reduce((acc, gig) => {
      (acc[gig.date] = acc[gig.date] || []).push(gig);
      return acc;
    }, {});
    Object.keys(grouped).sort().forEach((date, rowIndex) => {
      html += renderDayStrip(date, grouped[date], rowIndex);
    });
  }

  LIST_EL.innerHTML = html;
  refreshRefractionRefs();
}

function renderError() {
  LIST_EL.innerHTML = `
    <div class="state">
      <h2 class="state__title">Couldn't load gigs</h2>
      <p class="state__text">Something went wrong reaching The Scene's server. Please refresh the page.</p>
    </div>
  `;
}

/* ============================================================
   SKELETON — placeholder shapes painted before the feed fetch
   completes. Matches the view about to render (weekly day-strips
   vs single-day vertical list), so renderList() can overwrite it
   with zero layout jump. Reads renderOptions, which init() has
   already finalized by the time this is called.
   ============================================================ */
function renderSkeleton() {
  const card = `
    <div class="sk-card">
      <div class="skeleton sk-card__poster"></div>
      <div class="sk-card__body">
        <div class="skeleton sk-line sk-line--meta"></div>
        <div class="skeleton sk-line sk-line--title"></div>
        <div class="skeleton sk-line sk-line--full"></div>
        <div class="skeleton sk-line sk-line--short"></div>
      </div>
    </div>`;

  if (renderOptions.singleDay) {
    // Single-day view: a vertical stack of cards. No date-header skeleton —
    // the #day-nav pill above the list is the date indicator now.
    LIST_EL.innerHTML = card.repeat(4);
    return;
  }

  // Weekly view: a few day-strips, each a header + a horizontal track of cards.
  const strip = `
    <div class="sk-daystrip">
      <div class="skeleton sk-daystrip__header"></div>
      <div class="day-strip__track">${card.repeat(2)}</div>
    </div>`;
  LIST_EL.innerHTML = strip.repeat(3);
}

/* ============================================================
   RENDER FROM STATE — reruns filter + render without refetching
   ============================================================ */
let renderOptions = { groupByDate: true, singleDay: null };

function renderFromState() {
  const filtered = applyFilters(state.allGigs);
  renderList(filtered, renderOptions);
}

/* ============================================================
   DAY-NAV — prev/next chevrons for the single-day (?day=) view.
   Mirrors map.js's setDay() (map.js:384-427): in-place re-render, no
   page reload, URL rewritten via replaceState (not pushState, so
   stepping through days doesn't grow the back-button stack). Active
   filters stay applied (renderFromState re-runs applyFilters against
   whatever the new day's fetch returns). Per-day results are cached
   in state.dayCache so revisiting a day already fetched this session
   renders instantly with no network call.
   ============================================================ */
async function goToDay(iso) {
  const token = ++dayFetchToken;
  renderOptions = { groupByDate: false, singleDay: iso };

  const url = new URL(window.location);
  url.searchParams.set('day', iso);
  window.history.replaceState({}, '', url);

  DAY_NAV_LABEL.textContent = formatDayLabel(iso);

  const cached = state.dayCache.get(iso);
  if (cached) {
    state.allGigs = cached;
    computeFilterOptions();
    renderFromState();
    return;
  }

  renderSkeleton();
  try {
    const gigs = await fetchEvents({ fromDate: iso, toDate: iso });
    if (token !== dayFetchToken) return; // user already stepped to another day
    state.allGigs = gigs.map(resolveGig);
    state.dayCache.set(iso, state.allGigs);
    computeFilterOptions();
    renderFromState();
  } catch (err) {
    console.error('[Scene] day-nav fetch failed', err);
    if (token !== dayFetchToken) return; // superseded — don't stomp a newer day's state
    state.dayCache.delete(iso); // allow a retry
    renderError();
  }
}

function clearAllFilters() {
  state.selectedTypes = new Set();
  state.selectedAreas = new Set();
  state.selectedGenres = new Set();
  state.selectedPriceMax = null;
  state.searchQuery = '';
  const searchEl = document.getElementById('gig-search');
  if (searchEl) searchEl.value = '';
  updateFilterBadges();
  renderFromState();
}
window.clearAllFilters = clearAllFilters; // for inline onclick

/* ============================================================
   REFRACTION — per-card holographic/metallic effect, driven by
   viewport scroll position. Updates the --refract CSS variable
   on each visible curated card. Text sits above the refracting
   background + pseudo-element via z-index, so legibility is
   preserved regardless of sheen position.
   ============================================================ */
/* ============================================================
   HOLOGRAPHIC REFRACTION
   ────────────────────────────────────────────────────────────
   Drives the --refract CSS variable (0→1) on holographic cards
   based on their position in the viewport. The CSS rainbow
   spectrum in .gig-card[data-curated="3"]::before uses --refract
   to slide its vertical background-position, producing the
   scroll-tied prismatic motion.

   Uses IntersectionObserver to maintain a small live set of
   only the holographic cards currently visible. Scroll handler
   walks that small set inside requestAnimationFrame — O(visible)
   per frame, not O(total-cards), so cost stays flat as the feed
   grows. ============================================================ */
/* STATIC_REFRACT — companion to HOLO_STATIC in holo-shader.js.
   When true, the scroll-driven --refract updates below are disabled for
   ALL curated tiers: no cards are observed, --refract is never written,
   and every sheen/foil rests at the styles.css default var(--refract, 0.5)
   (silver/gold specular mid-card, holo ::before foil at translateY(0)).
   Introduced 22 Jul 2026 with HOLO_STATIC: the per-scroll-frame
   getBoundingClientRect walk + style writes here were a jank source on
   mobile (Pixel 8 Pro), and the scroll-tied sheen/foil motion was judged
   superfluous. TO REVERT the original scroll-tied prismatic motion:
   set this false (and HOLO_STATIC = false in holo-shader.js). */
const STATIC_REFRACT = true;

const visibleHoloCards = new Set();
let refractRaf = 0;

function scheduleRefractUpdate() {
  if (refractRaf) return;
  refractRaf = requestAnimationFrame(() => {
    refractRaf = 0;
    const vh = window.innerHeight || 1;
    for (const card of visibleHoloCards) {
      const rect = card.getBoundingClientRect();
      // progress: 0 when card top is at viewport bottom; 1 when card bottom
      // has crossed viewport top. Clamped for safety.
      const p = 1 - (rect.top + rect.height * 0.5) / vh;
      const clamped = p < 0 ? 0 : p > 1 ? 1 : p;
      card.style.setProperty('--refract', clamped.toFixed(3));
    }
  });
}

const holoObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (entry.isIntersecting) visibleHoloCards.add(entry.target);
    else visibleHoloCards.delete(entry.target);
  }
  scheduleRefractUpdate();
}, { rootMargin: '50px 0px' });

function refreshRefractionRefs() {
  // Re-observe ALL curated cards (silver, gold, holographic) so every tier
  // animates with scroll. Each tier consumes --refract differently:
  //   silver/gold  → CSS uses --refract for sheen angle + specular position
  //   holographic  → WebGL shader reads scroll progress directly per-frame
  // HoloShader.refresh() registers only the data-curated="3" subset.
  visibleHoloCards.clear();
  holoObserver.disconnect();
  // With STATIC_REFRACT, no cards are observed: --refract is never set, so
  // every tier rests at the styles.css var(--refract, 0.5) default.
  if (!STATIC_REFRACT) {
    const cards = document.querySelectorAll('.gig-card[data-curated]');
    cards.forEach(c => holoObserver.observe(c));
  }
  if (window.HoloShader) window.HoloShader.refresh();


}

// Keep old no-op for any stale callers
let refractionCards = [];
function updateRefraction() { /* replaced by scheduleRefractUpdate */ }

/* ============================================================
   FEATURED CAROUSEL — paid/curated spotlight above the search bar.
   Flyer-forward cards (poster fills the card; date/time/venue/artist
   as frosted pills) — dressier than the feed's gig cards, mirroring the
   calendar. Shown only in the default guide view (curator/promoter
   deep-link modes are filtered single-entity feeds, so it stays hidden
   there). Tapping a card opens the event detail modal (mirrors the
   calendar's #cal-modal). Fire-and-forget from init().
   renderFeaturedCard itself now lives in gig-card.js (shared with
   calendar.js).
   ============================================================ */

async function renderFeatured() {
  const section = document.getElementById('featured-carousel');
  const track   = document.getElementById('featured-carousel-track');
  if (!section || !track) return;

  // Featured lives only on the main weekly guide. The single-day view (?day=)
  // and curator / promoter filtered feeds are bespoke — no spotlight there.
  if (getParam('day') || getParam('curator') || getParam('promoter')) { section.hidden = true; return; }

  let events = [];
  try { events = (await fetchFeatured()).map(resolveGig); } catch (_) { /* helper already logs */ }

  if (!events.length) { section.hidden = true; return; }

  track.innerHTML = events.map(renderFeaturedCard).join('');
  section.hidden = false;

  // Tap → open the event detail modal. Match by string id so a run's
  // "run:<n>" id resolves too.
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
   FEATURED EVENT DETAIL MODAL
   ────────────────────────────────────────────────────────────
   Only reachable from a featured-carousel tap (the regular feed's
   gig cards flip in place instead, see CARD FLIP below). The card
   builder itself is renderGigCard (gig-card.js) with dismiss:true;
   fetchFeatured() (api.js) always loads `description` eagerly, so
   the loading branch never fires here.
   ============================================================ */
function renderModalCard(gig) {
  return renderGigCard(gig, { dismiss: true, categoryLookup: lookupCategory, forceTier: TEST_HOLO });
}

/* The open/close/backdrop/Escape/flip machinery now lives in
   card-modal.js, shared with calendar.js and map.js. The guide's own
   quirk is blockedBy: [SHEET] — the filter sheet doubles as the
   promoter/curator profile sheet here, unlike calendar/map's
   dedicated #profile-sheet. */
const cardModal = createCardModal({
  modal: MODAL_EL,
  card: MODAL_CARD,
  render: renderModalCard,
  blockedBy: [SHEET],
  onProfilePill: openProfileSheet,
});

/* ============================================================
   ROUTING & INIT
   ============================================================ */

/* Lift the loading hold set by the inline <head> script (see event-guide.html).
   Idempotent, so every path that might finish first can call it freely. */
function revealHeader() {
  document.documentElement.classList.remove('cover-pending');
}

async function init() {
  const day = getParam('day');
  const curatorSlug = getParam('curator');
  const promoterSlug = getParam('promoter');
  const today = new Date();

  let fromDate, toDate;
  let headerDate = null;

  if (day) {
    let target = null;
    if (day === 'today') target = today;
    else if (day === 'tomorrow') target = addDays(today, 1);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      target = new Date(day + 'T00:00:00');
      if (isNaN(target.getTime())) target = null;
    } else target = dateForDayName(day);

    if (target) {
      fromDate = isoDate(target);
      toDate = isoDate(target);
      renderOptions = { groupByDate: false, singleDay: fromDate };
      headerDate = target;
    } else {
      fromDate = isoDate(today);
      toDate = isoDate(addDays(today, 6));
      renderOptions = { groupByDate: true, singleDay: null };
    }
  } else {
    fromDate = isoDate(today);
    toDate = isoDate(addDays(today, 6));
    renderOptions = { groupByDate: true, singleDay: null };
  }

  // ── PROMOTER MODE — 12-month window ──
  // Override whatever the default date range was: show the next 12 months so
  // visitors can see the promoter's full upcoming schedule, including
  // season-ahead bookings (e.g. classical/theatre partners).
  if (promoterSlug) {
    fromDate = isoDate(today);
    toDate   = isoDate(addDays(today, 365));
    renderOptions = { groupByDate: true, singleDay: null };
  }

  // ── CURATOR MODE — 30-day window ──
  // Override whatever the default date range was: show the next 30 days so
  // visitors can see the curator's fuller upcoming picks, not just this week.
  // If ?curator=slug is present, fetch the curator record and swap the header.
  // Both the toolbar and search bar are hidden — the curator's picks are the filter.
  if (curatorSlug) {
    fromDate = isoDate(today);
    toDate   = isoDate(addDays(today, 29));
    renderOptions = { groupByDate: true, singleDay: null };
    const toolbarEl = document.getElementById('toolbar');
    const searchEl = document.querySelector('.search-bar');
    if (toolbarEl) toolbarEl.hidden = true;
    if (searchEl) searchEl.hidden = true;
  }

  // ── PROMOTER MODE UI ──
  // Keep the filter toolbar visible (useful over a 12-month window) but hide the
  // search bar — the promoter's name in the header is the primary context.
  if (promoterSlug) {
    const searchEl = document.querySelector('.search-bar');
    if (searchEl) searchEl.hidden = true;
  }

  // ── HEADER DATE vs DAY-NAV ── plain single-day view (no curator/promoter
  // deep link — those are filtered bespoke feeds, day-stepping through them
  // isn't in scope, see the featured-carousel exclusion below for the same
  // boundary) shows the #day-nav chevron pill in place of the static date
  // line; every other mode keeps the plain text as before.
  const showDayNav = !!(renderOptions.singleDay && !curatorSlug && !promoterSlug);
  const headerDateEl = document.getElementById('gigs-header-date');
  // Promoter feeds don't need today's date in the header: it's the promoter's
  // name/identity that matters there, not the date the feed happens to load on.
  if (headerDateEl) headerDateEl.hidden = showDayNav || !!promoterSlug;
  if (headerDateEl && !showDayNav && !promoterSlug) {
    const dateToShow = headerDate || today;
    const dayName = dateToShow.toLocaleDateString('en-ZA', { weekday: 'long' });
    const dayNum = dateToShow.getDate();
    const month = dateToShow.toLocaleDateString('en-ZA', { month: 'long' });
    headerDateEl.textContent = `${dayName} ${dayNum} ${month}`;
  }
  DAY_NAV_EL.hidden = !showDayNav;
  if (showDayNav) DAY_NAV_LABEL.textContent = formatDayLabel(renderOptions.singleDay);

  // Paint the loading skeleton in the shape of the view we're about to render,
  // before awaiting the fetch (renderOptions is finalized above).
  renderSkeleton();

  // ── IDENTITY HEADER + LOADING HOLD ──
  // The profile row is tiny and lands long before the events feed, so it runs
  // on its own track and lifts the hold by itself. The feed keeps its skeleton
  // underneath in the meantime: there is no reason to hide a promoter's name
  // behind a list that takes longer to arrive. Failure is non-fatal, the feed
  // still renders with the generic header.
  //
  // The 2.5s cap only ever bites when a cover image is genuinely slow, since a
  // profile with no cover_image resolves immediately (most of them). It exists
  // so a stalled image can never strand the page on the wireframe.
  if (curatorSlug || promoterSlug) {
    const headerReady = (curatorSlug ? loadCurator(curatorSlug) : loadPromoter(promoterSlug))
      .then(profile => renderIdentityHeader(profile, { curatorSlug, promoterSlug }))
      .catch(err => { console.warn('[Scene] identity header failed:', err); });

    Promise.race([headerReady, new Promise(resolve => setTimeout(resolve, 2500))])
      .then(revealHeader);
  }

  try {
    const [categories, areas, gigs] = await Promise.all([
      loadCategories(),
      loadAreas(),
      fetchEvents({ fromDate, toDate, curatorSlug, promoterSlug }),
    ]);
    state.categories = categories;
    state.areas = areas;
    // Normalize theatre nights (parent_run → coalesced fields) once, up front,
    // so filters/search/sort/render all operate on a single uniform shape.
    state.allGigs = gigs.map(resolveGig);

    // Seed the day-nav cache with this load's result (when showing) so an
    // immediate chevron tap back to the start date is instant.
    if (showDayNav) state.dayCache.set(renderOptions.singleDay, state.allGigs);

    // ── DIAGNOSTIC — visible in browser console, helps debug filter issues ──
    console.log('[Scene] loaded:', {
      events: gigs.length,
      categories: categories.length,
      areas: areas.length,
    });
    if (gigs.length > 0) {
      const sample = gigs[0];
      console.log('[Scene] first event:', sample);
      console.log('[Scene] event_category on first event:', {
        type: typeof sample.event_category,
        isArray: Array.isArray(sample.event_category),
        value: sample.event_category,
      });
      const withCategories = gigs.filter(g => gigCategorySlugs(g).length > 0);
      console.log(`[Scene] ${withCategories.length} of ${gigs.length} events resolved to categories`);
    }

    computeFilterOptions();

    console.log('[Scene] filter options computed:', {
      typeOptions: state.typeOptions,
      areaOptions: state.areaOptions,
    });

    renderFromState();

    // Featured spotlight — independent of the feed query, so fire-and-forget.
    renderFeatured();
  } catch (err) {
    console.error('Failed to fetch gigs:', err);
    renderError();
    // An error page has nothing to wait for, so drop the hold immediately
    // rather than letting the header track's cap run down. Deliberately NOT in
    // a finally: on the happy path the header track owns the reveal, and firing
    // here as soon as events land would reveal a cover promoter's header before
    // its artwork arrived, which is the exact flash the hold exists to prevent.
    revealHeader();
  }
}

/* ============================================================
   EVENT WIRING
   ============================================================ */
DAY_NAV_PREV.addEventListener('click', () => goToDay(isoDate(addDays(new Date(renderOptions.singleDay + 'T00:00:00'), -1))));
DAY_NAV_NEXT.addEventListener('click', () => goToDay(isoDate(addDays(new Date(renderOptions.singleDay + 'T00:00:00'),  1))));

BTN_TYPE.addEventListener('click', () => openSheet('type'));
BTN_AREA.addEventListener('click', () => openSheet('area'));
BTN_PRICE.addEventListener('click', () => openSheet('price'));
if (BTN_GENRE) BTN_GENRE.addEventListener('click', () => openSheet('genre'));
SHEET_CLOSE.addEventListener('click', closeSheet);
SHEET_BD.addEventListener('click', closeSheet);
SHEET_CLEAR.addEventListener('click', clearSheet);
SHEET_APPLY.addEventListener('click', applySheet);

// "Clear all" toolbar button — resets every filter and the search query
if (CLEAR_EL) {
  CLEAR_EL.addEventListener('click', () => {
    state.selectedTypes.clear();
    state.selectedAreas.clear();
    state.selectedGenres.clear();
    state.selectedPriceMax = null;
    state.searchQuery = '';
    if (SEARCH_INPUT) SEARCH_INPUT.value = '';
    updateFilterBadges();
    renderFromState();
  });
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.currentSheet) closeSheet();
});

// Search input — filter by event name on every keystroke
const SEARCH_INPUT = document.getElementById('gig-search');
const SEARCH_CLEAR = document.getElementById('search-clear');
if (SEARCH_INPUT) {
  SEARCH_INPUT.addEventListener('input', e => {
    state.searchQuery = e.target.value.trim();
    if (SEARCH_CLEAR) SEARCH_CLEAR.hidden = !state.searchQuery;
    updateFilterBadges();
    renderFromState();
  });
  SEARCH_INPUT.addEventListener('search', () => {
    state.searchQuery = '';
    if (SEARCH_CLEAR) SEARCH_CLEAR.hidden = true;
    updateFilterBadges();
    renderFromState();
  });
}
if (SEARCH_CLEAR) {
  SEARCH_CLEAR.addEventListener('click', () => {
    state.searchQuery = '';
    if (SEARCH_INPUT) { SEARCH_INPUT.value = ''; SEARCH_INPUT.focus(); }
    SEARCH_CLEAR.hidden = true;
    updateFilterBadges();
    renderFromState();
  });
}
// Promoter / curator pill — delegated to LIST_EL because cards are built via innerHTML.
LIST_EL.addEventListener('click', e => {
  const link = e.target.closest('[data-profile-kind][data-profile-id]');
  if (!link) return;
  e.stopPropagation();
  e.preventDefault();
  openProfileSheet(link.dataset.profileKind, Number(link.dataset.profileId));
});

/* ============================================================
   CARD FLIP — attachCardFlip (card-modal.js) delegates the flip on
   LIST_EL, shared with the same delegation pattern used inside the
   modal. Feed cards have no dismiss button — nothing to close, you
   just scroll away.
   ============================================================ */
attachCardFlip(LIST_EL);

window.addEventListener('scroll', () => {
  TOOLBAR_EL.classList.toggle('is-scrolled', window.scrollY > 12);
  if (!STATIC_REFRACT) scheduleRefractUpdate();
}, { passive: true });
if (!STATIC_REFRACT) window.addEventListener('resize', scheduleRefractUpdate, { passive: true });

// Initialise the WebGL holographic shader before kicking off the data fetch.
// Returns false if WebGL is unavailable; refreshRefractionRefs() will then
// call HoloShader.refresh() as a no-op and the CSS fallback stays visible.
if (window.HoloShader) window.HoloShader.init();

// Last-resort guard: if init() rejects before its own finally runs, the page
// must still not sit behind an invisible header on a blank wash.
init().catch(err => {
  console.error('[Scene] init failed:', err);
  revealHeader();
});
