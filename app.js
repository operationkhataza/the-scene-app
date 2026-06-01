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

const API = 'https://api.thescenecapetown.co.za';

// Dev preview: ?holo=test forces every event card into the holographic tier
// so the WebGL shader is visible regardless of curator count in Directus.
// Remove the query param to restore real curator-based tier assignment.
const TEST_HOLO = new URLSearchParams(window.location.search).get('holo') === 'test';

const LIST_EL      = document.getElementById('gig-list');
const TOOLBAR_EL   = document.getElementById('toolbar');
const COUNT_EL     = document.getElementById('toolbar-count');
const CLEAR_EL     = document.getElementById('toolbar-clear');
const BTN_TYPE     = document.getElementById('btn-type');
const BTN_AREA     = document.getElementById('btn-area');
const BTN_PRICE    = document.getElementById('btn-price');
const BADGE_TYPE   = document.getElementById('badge-type');
const BADGE_AREA   = document.getElementById('badge-area');
const BADGE_PRICE  = document.getElementById('badge-price');
const SHEET        = document.getElementById('sheet');
const SHEET_BD     = document.getElementById('sheet-backdrop');
const SHEET_TITLE  = document.getElementById('sheet-title');
const SHEET_BODY   = document.getElementById('sheet-body');
const SHEET_CLOSE  = document.getElementById('sheet-close');
const SHEET_CLEAR  = document.getElementById('sheet-clear');
const SHEET_APPLY  = document.getElementById('sheet-apply');

/* ============================================================
   STATE
   ============================================================ */

// Price slider — continuous value from 0 (Free) to PRICE_MAX (300+) in PRICE_STEP increments.
// Shows all events priced at or below the selected value. Null means no price filter active.
const PRICE_MIN = 0;
const PRICE_MAX = 300;
const PRICE_STEP = 50;
const PRICE_TICK_VALUES = [0, 50, 100, 150, 200, 250, 300]; // for tick labels under the slider

const state = {
  allGigs: [],
  categories: [],
  areas: [],
  typeOptions: [],
  areaOptions: [],
  selectedTypes: new Set(),
  selectedAreas: new Set(),
  selectedPriceMax: null,  // null = no filter; number = show gigs priced ≤ this value
  searchQuery: '',         // name search string
  currentSheet: null,      // 'type' | 'area' | 'price' | null
  activeSheetContent: null, // 'filter' | 'promoter' | null
  sheetDraft: new Set(),   // working copy while sheet open (type/area)
  sheetDraftPrice: null,   // working copy while price sheet open
};

/* ============================================================
   URL / QUERY STATE
   ============================================================ */
function getParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

/* ============================================================
   DATE HELPERS
   ============================================================ */
function isoDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function formatCardDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
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
function dateForDayName(dayName) {
  const map = {sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6};
  const target = map[dayName.toLowerCase()];
  if (target === undefined) return null;
  const today = new Date();
  let daysAhead = target - today.getDay();
  if (daysAhead < 0) daysAhead += 7;
  return addDays(today, daysAhead);
}

