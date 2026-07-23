/* ============================================================
   THE SCENE — MAP VIEW
   ────────────────────────────────────────────────────────────
   One evening's events as teardrop pins on a Leaflet map —
   sibling to the gig guide and calendar. Same Directus endpoint,
   same data shape, same design system.

   What's here:
     • Full-viewport Leaflet map (Carto Positron raster tiles)
     • One pin per venue with events that night, coloured by the
       HIGHEST curator tier among them (silver / gold / holo),
       count badge when a venue has 2+ events
     • Tap a pin → full gig-card modal (single event) or a venue
       chooser sheet (multiple events)
     • Floating day bar: prev / day label / next; label taps back
       to today. URL routing: ?day=today|tomorrow|<dayname>|YYYY-MM-DD
     • "N gigs not on the map yet" pill for events whose venue has
       no location_point (dismissible per session)

   Data prerequisite: the Public policy's venues Read rule must
   allow `location_point` — the events fetch requests it via
   venue.location_point and Directus 403s the WHOLE request if any
   requested field is forbidden.
   ============================================================ */

/* Page-zoom lock — same contract as calendar.js, with one difference:
   the double-tap guard is SCOPED to skip the map container, so Leaflet's
   double-tap-to-zoom still works. The gesture* events only fire for
   page pinch-zoom on iOS; Leaflet's own pinch handling rides the touch*
   events and is unaffected. */
