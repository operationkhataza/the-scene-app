/* ============================================================
   THE SCENE — EXHIBITIONS FEED
   ────────────────────────────────────────────────────────────
   Sibling to the gig guide: a flat list of art + museum exhibitions
   ON NOW (start_date <= today <= end_date, status=published), sorted
   closing-soonest-first so shows about to end rise to the top.

   Deliberately simpler than app.js:
     • No day-strips (exhibitions run over a range, not one night)
     • No curator tiers / holo shader / promoter pills / featured carousel
     • Filters are Type (exhibition_type) + Area (venue.location); no price
     • Cards reuse the .gig-card structure + flip (front = summary,
       back = full description), so all the card CSS applies unchanged.

   The card links out to the exhibition's own website, falling back to
   the venue website (opening hours etc.). Data comes from the shared
   fetchExhibitions() in api.js — the same call the map uses.
   ============================================================ */

/* Native-webview zoom lock — identical contract to app.js. */
document.addEventListener('gesturestart',  e => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', e => e.preventDefault(), { passive: false });
document.addEventListener('gestureend',    e => e.preventDefault(), { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', e => {
  const now = Date.now();
  if (now - lastTouchEnd < 350) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

import { fetchExhibitions } from './api.js';
import { esc, isoDate, imgUrl } from './utils.js';
import { ICONS } from './icons.js';

/* DOM */
const LIST_EL      = document.getElementById('exhibition-list');
const CLEAR_EL     = document.getElementById('toolbar-clear');
const TOOLBAR_EL   = document.getElementById('toolbar');
const BTN_TYPE     = document.getElementById('btn-type');
const BTN_AREA     = document.getElementById('btn-area');
const BADGE_TYPE   = document.getElementById('badge-type');
const BADGE_AREA   = document.getElementById('badge-area');
const SHEET        = document.getElementById('sheet');
const SHEET_BD     = document.getElementById('sheet-backdrop');
const SHEET_TITLE  = document.getElementById('sheet-title');
const SHEET_BODY   = document.getElementById('sheet-body');
const SHEET_CLOSE  = document.getElementById('sheet-close');
const SHEET_CLEAR  = document.getElementById('sheet-clear');
const SHEET_APPLY  = document.getElementById('sheet-apply');
const SEARCH_INPUT = document.getElementById('gig-search');
const SEARCH_CLEAR = document.getElementById('search-clear');

/* ============================================================
   STATE
   ============================================================ */
const state = {
  all:           [],
  typeOptions:   [],
  areaOptions:   [],
  selectedTypes: new Set(),
  selectedAreas: new Set(),
  searchQuery:   '',
  currentSheet:  null,      // 'type' | 'area' | null
  sheetDraft:    new Set(),
};

/* ============================================================
   LABELS + CONSTANTS
   ============================================================ */
const EXHIBITION_TYPE_LABELS = {
  'painting':     'Painting',
  'sculpture':    'Sculpture',
  'photography':  'Photography',
  'mixed-media':  'Mixed Media',
  'installation': 'Installation',
  'group-show':   'Group Show',
  'heritage':     'Heritage',
};

const AREA_LABELS = {
  'cbd':                'CBD',
  'southern-suburbs':   'Southern Suburbs',
  'northern-suburbs':   'Northern Suburbs',
  'atlantic-seaboard':  'Atlantic Seaboard',
  'southern-peninsula': 'Southern Peninsula',
  'cape-flats':         'Cape Flats',
};
// Full area list (same slugs/order as the gig guide) so the Area sheet reads consistently.
const AREA_ORDER = ['cbd', 'southern-suburbs', 'northern-suburbs', 'atlantic-seaboard', 'southern-peninsula', 'cape-flats'];

function typeLabel(slug) {
  return EXHIBITION_TYPE_LABELS[slug] || String(slug || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/* A pending (unapproved) venue must not have its name — or coordinates — shown
   publicly. Whole-object blank, same rule as app.js/map.js publicVenue. */
function publicVenue(venue) {
  return (venue && typeof venue === 'object' && venue.status && venue.status !== 'published')
    ? null
    : venue;
}

/* ============================================================
   DATE FORMATTING
   ────────────────────────────────────────────────────────────
   Range: "12 Jul - 3 Aug" (spanning months) or "12 - 28 Jul"
   (same month), matching the gig guide's fmtRunDates house style.
   Closing hint: urgency for the tail of the run.
   ============================================================ */
function fmtDateRange(start, end) {
  const opts = { day: 'numeric', month: 'short' };
  const d0 = new Date(start + 'T00:00:00');
  const d1 = new Date(end + 'T00:00:00');
  if (start === end) return d0.toLocaleDateString('en-ZA', opts);
  const sameMonth = d0.getMonth() === d1.getMonth() && d0.getFullYear() === d1.getFullYear();
  return sameMonth
    ? `${d0.getDate()} - ${d1.toLocaleDateString('en-ZA', opts)}`
    : `${d0.toLocaleDateString('en-ZA', opts)} - ${d1.toLocaleDateString('en-ZA', opts)}`;
}

function fmtClosing(end) {
  const d = new Date(end + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  if (days <= 0)  return 'Last day';
  if (days === 1) return 'Ends tomorrow';
  if (days <= 7)  return `${days} days left`;
  return 'On until ' + d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}
// A closing hint counts as "urgent" (accent styling) only inside the final week.
function isClosingSoon(end) {
  const d = new Date(end + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000) <= 7;
}

/* ============================================================
   FILTER OPTIONS + APPLICATION
   ============================================================ */
function exhibitionAreaSlug(ex) {
  return ex.venue?.location || null;
}

function computeFilterOptions() {
  const typeCounts = new Map();
  const areaCounts = new Map();
  state.all.forEach(ex => {
    if (ex.exhibition_type) typeCounts.set(ex.exhibition_type, (typeCounts.get(ex.exhibition_type) || 0) + 1);
    const a = exhibitionAreaSlug(ex);
    if (a) areaCounts.set(a, (areaCounts.get(a) || 0) + 1);
  });

  state.typeOptions = [...typeCounts.keys()]
    .map(slug => ({ slug, name: typeLabel(slug), count: typeCounts.get(slug) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  state.areaOptions = AREA_ORDER
    .filter(slug => areaCounts.has(slug))
    .map(slug => ({ slug, name: AREA_LABELS[slug] || slug, count: areaCounts.get(slug) }));
}

function applyFilters(list) {
  return list.filter(ex => {
    if (state.selectedTypes.size > 0) {
      if (!ex.exhibition_type || !state.selectedTypes.has(ex.exhibition_type)) return false;
    }
    if (state.selectedAreas.size > 0) {
      const a = exhibitionAreaSlug(ex);
      if (!a || !state.selectedAreas.has(a)) return false;
    }
    if (state.searchQuery) {
      if (!(ex.title || '').toLowerCase().includes(state.searchQuery.toLowerCase())) return false;
    }
    return true;
  });
}

function updateFilterBadges() {
  const t = state.selectedTypes.size;
  const a = state.selectedAreas.size;
  BADGE_TYPE.hidden = t === 0; BADGE_TYPE.textContent = t;
  BTN_TYPE.classList.toggle('is-active', t > 0);
  BADGE_AREA.hidden = a === 0; BADGE_AREA.textContent = a;
  BTN_AREA.classList.toggle('is-active', a > 0);
  if (CLEAR_EL) CLEAR_EL.hidden = !(t > 0 || a > 0 || !!state.searchQuery);
}

/* ============================================================
   FILTER SHEET (Type / Area)
   ============================================================ */
function openSheet(kind) {
  state.currentSheet = kind;
  const selected = kind === 'type' ? state.selectedTypes : state.selectedAreas;
  state.sheetDraft = new Set(selected);
  SHEET_TITLE.textContent = kind === 'type' ? 'Filter by type' : 'Filter by area';
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
}

function renderSheetOptions() {
  const options = state.currentSheet === 'type' ? state.typeOptions : state.areaOptions;
  if (!options || options.length === 0) {
    SHEET_BODY.innerHTML = `
      <div class="state" style="padding: 2rem 1rem;">
        <p class="state__text">No ${state.currentSheet} options for what's on right now.</p>
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
      </div>`;
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

function applySheet() {
  if (state.currentSheet === 'type') state.selectedTypes = new Set(state.sheetDraft);
  if (state.currentSheet === 'area') state.selectedAreas = new Set(state.sheetDraft);
  updateFilterBadges();
  renderFromState();
  closeSheet();
}

function clearSheet() {
  state.sheetDraft = new Set();
  renderSheetOptions();
}

/* ============================================================
   CARD — reuses the .gig-card shell + flip. Front = poster, date
   range, title, venue, summary, type/closing/tags, entry + Visit.
   Back = full description + Visit CTA.
   ============================================================ */
function entryMarkup(ex) {
  if (ex.is_free) {
    return `<div class="price price--free"><span class="price__prefix">Entry</span><span class="price__value">Free</span></div>`;
  }
  if (ex.entry_info) {
    return `<div class="price"><span class="price__prefix">Entry</span><span class="price__value">${esc(ex.entry_info)}</span></div>`;
  }
  return '';
}

function renderCard(ex, index) {
  const posterSrc = imgUrl(ex.poster, { width: '800', fit: 'contain' });
  const poster = posterSrc
    ? `<img class="gig-card__poster" src="${posterSrc}" alt="${esc(ex.title)} poster" loading="lazy">`
    : `<div class="gig-card__poster-placeholder">The Scene</div>`;

  const range   = fmtDateRange(ex.start_date, ex.end_date);
  const closing = fmtClosing(ex.end_date);
  const soon    = isClosingSoon(ex.end_date);

  const areaName = ex.venue?.location ? (AREA_LABELS[ex.venue.location] || ex.venue.location) : null;
  const venueHtml = ex.venue?.name
    ? `<p class="gig-card__venue"><span class="gig-card__venue-name">${esc(ex.venue.name)}</span>${areaName ? `<span class="gig-card__venue-area">${esc(areaName)}</span>` : ''}</p>`
    : '';

  const descHtml = ex.short_description
    ? `<p class="gig-card__desc">${esc(ex.short_description)}</p>`
    : '';

  const typeName = ex.exhibition_type ? typeLabel(ex.exhibition_type) : null;
  const freeform = Array.isArray(ex.tags) ? ex.tags : [];
  const tagsHtml = (typeName || freeform.length > 0)
    ? `<div class="gig-card__tags">
        ${typeName ? `<span class="tag">${esc(typeName)}</span>` : ''}
        ${freeform.map(t => `<span class="tag tag--neutral">${esc(t)}</span>`).join('')}
      </div>`
    : '';

  const visitUrl  = ex.website || ex.venue?.website || '';
  const visitPill = visitUrl
    ? `<a class="gig-card__ticket-pill" href="${esc(visitUrl)}" target="_blank" rel="noopener noreferrer">Visit ↗</a>`
    : '';

  const frontFooter = `
    <div class="gig-card__footer">
      <div class="gig-card__footer-row">
        ${entryMarkup(ex)}
        ${visitPill}
      </div>
      ${ex.description ? `<button type="button" class="gig-card__read-more">Read more →</button>` : ''}
    </div>`;

  const backDesc = ex.description
    ? `<div class="gig-card__back-desc">${esc(ex.description)}</div>`
    : `<div class="gig-card__back-desc gig-card__back-desc--empty">No description added yet.</div>`;

  const backMetaParts = [range];
  if (ex.is_free) backMetaParts.push('Free entry');
  else if (ex.entry_info) backMetaParts.push(ex.entry_info);

  const backCta = visitUrl
    ? `<a class="gig-card__back-cta" href="${esc(visitUrl)}" target="_blank" rel="noopener noreferrer">Visit website →</a>`
    : '';

  const delay = Math.min(index, 8) * 40;

  return `
    <div class="exh-card gig-card" style="animation-delay: ${delay}ms;">
      <div class="gig-card__inner">

        <div class="gig-card__front">
          ${poster}
          <div class="gig-card__body">
            <div class="gig-card__meta">
              <span>${esc(range)}</span>
              <span class="exh-card__closing${soon ? ' exh-card__closing--soon' : ''}">${esc(closing)}</span>
            </div>
            <h2 class="gig-card__title">${esc(ex.title)}</h2>
            ${venueHtml}
            ${descHtml}
            ${tagsHtml}
            ${frontFooter}
          </div>
        </div>

        <div class="gig-card__back">
          <button type="button" class="gig-card__close" aria-label="Close">${ICONS.x}</button>
          <h3 class="gig-card__back-title">${esc(ex.title)}</h3>
          <div class="gig-card__back-divider"></div>
          ${backDesc}
          <div class="gig-card__back-meta">${esc(backMetaParts.join(' · '))}</div>
          ${backCta}
        </div>

      </div>
    </div>`;
}

/* ============================================================
   RENDER
   ============================================================ */
function renderList(list) {
  const anyFilter = state.selectedTypes.size + state.selectedAreas.size > 0 || !!state.searchQuery;

  if (!list.length) {
    LIST_EL.innerHTML = `
      <div class="state">
        <h2 class="state__title">${anyFilter ? 'Nothing matches' : 'No exhibitions on right now'}</h2>
        <p class="state__text">${anyFilter
          ? 'Try adjusting your search or clearing a filter.'
          : "Nothing showing at the moment. Check back soon — new exhibitions open every week."}</p>
        ${anyFilter ? '<button class="state__action" id="state-clear" type="button">Clear all</button>' : ''}
      </div>`;
    const sc = document.getElementById('state-clear');
    if (sc) sc.addEventListener('click', clearAllFilters);
    return;
  }

  LIST_EL.innerHTML = list.map((ex, i) => renderCard(ex, i)).join('');
}

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
  LIST_EL.innerHTML = card.repeat(4);
}

function renderError() {
  LIST_EL.innerHTML = `
    <div class="state">
      <h2 class="state__title">Couldn't load exhibitions</h2>
      <p class="state__text">Something went wrong reaching The Scene's server. Please refresh the page.</p>
    </div>`;
}

function renderFromState() {
  renderList(applyFilters(state.all));
}

function clearAllFilters() {
  state.selectedTypes = new Set();
  state.selectedAreas = new Set();
  state.searchQuery = '';
  if (SEARCH_INPUT) SEARCH_INPUT.value = '';
  if (SEARCH_CLEAR) SEARCH_CLEAR.hidden = true;
  updateFilterBadges();
  renderFromState();
}

/* ============================================================
   WIRING
   ============================================================ */
BTN_TYPE.addEventListener('click', () => openSheet('type'));
BTN_AREA.addEventListener('click', () => openSheet('area'));
SHEET_CLOSE.addEventListener('click', closeSheet);
SHEET_BD.addEventListener('click', closeSheet);
SHEET_CLEAR.addEventListener('click', clearSheet);
SHEET_APPLY.addEventListener('click', applySheet);
if (CLEAR_EL) CLEAR_EL.addEventListener('click', clearAllFilters);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.currentSheet) closeSheet(); });

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

// Card flip — front face is the click target; the Visit pill + back CTA pass through.
LIST_EL.addEventListener('click', e => {
  if (e.target.closest('.gig-card__ticket-pill')) return;
  if (e.target.closest('.gig-card__back-cta'))    return;

  const closeBtn = e.target.closest('.gig-card__close');
  if (closeBtn) {
    closeBtn.closest('.gig-card__inner').classList.remove('is-flipped');
    return;
  }
  const inner = e.target.closest('.gig-card__inner');
  if (!inner || inner.classList.contains('is-flipped')) return;
  // Only flip if there's a back to show.
  if (inner.querySelector('.gig-card__back-desc:not(.gig-card__back-desc--empty)') || inner.querySelector('.gig-card__back-cta')) {
    inner.classList.add('is-flipped');
  }
});

window.addEventListener('scroll', () => {
  TOOLBAR_EL.classList.toggle('is-scrolled', window.scrollY > 12);
}, { passive: true });

/* ============================================================
   BOOT
   ============================================================ */
async function init() {
  const headerDateEl = document.getElementById('gigs-header-date');
  if (headerDateEl) {
    const today = new Date();
    headerDateEl.textContent = today.toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  renderSkeleton();

  try {
    const list = (await fetchExhibitions({ onDate: isoDate(new Date()) }))
      .map(ex => { ex.venue = publicVenue(ex.venue); return ex; });
    state.all = list;
    computeFilterOptions();
    renderFromState();
    console.log('[Scene] exhibitions loaded:', list.length);
  } catch (err) {
    console.error('[Scene] failed to load exhibitions:', err);
    renderError();
  }
}

init();