/* ============================================================
   HELPERS
   ============================================================ */
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
function slugify(str) {
  return String(str || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

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
   Directus can return event_category in multiple shapes depending
   on how the collection is set up (M2O, M2M) and what fields are
   requested. We handle all of them and resolve to {slug, name}
   by looking up IDs against state.categories (loaded separately).
   ============================================================ */

function gigCategoryRefs(gig) {
  const raw = gig.event_category;
  if (raw == null) return [];

  // Normalise to an array so we can map uniformly
  const items = Array.isArray(raw) ? raw : [raw];

  return items.map(item => {
    if (item == null) return null;

    // Case: M2M junction row { event_category_id: { slug, name, id } }
    if (typeof item === 'object' && item.event_category_id) {
      const nested = item.event_category_id;
      if (typeof nested === 'object' && nested.slug) {
        return { slug: nested.slug, name: nested.name };
      }
      if (typeof nested === 'number' || typeof nested === 'string') {
        return lookupCategory(nested);
      }
    }

    // Case: expanded M2O { slug, name, id }
    if (typeof item === 'object' && item.slug) {
      return { slug: item.slug, name: item.name };
    }

    // Case: scalar FK (number or string) — most common here
    if (typeof item === 'number' || typeof item === 'string') {
      return lookupCategory(item);
    }

    return null;
  }).filter(Boolean);
}

function lookupCategory(id) {
  // IDs from Directus can arrive as number or string; normalise on both sides
  const n = Number(id);
  const cat = state.categories.find(c => Number(c.id) === n);
  return cat ? { slug: cat.slug, name: cat.name } : null;
}

function gigCategorySlugs(gig) {
  return gigCategoryRefs(gig).map(r => r.slug);
}

function gigCategoryNames(gig) {
  return gigCategoryRefs(gig).map(r => r.name);
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

  state.allGigs.forEach(gig => {
    gigCategorySlugs(gig).forEach(slug => {
      typeCounts.set(slug, (typeCounts.get(slug) || 0) + 1);
    });
    const areaSlug = gigAreaSlug(gig);
    if (areaSlug) {
      areaCounts.set(areaSlug, (areaCounts.get(areaSlug) || 0) + 1);
    }
  });

  state.typeOptions = state.categories
    .filter(cat => typeCounts.has(cat.slug))
    .map(cat => ({ slug: cat.slug, name: cat.name, count: typeCounts.get(cat.slug) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  state.areaOptions = state.areas
    .filter(a => areaCounts.has(a.slug))
    .map(a => ({ slug: a.slug, name: a.name, count: areaCounts.get(a.slug) }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
  const priceActive = state.selectedPriceMax !== null;
  BADGE_TYPE.hidden = t === 0;
  BADGE_TYPE.textContent = t;
  BTN_TYPE.classList.toggle('is-active', t > 0);
  BADGE_AREA.hidden = a === 0;
  BADGE_AREA.textContent = a;
  BTN_AREA.classList.toggle('is-active', a > 0);
  BADGE_PRICE.hidden = !priceActive;
  // Show the chosen ceiling on the button badge (e.g. "200", "300+" as max)
  BADGE_PRICE.textContent = priceActive
    ? (state.selectedPriceMax >= PRICE_MAX ? `${PRICE_MAX}+` : `${state.selectedPriceMax}`)
    : '';
  BTN_PRICE.classList.toggle('is-active', priceActive);

  const anyActive = t > 0 || a > 0 || priceActive || !!state.searchQuery;
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
    const selected = kind === 'type' ? state.selectedTypes : state.selectedAreas;
    state.sheetDraft = new Set(selected);
  }
  SHEET_TITLE.textContent = kind === 'type' ? 'Filter by type'
                          : kind === 'area' ? 'Filter by area'
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
   PROMOTER SHEET — lazy-loaded profile bottom sheet
   ============================================================ */

async function fetchPromoter(id) {
  const res = await fetch(
    `${API}/items/promoters/${id}?fields=id,name,bio,profile_image,website,social_links`
  );
  if (!res.ok) throw new Error(`API ${res.status}`);
  const json = await res.json();
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
  const res = await fetch(`${API}/items/events?${params}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  const json = await res.json();
  return json.data || [];
}

function renderPromoterProfile(promoter, events) {
  // Avatar — image or initial placeholder
  const avatarSrc = promoter.profile_image
    ? imgUrl(promoter.profile_image, { width: '120', height: '120', fit: 'cover' })
    : null;
  const avatarHtml = avatarSrc
    ? `<img class="promoter-sheet__avatar" src="${avatarSrc}" alt="${esc(promoter.name)} logo">`
    : `<div class="promoter-sheet__avatar promoter-sheet__avatar--placeholder">${esc(promoter.name.charAt(0).toUpperCase())}</div>`;

  const bioHtml = promoter.bio
    ? `<p class="promoter-sheet__bio">${esc(promoter.bio)}</p>`
    : '';

  const websiteHtml = promoter.website
    ? `<a class="promoter-sheet__website" href="${esc(promoter.website)}" target="_blank" rel="noopener noreferrer">Visit website ↗</a>`
    : '';

  // social_links uses capitalised Directus field keys: Platforms + URL
  // Map stored values back to display labels (stored as lowercase slugs)
  const PLATFORM_LABELS = {
    instagram: 'Instagram', facebook: 'Facebook',
    x: 'X', youtube: 'YouTube', tiktok: 'TikTok',
    soundcloud: 'SoundCloud', spotify: 'Spotify', bandcamp: 'Bandcamp'
  };
  const socials = Array.isArray(promoter.social_links) ? promoter.social_links : [];
  const socialHtml = socials.length > 0
    ? `<div class="promoter-sheet__socials">
        ${socials.map(s => {
          const rawPlatform = s.Platforms || s.platform || '';
          const url         = s.URL      || s.url      || '';
          if (!url) return '';
          const label = PLATFORM_LABELS[rawPlatform.toLowerCase()]
            || (rawPlatform.charAt(0).toUpperCase() + rawPlatform.slice(1))
            || url;
          return `<a class="promoter-sheet__social-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
        }).filter(Boolean).join('')}
      </div>`
    : '';

  // Upcoming events list — each item is a thumbnail + text row
  const eventsHtml = events.length > 0
    ? `<div class="promoter-sheet__events">
        <p class="promoter-sheet__events-title">Upcoming Events</p>
        <ul class="promoter-sheet__event-list">
          ${events.map(ev => {
            const timeStr  = formatTime(ev.doors_time);
            const meta     = [formatCardDate(ev.date), timeStr, ev.venue?.name].filter(Boolean).join(' · ');
            const thumbSrc = ev.poster ? imgUrl(ev.poster, { width: '144', fit: 'contain' }) : null;
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

async function openPromoterSheet(promoterId) {
  state.activeSheetContent = 'promoter';
  SHEET.setAttribute('data-mode', 'promoter');

  // Open immediately with skeleton so the sheet feels instant
  SHEET_TITLE.textContent = 'Loading…';
  SHEET_BODY.innerHTML    = `<div class="promoter-sheet__loading"><div class="spinner"></div></div>`;
  SHEET.classList.add('is-open');
  SHEET_BD.classList.add('is-open');
  document.body.style.overflow = 'hidden';

  // Tier 1 — promoter metadata (fatal: nothing to show without this)
  let promoter;
  try {
    promoter = await fetchPromoter(promoterId);
  } catch (err) {
    console.error('[Scene] fetchPromoter failed:', err);
    SHEET_BODY.innerHTML    = `<div class="state" style="padding: 2rem 1rem;"><p class="state__text">Couldn't load promoter details.</p></div>`;
    SHEET_TITLE.textContent = 'Promoter';
    return;
  }

  SHEET_TITLE.textContent = promoter.name;

  // Tier 2 — upcoming events (non-fatal: sheet still renders without them)
  let events = [];
  try {
    events = await fetchPromoterEvents(promoterId);
  } catch (err) {
    console.warn('[Scene] fetchPromoterEvents failed — rendering without events list:', err);
  }

  SHEET_BODY.innerHTML = renderPromoterProfile(promoter, events);
}

function renderSheetOptions() {
  if (state.currentSheet === 'price') {
    renderPriceSlider();
    return;
  }

  const options = state.currentSheet === 'type' ? state.typeOptions : state.areaOptions;

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

   resolveGig() runs once at ingestion so every downstream consumer
   (filters, search, sort, day-grouping, renderCard) sees one uniform
   shape. Parent wins for production fields; the child keeps its own
   id/date/time/status/category and curators/promoters (curation is
   per-night, exactly like a gig). Ordinary gigs pass through untouched.
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
    _isRun: true,   // marker for any run-aware UI later (e.g. a "multi-night" hint)
  };
}

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
    'event_category',       // works for M2O (scalar) or M2M (array); accessor handles both
    'artists.artists_id.name',
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
    'parent_run.venue.location'
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
   LOAD TAXONOMIES — categories (always) and areas (if present)
   These populate the filter UI. Both are fetched separately
   from the events call so the filter shows ALL options from
   Directus, not just options that happen to appear in the
   current date range.
   ============================================================ */
async function loadCategories() {
  try {
    const res = await fetch(`${API}/items/event_category?fields=id,name,slug&sort=name`);
    if (!res.ok) return [];
    const json = await res.json();
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
   LOAD CURATOR — fetches name (and future: logo, bio, theme)
   for curator-mode views (?curator=slug)
   ============================================================ */
async function loadCurator(slug) {
  try {
    const res = await fetch(`${API}/items/curators?filter[slug][_eq]=${encodeURIComponent(slug)}&fields=id,name,slug&limit=1`);
    if (!res.ok) return null;
    const json = await res.json();
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
    const res = await fetch(`${API}/items/promoters?filter[slug][_eq]=${encodeURIComponent(slug)}&fields=id,name,slug,profile_image&limit=1`);
    if (!res.ok) return null;
    const json = await res.json();
    return json.data?.[0] || null;
  } catch (err) {
    console.warn('[Scene] Could not load promoter:', err);
    return null;
  }
}

/* ============================================================
   PRICE
   ============================================================ */
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
      const low = Math.min(...prices);
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
   CARD
   ============================================================ */
function renderCard(gig, index) {
  const posterSrc = imgUrl(gig.poster, { width: '800', fit: 'contain' });
  const poster = posterSrc
    ? `<img class="gig-card__poster" src="${posterSrc}" alt="${esc(gig.title)} poster" loading="lazy">`
    : `<div class="gig-card__poster-placeholder">The Scene</div>`;

  // Meta line: DATE · DOORS TIME
  const metaParts = [formatCardDate(gig.date)];
  const timeStr = formatTime(gig.doors_time);
  if (timeStr) metaParts.push(timeStr);
  const metaStr = metaParts.join(' · ');

  // Venue + area — venue.area is a flat dropdown slug; map to display label for the card
  const AREA_LABELS = {
    'southern-suburbs':   'Southern Suburbs',
    'northern-suburbs':   'Northern Suburbs',
    'southern-peninsula': 'Southern Peninsula',
    'cbd':                'CBD',
    'cape-flats':         'Cape Flats',
    'atlantic-seaboard':  'Atlantic Seaboard',
  };
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

  // Tags: event categories (teal) + freeform tags + age restriction (neutral)
  const categoryNames = gigCategoryNames(gig);
  const freeformTags = Array.isArray(gig.tags) ? gig.tags : [];
  const ageTag = gig.age_restriction && gig.age_restriction !== 'all-ages'
    ? [gig.age_restriction.replace(/-/g, ' ')]
    : [];
  const allNeutral = [...freeformTags, ...ageTag];
  const tagsHtml = (categoryNames.length > 0 || allNeutral.length > 0)
    ? `<div class="gig-card__tags">
        ${categoryNames.map(c => `<span class="tag">${esc(c)}</span>`).join('')}
        ${allNeutral.map(t => `<span class="tag tag--neutral">${esc(t)}</span>`).join('')}
      </div>`
    : '';

  // Curators — count determines card treatment (1=silver, 2=gold, 3+=holographic)
  const curators = (gig.curators || []).map(c => c.curators_id).filter(Boolean);
  const curatedLevel = TEST_HOLO ? 3
                     : curators.length >= 3 ? 3
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

  // Promoter — clickable pill badges, mirroring curator badge logic
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
          return `<span class="gig-card__promoter-link" data-promoter-id="${p.id}">${logoEl}${esc(p.name)}</span>`;
        }).join(', ')
      }</p>`
    : '';

  const hasTickets = !!gig.ticket_url;
  const ticketUrl  = hasTickets ? esc(gig.ticket_url) : '';

  // ── Front face footer: price + subtle ticket pill + "Read more →" ──
  const frontFooter = `
    <div class="gig-card__footer">
      <div class="gig-card__footer-row">
        ${priceMarkup(gig)}
        ${hasTickets ? `<a class="gig-card__ticket-pill" href="${ticketUrl}" target="_blank" rel="noopener noreferrer">Tickets ↗</a>` : ''}
      </div>
      <button type="button" class="gig-card__read-more">Read more →</button>
    </div>`;

  // ── Back face: full description (plain text, pre-wrap) ──
  const backDesc = gig.description
    ? `<div class="gig-card__back-desc">${esc(gig.description)}</div>`
    : `<div class="gig-card__back-desc gig-card__back-desc--empty">No description added yet.</div>`;

  // Back face meta row: date · time [· price summary]
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
  const delay = Math.min(index, 8) * 40;

  return `
    <div class="gig-card"${curatedAttr} style="animation-delay: ${delay}ms;">
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

/* ============================================================
   RENDER LIST
   ────────────────────────────────────────────────────────────
   Weekly view  → one horizontal swipe strip per day (today first,
                  rolling 7-day window). Empty days hidden.
   Single-day   → full-width vertical list of that day's gigs.

   Curation level (1/2/3+) drives the holographic shader on each
   card via data-curated — it does NOT affect card position.
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

/* Returns curation tier priority — higher = appears first.
   3+ curators → 3 (rainbow holo), 2 → 2 (gold), 1 → 1 (silver), uncurated → 0
   Matches exactly the curatedLevel logic in renderCard. */
function curatorTier(gig) {
  const curators = (gig.curators || []).map(c => c.curators_id).filter(Boolean);
  const n = curators.length;
  return n >= 3 ? 3 : n;
}

/* Sort by curation tier (highest first = rainbow first, then gold, then silver, then normal),
   then chronologically by doors_time within each tier. */
function sortByTime(gigs) {
  return [...gigs].sort((a, b) => {
    const tierDiff = curatorTier(b) - curatorTier(a);
    if (tierDiff !== 0) return tierDiff;
    const ta = a.doors_time || '';
    const tb = b.doors_time || '';
    return ta.localeCompare(tb);
  });
}

/* One horizontal swipe strip for a single day. */
function renderDayStrip(dateStr, gigs) {
  if (!gigs.length) return '';
  const sorted = sortByTime(gigs);
  const label = formatDayLabel(dateStr);
  const count = `${gigs.length} event${gigs.length === 1 ? '' : 's'}`;
  const cards = sorted.map((g, i) => renderCard(g, i)).join('');
  return `
    <div class="day-strip">
      <div class="day-strip__header">
        <span class="day-strip__label">${esc(label)}</span>
        <span class="day-strip__count">${count}</span>
      </div>
      <div class="day-strip__track">${cards}</div>
    </div>`;
}

/* Vertical full-width list for single-day (?day=) view. */
function renderFlatList(gigs) {
  return sortByTime(gigs).map((g, i) => renderCard(g, i)).join('');
}

function renderList(gigs, { groupByDate = false, singleDay = null } = {}) {
  const anyFilters = state.selectedTypes.size + state.selectedAreas.size + (state.selectedPriceMax !== null ? 1 : 0) > 0;
  const anySearch = !!state.searchQuery;

  COUNT_EL.textContent = gigs.length === 0
    ? ''
    : `${gigs.length} ${gigs.length === 1 ? 'event' : 'events'}`;

  if (!gigs.length) {
    const dateHeader = singleDay
      ? `<h2 class="date-header date-header--day-view">${formatLongDate(singleDay)}</h2>`
      : '';
    LIST_EL.innerHTML = dateHeader + `
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
    // ── SINGLE-DAY VIEW — vertical full-width cards ──
    html += `<h2 class="date-header date-header--day-view">${formatLongDate(singleDay)}</h2>`;
    html += renderFlatList(gigs);
  } else {
    // ── WEEKLY VIEW — one horizontal strip per day ──
    // Group by date, then render in date order (Directus returns date-sorted
    // already, so Object.keys().sort() preserves the rolling 7-day order).
    const grouped = gigs.reduce((acc, gig) => {
      (acc[gig.date] = acc[gig.date] || []).push(gig);
      return acc;
    }, {});
    Object.keys(grouped).sort().forEach(date => {
      html += renderDayStrip(date, grouped[date]);
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
   RENDER FROM STATE — reruns filter + render without refetching
   ============================================================ */
let renderOptions = { groupByDate: true, singleDay: null };

function renderFromState() {
  const filtered = applyFilters(state.allGigs);
  renderList(filtered, renderOptions);
}

function clearAllFilters() {
  state.selectedTypes = new Set();
  state.selectedAreas = new Set();
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
  const cards = document.querySelectorAll('.gig-card[data-curated]');
  cards.forEach(c => holoObserver.observe(c));
  if (window.HoloShader) window.HoloShader.refresh();


}

// Keep old no-op for any stale callers
let refractionCards = [];
function updateRefraction() { /* replaced by scheduleRefractUpdate */ }

/* ============================================================
   ROUTING & INIT
   ============================================================ */
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

  // ── PROMOTER MODE — 30-day window ──
  // Override whatever the default date range was: show the next 30 days so
  // visitors can see the promoter's full upcoming schedule at a glance.
  if (promoterSlug) {
    fromDate = isoDate(today);
    toDate   = isoDate(addDays(today, 29));
    renderOptions = { groupByDate: true, singleDay: null };
  }

  // ── CURATOR MODE ──
  // If ?curator=slug is present, fetch the curator record and swap the header.
  // Both the toolbar and search bar are hidden — the curator's picks are the filter.
  if (curatorSlug) {
    const toolbarEl = document.getElementById('toolbar');
    const searchEl = document.querySelector('.search-bar');
    if (toolbarEl) toolbarEl.hidden = true;
    if (searchEl) searchEl.hidden = true;
  }

  // ── PROMOTER MODE UI ──
  // Keep the filter toolbar visible (useful over a 30-day window) but hide the
  // search bar — the promoter's name in the header is the primary context.
  if (promoterSlug) {
    const searchEl = document.querySelector('.search-bar');
    if (searchEl) searchEl.hidden = true;
  }

  // ── HEADER DATE ──
  const headerDateEl = document.getElementById('gigs-header-date');
  if (headerDateEl) {
    const dateToShow = headerDate || today;
    const dayName = dateToShow.toLocaleDateString('en-ZA', { weekday: 'long' });
    const dayNum = dateToShow.getDate();
    const month = dateToShow.toLocaleDateString('en-ZA', { month: 'long' });
    headerDateEl.textContent = `${dayName} ${dayNum} ${month}`;
  }

  try {
    // Load curator/promoter metadata in parallel with taxonomies + events.
    // If either fetch fails, we still render the feed — just with a generic header.
    const [categories, areas, gigs, curator, promoter] = await Promise.all([
      loadCategories(),
      loadAreas(),
      fetchEvents({ fromDate, toDate, curatorSlug, promoterSlug }),
      curatorSlug  ? loadCurator(curatorSlug)   : Promise.resolve(null),
      promoterSlug ? loadPromoter(promoterSlug) : Promise.resolve(null),
    ]);
    state.categories = categories;
    state.areas = areas;
    // Normalize theatre nights (parent_run → coalesced fields) once, up front,
    // so filters/search/sort/render all operate on a single uniform shape.
    state.allGigs = gigs.map(resolveGig);

    // ── CURATOR HEADER ──
    if (curatorSlug) {
      const titleEl = document.getElementById('gigs-header-title');
      const subtitleEl = document.getElementById('gigs-header-subtitle');
      const curatorBylineEl = document.getElementById('gigs-header-curator-byline');
      if (titleEl) titleEl.textContent = curator?.name || 'Curator Picks';
      if (subtitleEl) subtitleEl.textContent = 'Curated picks';
      if (curatorBylineEl) { curatorBylineEl.hidden = false; curatorBylineEl.textContent = ''; }
    }

    // ── PROMOTER HEADER ──
    if (promoterSlug) {
      const titleEl    = document.getElementById('gigs-header-title');
      const subtitleEl = document.getElementById('gigs-header-subtitle');
      const avatarEl   = document.getElementById('gigs-header-promoter-avatar');
      if (titleEl)    titleEl.textContent    = promoter?.name || 'Promoter Events';
      if (subtitleEl) subtitleEl.textContent = 'Events';
      if (avatarEl && promoter?.profile_image) {
        avatarEl.src    = imgUrl(promoter.profile_image, { width: '128', height: '128', fit: 'cover' });
        avatarEl.alt    = promoter.name ? `${promoter.name} logo` : '';
        avatarEl.hidden = false;
      }
    }

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
  } catch (err) {
    console.error('Failed to fetch gigs:', err);
    renderError();
  }
}

/* ============================================================
   EVENT WIRING
   ============================================================ */
BTN_TYPE.addEventListener('click', () => openSheet('type'));
BTN_AREA.addEventListener('click', () => openSheet('area'));
BTN_PRICE.addEventListener('click', () => openSheet('price'));
SHEET_CLOSE.addEventListener('click', closeSheet);
SHEET_BD.addEventListener('click', closeSheet);
SHEET_CLEAR.addEventListener('click', clearSheet);
SHEET_APPLY.addEventListener('click', applySheet);

// "Clear all" toolbar button — resets every filter and the search query
if (CLEAR_EL) {
  CLEAR_EL.addEventListener('click', () => {
    state.selectedTypes.clear();
    state.selectedAreas.clear();
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
// Promoter link — delegated to LIST_EL because cards are built via innerHTML.
LIST_EL.addEventListener('click', e => {
  const link = e.target.closest('.gig-card__promoter-link');
  if (!link) return;
  e.stopPropagation();
  e.preventDefault();
  openPromoterSheet(Number(link.dataset.promoterId));
});

/* ============================================================
   CARD FLIP
   ============================================================ */

// Runtime 3D capability test — runs once on page load (~2ms).
// CSS @supports catches browsers with no 3D support; this catches browsers
// that report support but render it incorrectly (known WKWebView failure mode).
// Flip a card to front or back.
// inner = .gig-card__inner element; toBack = true → show back, false → show front.
function flipCard(inner, toBack) {
  inner.classList.toggle('is-flipped', toBack);
}

// Flip delegation — entire front face is the click target.
// Exemptions: ticket pill, back-face CTA, and promoter link all pass through.
// Tapping the ✕ close button on the back face flips to front.
// Any other tap while the back face is showing does nothing (lets content be readable).
LIST_EL.addEventListener('click', e => {
  if (e.target.closest('.gig-card__ticket-pill'))   return;
  if (e.target.closest('.gig-card__back-cta'))      return;
  if (e.target.closest('.gig-card__promoter-link')) return;

  const closeBtn = e.target.closest('.gig-card__close');
  if (closeBtn) {
    flipCard(closeBtn.closest('.gig-card__inner'), false);
    return;
  }

  const inner = e.target.closest('.gig-card__inner');
  if (!inner || inner.classList.contains('is-flipped')) return;
  flipCard(inner, true);
});

window.addEventListener('scroll', () => {
  TOOLBAR_EL.classList.toggle('is-scrolled', window.scrollY > 12);
  scheduleRefractUpdate();
}, { passive: true });
window.addEventListener('resize', scheduleRefractUpdate, { passive: true });

// Initialise the WebGL holographic shader before kicking off the data fetch.
// Returns false if WebGL is unavailable; refreshRefractionRefs() will then
// call HoloShader.refresh() as a no-op and the CSS fallback stays visible.
if (window.HoloShader) window.HoloShader.init();

init();