document.addEventListener('gesturestart',  e => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', e => e.preventDefault(), { passive: false });
document.addEventListener('gestureend',    e => e.preventDefault(), { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', e => {
  if (e.target.closest('#map-canvas')) return;   // let Leaflet handle map taps
  const now = Date.now();
  if (now - lastTouchEnd < 350) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { apiGet } from './api.js';
import {
  esc, isoDate, addDays, formatCardDate, formatLongDate,
  formatTime, getParam, imgUrl, dateForDayName
} from './utils.js';
import { ICONS } from './icons.js';

/* DOM */
const CANVAS_EL    = document.getElementById('map-canvas');
const DAY_LABEL    = document.getElementById('map-day-label');
const PREV_BTN     = document.getElementById('map-prev');
const NEXT_BTN     = document.getElementById('map-next');
const LOADING_EL   = document.getElementById('map-loading');
const EMPTY_EL     = document.getElementById('map-empty');
const EMPTY_TITLE  = EMPTY_EL.querySelector('.map-empty__title');
const EMPTY_SUB    = EMPTY_EL.querySelector('.map-empty__sub');
const MISSING_EL      = document.getElementById('map-missing-pill');
const MISSING_LABEL   = document.getElementById('map-missing-label');
const MISSING_DISMISS = document.getElementById('map-missing-dismiss');
const MODAL_EL     = document.getElementById('cal-modal');
const MODAL_CARD   = document.getElementById('cal-modal-card');
const PROMO_BD     = document.getElementById('promoter-backdrop');
const PROMO_SHEET  = document.getElementById('promoter-sheet');
const PROMO_TITLE  = document.getElementById('promoter-sheet-title');
const PROMO_BODY   = document.getElementById('promoter-sheet-body');
const PROMO_CLOSE  = document.getElementById('promoter-sheet-close');
const VENUE_BD     = document.getElementById('venue-backdrop');
const VENUE_SHEET  = document.getElementById('venue-sheet');
const VENUE_TITLE  = document.getElementById('venue-sheet-title');
const VENUE_BODY   = document.getElementById('venue-sheet-body');
const VENUE_CLOSE  = document.getElementById('venue-sheet-close');

/* ============================================================
   STATE — the focused day, a per-day event cache, and the pill
   dismissal flag. A fetch token guards against a stale response
   landing after the user has stepped to another day.
   ============================================================ */
const state = {
  day:        null,        // focused day as ISO string YYYY-MM-DD
  gigsByDay:  new Map(),   // ISO date -> array of resolved gigs
  unmapped:   [],          // current day's gigs with no usable coordinates
  pillDismissed: false,    // "not on the map yet" pill, per session
};
let fetchToken = 0;

/* ============================================================
   TIER + THEATRE COALESCING — same contracts as app.js/calendar.js.
   ============================================================ */
function gigTier(gig) {
  const curators = (gig.curators || []).map(c => c.curators_id).filter(Boolean);
  if (curators.length >= 3) return 3;
  if (curators.length === 2) return 2;
  if (curators.length === 1) return 1;
  return 0;
}

/* A pending (unapproved) venue must not have its name — or its pin —
   shown publicly. Whole-object blank, same as app.js/calendar.js, so a
   pending venue's coordinates vanish along with its name. */
function publicVenue(venue) {
  return (venue && typeof venue === 'object' && venue.status && venue.status !== 'published')
    ? null
    : venue;
}

function resolveGig(event) {
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
    _isRun: true,
  };
}

/* ============================================================
   DIRECTUS FETCH — one day of published events. Field list mirrors
   app.js's fetchEvents with three deltas:
     · event_category expanded (id/name/slug) — the modal card reads
       event_category.name, same as the calendar
     · venue.id + venue.location_point (and the parent_run.venue
       mirrors) — the whole point of this page
     · description eager (a single evening is a small payload), so
       no lazy hydration is needed anywhere on this surface
   ============================================================ */
async function fetchDay(iso) {
  if (state.gigsByDay.has(iso)) return state.gigsByDay.get(iso);

  const fields = [
    'id', 'title', 'slug', 'date', 'doors_time',
    'short_description', 'description', 'ticket_url', 'poster',
    'is_free', 'ticket_tiers', 'age_restriction', 'tags',
    'venue.id',
    'venue.name',
    'venue.location',
    'venue.status',
    'venue.location_point',
    'event_category.id',
    'event_category.name',
    'event_category.slug',
    'artists.artists_id.name',
    'curators.curators_id.name',
    'curators.curators_id.logo',
    'promoters.promoters_id.id',
    'promoters.promoters_id.name',
    'promoters.promoters_id.profile_image',
    // Theatre parent run — production-wide fields a night inherits (resolveGig).
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
    'parent_run.venue.id',
    'parent_run.venue.name',
    'parent_run.venue.location',
    'parent_run.venue.status',
    'parent_run.venue.location_point',
  ].join(',');

  const params = new URLSearchParams({
    'filter[status][_eq]': 'published',
    'filter[date][_gte]':  iso,
    'filter[date][_lte]':  iso,
    'sort':   'date,doors_time',
    'fields': fields,
    'limit':  '200',
  });
  // Parent-status guard (same as app.js/calendar.js): show a child only if it
  // has no parent run, OR its parent run is itself published.
  params.set('filter[_or][0][parent_run][_null]', 'true');
  params.set('filter[_or][1][parent_run][status][_eq]', 'published');

  const json = await apiGet('/items/events', params);
  const gigs = (json.data || []).map(resolveGig);
  state.gigsByDay.set(iso, gigs);
  return gigs;
}

/* ============================================================
   COORDINATES — Directus geometry.Point arrives as GeoJSON:
     { type: "Point", coordinates: [lng, lat] }   ← lng FIRST
   Leaflet wants [lat, lng]. Guard shape and range so one malformed
   row can never take the whole marker layer down. The sanity box is
   greater Cape Town — anything outside it is a data-entry error and
   is treated as "no coordinates" (lands in the unmapped pill).
   ============================================================ */
function gigLatLng(gig) {
  const p = gig.venue?.location_point;
  if (!p || p.type !== 'Point' || !Array.isArray(p.coordinates)) return null;
  const [lng, lat] = p.coordinates.map(Number);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (lat < -35.5 || lat > -33 || lng < 17.5 || lng > 19.5) return null;
  return [lat, lng];
}

/* Group a day's gigs into one pin per coordinate. Keyed by rounded
   coordinate (not venue id): needs no extra fields, and two venues
   registered at the same point collapsing into one pin is correct
   map behaviour anyway. Gigs without usable coordinates collect
   into `unmapped` for the pill. */
function groupByPin(gigs) {
  const pins = new Map();
  const unmapped = [];
  for (const gig of gigs) {
    const ll = gigLatLng(gig);
    if (!ll) { unmapped.push(gig); continue; }
    const key = ll[0].toFixed(6) + ',' + ll[1].toFixed(6);
    if (!pins.has(key)) {
      pins.set(key, { latlng: ll, venueName: gig.venue?.name || '', gigs: [] });
    }
    pins.get(key).gigs.push(gig);
  }
  return { pins: [...pins.values()], unmapped };
}

/* ============================================================
   MAP — Leaflet with Carto Positron raster tiles (light basemap
   that sits under the liquid-glass UI; the tier colours carry the
   signal). Attribution is a licence condition — restyled small in
   CSS, never hidden. divIcon-only markers: Leaflet's default icon
   PNGs are never requested.
   ============================================================ */
const CITY_CENTRE = [-33.9249, 18.4241];   // Cape Town city bowl

const map = L.map(CANVAS_EL, {
  zoomControl: false,
  attributionControl: true,
});
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd',
  maxZoom: 20,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener noreferrer">CARTO</a>',
}).addTo(map);
map.setView(CITY_CENTRE, 12);

