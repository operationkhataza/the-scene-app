/* ============================================================
   THE SCENE — SHARED GIG-CARD BUILDER (public app)
   ────────────────────────────────────────────────────────────
   The card HTML builder, price markup, and category/genre
   accessors, single-sourced for the gig guide, calendar, and
   map. Previously copy-pasted into app.js (x2), calendar.js and
   map.js and had started to drift (promoter-pill join, the meta
   date guard, how many category chips render) — lifted here so
   behaviour is one source of truth. Pure presentation: no DOM
   refs, no listeners, no fetches.

   Extraction task: ClickUp "Extract shared gig-card modal module
   in Scene App", filed during the map-view build (Jul 2026).
   ============================================================ */

import { esc, imgUrl, formatCardDate, formatTime, gigTier } from './utils.js';
import { ICONS } from './icons.js';

/* venue.area is a flat Dropdown string on the venues collection,
   e.g. "cbd", "southern-suburbs" — mapped to a display label. */
export const AREA_LABELS = {
  'southern-suburbs':   'Southern Suburbs',
  'northern-suburbs':   'Northern Suburbs',
  'southern-peninsula': 'Southern Peninsula',
  'cbd':                'CBD',
  'cape-flats':         'Cape Flats',
  'atlantic-seaboard':  'Atlantic Seaboard',
};

/* ============================================================
   PRICE
   ============================================================ */
export function priceMarkup(gig) {
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

/* Mini version of priceMarkup, for the inline meta line on renderDayCard. */
export function priceLabel(gig) {
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
   CATEGORY ACCESSOR — shape-agnostic
   ────────────────────────────────────────────────────────────
   Directus can return event_category in multiple shapes depending
   on how the collection is set up (M2O, M2M) and what fields are
   requested. We handle all of them. A scalar FK id can only be
   resolved to {slug, name} by looking it up against the caller's
   own loaded category list — pass that lookup in as `lookup`. The
   guide passes its `lookupCategory`; calendar and map don't need
   to, because their fields query already requests the expanded
   object, so a scalar FK never appears on those two surfaces.
   ============================================================ */
export function gigCategoryRefs(gig, lookup = null) {
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
        return lookup ? lookup(nested) : null;
      }
    }

    // Case: expanded M2O { slug, name, id }
    if (typeof item === 'object' && item.slug) {
      return { slug: item.slug, name: item.name };
    }

    // Case: scalar FK (number or string) — needs the caller's lookup
    if (typeof item === 'number' || typeof item === 'string') {
      return lookup ? lookup(item) : null;
    }

    return null;
  }).filter(Boolean);
}

export function gigCategoryNames(gig, lookup = null) {
  return gigCategoryRefs(gig, lookup).map(r => r.name);
}

/* ============================================================
   GENRE ACCESSOR
   ────────────────────────────────────────────────────────────
   Genre is split across two Directus taxonomies — `genre` (M2M →
   genres, live-music vocabulary) and `dj_genres` (M2M → dj_genres,
   DJ vocabulary) — because event_category gates which one a
   submitter is offered. The two lists overlap (Amapiano, Deep
   House, Hip Hop…) and one term (R&B) has different slugs in each
   collection ("rnb" vs "r-and-b") despite an identical name. Slug
   is therefore not a safe merge key — we derive our own key from
   the display name via slugify(), so "R&B" from either taxonomy
   collapses onto the same filter option. Deduping happens per-gig
   here so a card never shows the same genre name twice.
   ============================================================ */