const markerLayer = L.layerGroup().addTo(map);

/* Teardrop divIcon. Pin tier = the HIGHEST tier among the venue's
   events that night (brightest signal wins — same rule as the
   calendar's pips). The teardrop itself is pure CSS (.map-pin);
   the wrapper class neutralises Leaflet's default divIcon chrome. */
function pinIcon(pin) {
  const tier  = Math.max(...pin.gigs.map(gigTier));
  const count = pin.gigs.length;
  const badge = count > 1 ? `<span class="map-pin__count">${count}</span>` : '';
  return L.divIcon({
    className: 'map-pin-wrap',
    html: `<div class="map-pin map-pin--t${tier}">${badge}</div>`,
    iconSize:   [34, 46],
    iconAnchor: [17, 43],   // the teardrop tip sits on the venue
  });
}

/* Tap a pin → gig card modal (single event) or venue chooser (2+).
   The hero-expand grows from the pin element itself. */
function openPin(pin, markerEl) {
  if (pin.gigs.length === 1) {
    openCardModal(pin.gigs[0], markerEl);
  } else {
    openVenueSheet(pin.venueName || 'Venue', pin.gigs);
  }
}

/* ============================================================
   RENDER — clear + refill the marker layer for the focused day,
   then frame the night: fitBounds over the pins (padded, zoom-capped
   so one lone venue doesn't open at street level), or the city-bowl
   default when nothing is mapped.
   ============================================================ */
function renderMarkers(iso) {
  const gigs = state.gigsByDay.get(iso) || [];
  const { pins, unmapped } = groupByPin(gigs);
  state.unmapped = unmapped;

  markerLayer.clearLayers();
  for (const pin of pins) {
    const marker = L.marker(pin.latlng, {
      icon: pinIcon(pin),
      keyboard: true,
      alt: `${pin.venueName} — ${pin.gigs.length} event${pin.gigs.length === 1 ? '' : 's'}`,
    });
    marker.on('click', e => openPin(pin, e.target.getElement()));
    marker.addTo(markerLayer);
  }

  if (pins.length > 0) {
    map.fitBounds(L.latLngBounds(pins.map(p => p.latlng)), {
      padding: [48, 48],
      maxZoom: 15,
    });
  } else {
    map.setView(CITY_CENTRE, 12);
  }

  // Empty state: only when the day has NO events at all. A day whose
  // events are all unmapped shows the pill instead — the night exists,
  // the map just can't place it yet.
  if (gigs.length === 0) {
    showEmpty('Nothing on this night', 'Try another day — the chevrons up top step through the week.');
  } else {
    hideEmpty();
  }

  updateMissingPill();
}

function showEmpty(title, sub) {
  EMPTY_TITLE.textContent = title;
  EMPTY_SUB.textContent   = sub;
  EMPTY_EL.hidden = false;
}
function hideEmpty() { EMPTY_EL.hidden = true; }

/* "N gigs not on the map yet" — events whose venue has no usable
   coordinates. Silent omission would make a real night look dead, so
   they surface here, one tap from their full card via the chooser.
   Dismissal is per session, not per day: the user said "stop telling
   me", not "stop telling me about Tuesday". */
function updateMissingPill() {
  const n = state.unmapped.length;
  if (n === 0 || state.pillDismissed) { MISSING_EL.hidden = true; return; }
  MISSING_LABEL.textContent = `${n} gig${n === 1 ? '' : 's'} not on the map yet`;
  MISSING_EL.hidden = false;
}

/* ============================================================
   DAY NAVIGATION — default today; ?day= deep links use the gig
   guide's idiom (today | tomorrow | <dayname> | YYYY-MM-DD). The
   label reads "Tonight" for today, otherwise the short date; tapping
   it returns to today. Day changes rewrite ?day= via replaceState.
   ============================================================ */
function parseDayParam(raw) {
  if (!raw) return null;
  if (raw === 'today') return new Date();
  if (raw === 'tomorrow') return addDays(new Date(), 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(raw + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d;
  }
  return dateForDayName(raw);
}

function updateDayLabel() {
  const todayIso = isoDate(new Date());
  DAY_LABEL.textContent = state.day === todayIso
    ? 'Tonight'
    : formatCardDate(state.day);
  DAY_LABEL.setAttribute('aria-label',
    `Showing ${formatLongDate(state.day)}. Tap to return to today.`);
}

async function setDay(iso) {
  const token = ++fetchToken;
  state.day = iso;
  updateDayLabel();

  const url = new URL(window.location);
  url.searchParams.set('day', iso);
  window.history.replaceState({}, '', url);

  const cached = state.gigsByDay.has(iso);
  if (!cached) LOADING_EL.hidden = false;
  try {
    await fetchDay(iso);
  } catch (err) {
    console.error('[Map] fetch failed', err);
    if (token === fetchToken) {
      state.gigsByDay.delete(iso);   // allow a retry on the next visit
      LOADING_EL.hidden = true;
      markerLayer.clearLayers();
      showEmpty('Couldn’t load events', 'Check your connection and step to another day to retry.');
    }
    return;
  }
  if (token !== fetchToken) return;  // user already stepped to another day
  LOADING_EL.hidden = true;
  renderMarkers(iso);
}

PREV_BTN.addEventListener('click', () => setDay(isoDate(addDays(new Date(state.day + 'T00:00:00'), -1))));
NEXT_BTN.addEventListener('click', () => setDay(isoDate(addDays(new Date(state.day + 'T00:00:00'),  1))));
DAY_LABEL.addEventListener('click', () => setDay(isoDate(new Date())));

/* ============================================================
   EVENT DETAIL MODAL — hero-expand from the tapped pin / chooser
   card. NOTE: this is COPY #4 of the gig-card builder + modal
   (app.js renderCard, app.js renderModalCard, calendar.js
   renderModalCard). Extraction into a shared module is filed as
   its own task (ClickUp: "Extract shared gig-card modal module in
   Scene App"). Copied from calendar.js with ONE simplification:
   `description` is fetched eagerly here (single-evening payload),
   so the lazy-hydration race guard is dropped — the `undefined`
   loading branches below are kept verbatim but never fire.
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

  // Meta line: DATE · DOORS TIME
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

  // Tags: category (teal) + freeform tags + age restriction (neutral).
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

  // Curators
  const curators = (gig.curators || []).map(c => c.curators_id).filter(Boolean);
  const curatedLevel = curators.length >= 3 ? 3
                     : curators.length === 2 ? 2
                     : curators.length === 1 ? 1
                     : 0;
  const curatorHtml = curators.length > 0
    ? `<div class="curators">
        <span class="curators__label">Selected by</span>
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

  // Front face footer
  const frontFooter = `
    <div class="gig-card__footer">
      <div class="gig-card__footer-row">
        ${priceMarkup(gig)}
        ${hasTickets ? `<a class="gig-card__ticket-pill" href="${ticketUrl}" target="_blank" rel="noopener noreferrer">Tickets ↗</a>` : ''}
      </div>
      <button type="button" class="gig-card__read-more">Read more →</button>
    </div>`;

  // Back face description (eager on this surface; loading branch kept verbatim)
  const backDesc = gig.description
    ? `<div class="gig-card__back-desc">${esc(gig.description)}</div>`
    : gig.description === undefined
      ? `<div class="gig-card__back-desc gig-card__back-desc--loading">Loading…</div>`
      : `<div class="gig-card__back-desc gig-card__back-desc--empty">No description added yet.</div>`;

  // Back face meta
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
          <button type="button" class="gig-card__close" aria-label="Close">${ICONS.x}</button>
          <h3 class="gig-card__back-title">${esc(gig.title)}</h3>
          <div class="gig-card__back-divider"></div>
          ${backDesc}
          <div class="gig-card__back-meta">${esc(backMetaParts.join(' · '))}</div>
          ${backCta}
        </div>

      </div>
    </div>`;
}

/* Open the modal, animating from the origin of the tapped element
   (a map pin or a chooser card; null centres it). */
function openCardModal(gig, originEl) {
  if (originEl) {
    const rect   = originEl.getBoundingClientRect();
    const vw     = window.innerWidth;
    const vh     = window.innerHeight;
    const cardCX = rect.left + rect.width  / 2;
    const cardCY = rect.top  + rect.height / 2;
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

  // Mount holographic shader on tier-3 cards. Two rAF ticks so the modal
  // is fully painted and getBoundingClientRect() returns real dimensions
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

// Close when tapping outside the card (capture phase, before the flip handler).
MODAL_CARD.addEventListener('click', e => {
  if (!MODAL_EL.classList.contains('is-open')) return;
  if (!e.target.closest('.gig-card')) closeCardModal();
}, true);

// Close on Escape — only if no sheet is stacked on top
document.addEventListener('keydown', e => {
  if (e.key === 'Escape'
      && !PROMO_SHEET.classList.contains('is-open')
      && !VENUE_SHEET.classList.contains('is-open')) closeCardModal();
});

// Flip delegation — wired once on the card container.
MODAL_CARD.addEventListener('click', e => {
  if (!MODAL_EL.classList.contains('is-open')) return;
  if (e.target.closest('.gig-card__back-cta'))   return;
  if (e.target.closest('.gig-card__ticket-pill')) return;
  if (e.target.closest('.gig-card__promoter-link')) return;

  const inner    = MODAL_CARD.querySelector('.gig-card__inner');
  const closeBtn = e.target.closest('.gig-card__close');
  if (!inner) return;

  if (closeBtn) {
    e.stopPropagation();
    inner.classList.remove('is-flipped');
    return;
  }

  if (inner.classList.contains('is-flipped')) {
    inner.classList.remove('is-flipped');
  } else {
    const gig = MODAL_EL._activeGig;
    if (gig && (gig.description || gig.short_description)) {
      inner.classList.add('is-flipped');
    }
  }
});

/* ============================================================
   VENUE CHOOSER SHEET — a marker holding 2+ events that night, or
   the "not on the map yet" pill's list. The calendar's mini
   day-cards stacked in the shared .sheet component; tapping one
   closes the sheet and opens the event modal from the card.
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

/* Mini day-card — ported from calendar.js renderDayCard so the
   chooser reads exactly like the calendar's day panel. */
function renderDayCard(gig) {
  const tier = gigTier(gig);
  const curators = (gig.curators || []).map(c => c.curators_id).filter(Boolean);

  const posterSrc = imgUrl(gig.poster, { width: '320', height: '180', fit: 'contain' });
  const imageHtml = posterSrc
    ? `<img class="cal-day-card__img" src="${posterSrc}" alt="" loading="lazy">`
    : `<div class="cal-day-card__img cal-day-card__img--placeholder">${esc(gig.title.charAt(0).toUpperCase())}</div>`;

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

function openVenueSheet(title, gigs) {
  VENUE_TITLE.textContent = title;
  VENUE_BODY.innerHTML = `<div class="map-venue-list">${gigs.map(renderDayCard).join('')}</div>`;
  VENUE_SHEET.classList.add('is-open');
  VENUE_BD.classList.add('is-open');
  document.body.style.overflow = 'hidden';

  VENUE_BODY.querySelectorAll('.cal-day-card[data-event-id]').forEach(cardEl => {
    cardEl.addEventListener('click', () => {
      const gig = gigs.find(g => String(g.id) === cardEl.dataset.eventId);
      if (!gig) return;
      // Capture the card's position BEFORE the sheet starts closing, then
      // open the modal from it — the hero-expand grows out of the tapped row.
      openCardModal(gig, cardEl);
      closeVenueSheet();
    });
  });
}

function closeVenueSheet() {
  VENUE_SHEET.classList.remove('is-open');
  VENUE_BD.classList.remove('is-open');
  document.body.style.overflow = '';
}

VENUE_CLOSE.addEventListener('click', closeVenueSheet);
VENUE_BD.addEventListener('click', closeVenueSheet);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && VENUE_SHEET.classList.contains('is-open')) closeVenueSheet();
});

/* Missing-events pill wiring */
MISSING_LABEL.addEventListener('click', () => {
  if (state.unmapped.length > 0) openVenueSheet('Not on the map yet', state.unmapped);
});
MISSING_DISMISS.addEventListener('click', () => {
  state.pillDismissed = true;
  MISSING_EL.hidden = true;
});

/* ============================================================
   PROMOTER PROFILE SHEET — mirrors calendar.js. Opens on top of
   the event modal when a promoter pill is tapped.
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
    'fields':                              'id,title,date,doors_time,poster,venue.name,venue.status,ticket_url',
    'sort':                                'date,doors_time',
    'limit':                               '20'
  });
  const json = await apiGet('/items/events', params);
  // This sheet bypasses resolveGig, so blank pending venues here too.
  return (json.data || []).map(ev => { ev.venue = publicVenue(ev.venue); return ev; });
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

/* ============================================================
   BOOT
   ============================================================ */
function init() {
  const target = parseDayParam(getParam('day')) || new Date();
  setDay(isoDate(target));
}

if (window.HoloShader) window.HoloShader.init();

init();