function slugify(str) {
  return String(str || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function gigGenreRefs(gig) {
  const bySlug = new Map();

  const collect = (raw, idKey) => {
    if (!Array.isArray(raw)) return;
    raw.forEach(item => {
      const nested = item && item[idKey];
      if (!nested || typeof nested !== 'object' || !nested.name) return;
      const slug = slugify(nested.name);
      if (!slug || bySlug.has(slug)) return;
      bySlug.set(slug, { slug, name: nested.name });
    });
  };

  collect(gig.genre, 'genres_id');
  collect(gig.dj_genres, 'dj_genres_id');

  return [...bySlug.values()];
}

export function gigGenreNames(gig) {
  return gigGenreRefs(gig).map(r => r.name);
}

/* ============================================================
   CARD — the flippable front/back gig card. Used for the gig
   guide's feed cards, the featured-carousel modal, the calendar
   day-panel modal, and the map's pin/venue-sheet modal.
   ────────────────────────────────────────────────────────────
   opts:
     index          — when present, emits animation-delay (feed only)
     dismiss        — when true, appends the ICONS.x close button (modals only)
     categoryLookup — resolves a scalar event_category FK to {slug,name};
                      omit where the fields query already expands it
     forceTier      — dev preview (?holo=test): force the holo tier
   ============================================================ */
export function renderGigCard(gig, opts = {}) {
  const { index = null, dismiss = false, categoryLookup = null, forceTier = false } = opts;

  const posterSrc = imgUrl(gig.poster, { width: '800', fit: 'contain' });
  const poster = posterSrc
    ? `<img class="gig-card__poster" src="${posterSrc}" alt="${esc(gig.title)} poster" loading="lazy">`
    : `<div class="gig-card__poster-placeholder">The Scene</div>`;

  // Meta line: DATE · DOORS TIME. A featured whole run has no single date/time
  // — show its date range instead.
  let metaStr;
  if (gig._isFeaturedRun) {
    metaStr = gig.dateRange || '';
  } else {
    const metaParts = gig.date ? [formatCardDate(gig.date)] : [];
    const timeStr = formatTime(gig.doors_time);
    if (timeStr) metaParts.push(timeStr);
    metaStr = metaParts.join(' · ');
  }

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

  // Tags: event categories (teal) + genre (outlined) + freeform tags + age restriction (neutral)
  const categoryNames = gigCategoryNames(gig, categoryLookup);
  const genreNames = gigGenreRefs(gig).map(r => r.name);
  const freeformTags = Array.isArray(gig.tags) ? gig.tags : [];
  const ageTag = gig.age_restriction && gig.age_restriction !== 'all-ages'
    ? [gig.age_restriction.replace(/-/g, ' ')]
    : [];
  const allNeutral = [...freeformTags, ...ageTag];
  const tagsHtml = (categoryNames.length > 0 || genreNames.length > 0 || allNeutral.length > 0)
    ? `<div class="gig-card__tags">
        ${categoryNames.map(c => `<span class="tag">${esc(c)}</span>`).join('')}
        ${genreNames.map(g => `<span class="tag tag--genre">${esc(g)}</span>`).join('')}
        ${allNeutral.map(t => `<span class="tag tag--neutral">${esc(t)}</span>`).join('')}
      </div>`
    : '';

  // Curators — count determines card treatment via gigTier (utils.js): 2=silver, 3=gold, 4+=holographic.
  // Each pill carries data-profile-kind/id so it opens the curator profile sheet.
  const curators = (gig.curators || []).map(c => c.curators_id).filter(Boolean);
  const curatedLevel = forceTier ? 3 : gigTier(gig);
  const curatorHtml = curators.length > 0
    ? `<div class="curators">
        <span class="curators__label">Selected by</span>
        ${curators.map(c => {
          const logo = imgUrl(c.logo, { width: '60', height: '60', fit: 'cover' });
          const logoEl = logo
            ? `<img class="entity-pill__logo" src="${logo}" alt="">`
            : `<span class="entity-pill__logo entity-pill__logo--placeholder"></span>`;
          return `<button class="entity-pill" type="button" data-profile-kind="curator" data-profile-id="${c.id}">${logoEl}${esc(c.name)}</button>`;
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
            ? `<img class="entity-pill__logo" src="${logoSrc}" alt="">`
            : `<span class="entity-pill__logo entity-pill__logo--placeholder"></span>`;
          return `<button class="entity-pill" type="button" data-profile-kind="promoter" data-profile-id="${p.id}">${logoEl}${esc(p.name)}</button>`;
        }).join('')
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
  // description === undefined means it hasn't been hydrated yet (calendar's
  // lazy hydration) — show a brief loading state rather than a false "empty"
  // so a fast flip mid-fetch never misreads as no content. Eager surfaces
  // (guide, featured modal, map) never populate this branch.
  const backDesc = gig.description
    ? `<div class="gig-card__back-desc">${esc(gig.description)}</div>`
    : gig.description === undefined
      ? `<div class="gig-card__back-desc gig-card__back-desc--loading">Loading…</div>`
      : `<div class="gig-card__back-desc gig-card__back-desc--empty">No description added yet.</div>`;

  // Back face meta row: date · time [· price summary]
  const backMetaParts = [metaStr];
  if (gig.is_free) {
    backMetaParts.push('Free entry');
  } else if (Array.isArray(gig.ticket_tiers) && gig.ticket_tiers.length > 0) {
    const prices = gig.ticket_tiers.map(t => parseFloat(t.price)).filter(p => !isNaN(p) && p > 0);
    if (prices.length > 0) backMetaParts.push(`From R${Math.min(...prices)}`);
  }

  // Back face actions: Buy tickets (optional, 2/3) + Return (always, 1/3)
  const backCta = hasTickets
    ? `<a class="gig-card__back-cta" href="${ticketUrl}" target="_blank" rel="noopener noreferrer">Buy tickets →</a>`
    : '';
  const backActions = `
    <div class="gig-card__back-actions">
      ${backCta}
      <button type="button" class="gig-card__back-return">Return</button>
    </div>`;

  const curatedAttr = curatedLevel > 0 ? ` data-curated="${curatedLevel}"` : '';
  const delayAttr = index != null ? ` style="animation-delay: ${Math.min(index, 8) * 40}ms;"` : '';
  const dismissBtn = dismiss ? `<button type="button" class="gig-card__dismiss" aria-label="Close">${ICONS.x}</button>` : '';

  return `
    <div class="gig-card"${curatedAttr}${delayAttr}>
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
          <h3 class="gig-card__back-title">${esc(gig.title)}</h3>
          <div class="gig-card__back-divider"></div>
          ${backDesc}
          <div class="gig-card__back-meta">${esc(backMetaParts.join(' · '))}</div>
          ${backActions}
        </div>

      </div>
      ${dismissBtn}
    </div>`;
}

/* ============================================================
   DAY CARD — 16:9 poster card matching the manage-events style.
     [16:9 poster thumbnail] [title · venue · time · price]
   Preserves the poster's aspect ratio exactly as cropped. Used by
   the calendar's day panel and the map's venue-chooser sheet.
   ============================================================ */
export function renderDayCard(gig) {
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

/* ============================================================
   FEATURED CARD — flyer-forward card (poster fills the card;
   date/time/venue as frosted pills) for the header spotlight
   carousel on the guide and calendar. Tapping opens the event
   detail modal.
   ============================================================ */
export function renderFeaturedCard(gig) {
  // A featured whole run has no single date and no production-level tier
  // (curation is per-night), so it shows a date-range pill and no ring.
  const isRun = gig._isFeaturedRun;
  const tier = isRun ? 0 : gigTier(gig);
  const posterSrc = imgUrl(gig.poster, { width: '800', fit: 'contain' });
  const img = posterSrc
    ? `<img class="featured-card__img" src="${posterSrc}" alt="${esc(gig.title)} flyer" loading="lazy">`
    : `<div class="featured-card__img featured-card__img--placeholder">${esc((gig.title || '?').charAt(0).toUpperCase())}</div>`;

  // Meta as pills: a run shows its date range; a single event shows date · time.
  const pill = txt => txt ? `<span class="featured-pill">${esc(txt)}</span>` : '';
  const pills = (isRun
    ? [pill(gig.dateRange)]
    : [pill(gig.date ? formatCardDate(gig.date) : ''), pill(formatTime(gig.doors_time))]
  ).filter(Boolean).join('');

  return `
    <button class="featured-card featured-card--t${tier}" type="button" data-event-id="${esc(String(gig.id))}">
      ${img}
      <div class="featured-card__scrim"></div>
      <div class="featured-card__overlay">
        <span class="featured-card__title">${esc(gig.title)}</span>
        <div class="featured-card__pills">${pills}</div>
      </div>
    </button>`;
}
