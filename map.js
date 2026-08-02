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
  // Leaflet owns map taps; buttons and links own their own clicks. Cancelling
  // touchend on a control cancels the synthesised click with it, which is what
  // made rapid day-chevron taps feel dead (every second tap inside 350ms was
  // thrown away). Page zoom is already locked by the viewport meta and by
  // html { touch-action: manipulation } — this guard is the third layer.
  if (e.target.closest('#map-canvas, button, a, [role="button"], input, label')) return;
  const now = Date.now();
  if (now - lastTouchEnd < 350) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { apiGet, fetchExhibitions } from './api.js';
import {
  esc, isoDate, addDays, formatCardDate, formatLongDate,
  formatTime, getParam, imgUrl, dateForDayName, gigTier
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
const PROFILE_BD    = document.getElementById('profile-backdrop');
const PROFILE_SHEET = document.getElementById('profile-sheet');
const PROFILE_TITLE = document.getElementById('profile-sheet-title');
const PROFILE_BODY  = document.getElementById('profile-sheet-body');
const PROFILE_CLOSE = document.getElementById('profile-sheet-close');
const VENUE_BD     = document.getElementById('venue-backdrop');
const VENUE_SHEET  = document.getElementById('venue-sheet');
const VENUE_TITLE  = document.getElementById('venue-sheet-title');
const VENUE_BODY   = document.getElementById('venue-sheet-body');
const VENUE_CLOSE  = document.getElementById('venue-sheet-close');
const EXH_TOGGLE   = document.getElementById('map-exhibition-toggle');

/* ============================================================
   STATE — the focused day, a per-day event cache, and the pill
   dismissal flag. A fetch token guards against a stale response
   landing after the user has stepped to another day.
   ============================================================ */
const state = {
  day:        null,        // focused day as ISO string YYYY-MM-DD
  gigsByDay:  new Map(),   // ISO date -> array of resolved gigs
  exhibitionsByDay: new Map(), // ISO date -> array of exhibitions active that day
  showExhibitions:  true,  // Exhibitions layer toggle (session state)
  unmapped:   [],          // current day's gigs with no usable coordinates
  pillDismissed: false,    // "not on the map yet" pill, per session
};
let fetchToken = 0;

// TIER + THEATRE COALESCING — gigTier is single-sourced in utils.js.

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
    'curators.curators_id.id',      // needed by the curator profile sheet
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
// Exhibitions ride their own layer so the toggle can show/hide them without
// touching the gig markers, and so their blue family reads as distinct.
const exhibitionLayer = L.layerGroup().addTo(map);

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

  // Exhibitions — a separate blue-pin family, date-scoped to this day and
  // gated by the layer toggle. groupByPin works on them unchanged (they carry
  // venue.name + venue.location_point just like gigs). We keep the RAW list
  // (pre-toggle) for the empty-state test so hiding the layer never fakes an
  // empty night.
  const rawExhibitions = state.exhibitionsByDay.get(iso) || [];
  const exhibitions = state.showExhibitions ? rawExhibitions : [];
  const { pins: exPins } = groupByPin(exhibitions);

  exhibitionLayer.clearLayers();
  for (const pin of exPins) {
    const marker = L.marker(pin.latlng, {
      icon: exhibitionPinIcon(pin),
      keyboard: true,
      alt: `${pin.venueName} — ${pin.gigs.length} exhibition${pin.gigs.length === 1 ? '' : 's'}`,
    });
    marker.on('click', e => openExhibitionPin(pin, e.target.getElement()));
    marker.addTo(exhibitionLayer);
  }

  const allLatLngs = [...pins.map(p => p.latlng), ...exPins.map(p => p.latlng)];
  if (allLatLngs.length > 0) {
    map.fitBounds(L.latLngBounds(allLatLngs), { padding: [48, 48], maxZoom: 15 });
  } else {
    map.setView(CITY_CENTRE, 12);
  }

  // Empty state: only when the day has NO gigs AND NO exhibitions at all. A day
  // whose gigs are all unmapped shows the pill instead — the night exists, the
  // map just can't place it yet.
  if (gigs.length === 0 && rawExhibitions.length === 0) {
    // Date-aware wording: "check back" reads as nonsense on a day that's
    // already passed, so past and future/today get their own copy. ISO date
    // strings compare lexically, so no extra parsing is needed here.
    const past = iso < isoDate(new Date());
    showEmpty(
      past ? 'Nothing was listed' : 'Nothing listed yet',
      past
        ? 'No events made the map on this day.'
        : 'No events on the map for this day. New listings land through the week.'
    );
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

  const cached = state.gigsByDay.has(iso) && state.exhibitionsByDay.has(iso);
  if (!cached) {
    LOADING_EL.hidden = false;
    // Clear the OUTGOING day's state the instant a real fetch starts, so a tap
    // is visibly acknowledged straight away instead of leaving the previous
    // day's pins/pill/empty-panel on screen for the whole await (that dead
    // feeling is what drove rapid re-tapping in the first place). Skipped for
    // a cached day, which resolves on a microtask with no paint in between —
    // clearing there would just flash a blank map on fast repeat visits.
    hideEmpty();
    markerLayer.clearLayers();
    exhibitionLayer.clearLayers();
    state.unmapped = [];
    MISSING_EL.hidden = true;
  }
  try {
    // Exhibitions fetch never rejects (api.js swallows its errors → []), so a
    // failed exhibitions read can't take the gig map down; only fetchDay throws.
    await Promise.all([fetchDay(iso), fetchExhibitionsDay(iso)]);
  } catch (err) {
    console.error('[Map] fetch failed', err);
    if (token === fetchToken) {
      state.gigsByDay.delete(iso);   // allow a retry on the next visit
      LOADING_EL.hidden = true;
      markerLayer.clearLayers();
      state.unmapped = [];
      MISSING_EL.hidden = true;
      showEmpty('Couldn’t load events', 'Check your connection, then tap the date above to try again.');
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
  const curatedLevel = gigTier(gig);
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
            ? `<img class="entity-pill__logo" src="${logoSrc}" alt="">`
            : `<span class="entity-pill__logo entity-pill__logo--placeholder"></span>`;
          return `<button class="entity-pill" type="button" data-profile-kind="promoter" data-profile-id="${p.id}">${logoEl}${esc(p.name)}</button>`;
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
          <h3 class="gig-card__back-title">${esc(gig.title)}</h3>
          <div class="gig-card__back-divider"></div>
          ${backDesc}
          <div class="gig-card__back-meta">${esc(backMetaParts.join(' · '))}</div>
          ${backActions}
        </div>

      </div>
      <button type="button" class="gig-card__dismiss" aria-label="Close">${ICONS.x}</button>
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
      && !PROFILE_SHEET.classList.contains('is-open')
      && !VENUE_SHEET.classList.contains('is-open')) closeCardModal();
});

// Flip delegation — wired once on the card container.
MODAL_CARD.addEventListener('click', e => {
  if (!MODAL_EL.classList.contains('is-open')) return;

  // Dismiss button sits on the card shell (both faces) and closes the
  // modal outright — checked before the flip exemptions below.
  if (e.target.closest('.gig-card__dismiss')) {
    e.stopPropagation();
    closeCardModal();
    return;
  }

  if (e.target.closest('.gig-card__back-cta'))   return;
  if (e.target.closest('.gig-card__ticket-pill')) return;
  if (e.target.closest('[data-profile-kind]'))    return;  // promoter + curator pills

  const inner    = MODAL_CARD.querySelector('.gig-card__inner');
  const closeBtn = e.target.closest('.gig-card__back-return');
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
   PROFILE SHEET — mirrors calendar.js. Opens on top of the event
   modal when a promoter or curator pill is tapped.

   One sheet serves both types; everything that differs lives in
   PROFILE_KINDS, and data-mode on the sheet picks the accent colour.
   ============================================================ */

// Directus curator_type values → the label shown above the name.
// Promoters have no equivalent field, so their cards omit the line.
const CURATOR_TYPE_LABELS = {
  individual: 'Curator',    publication: 'Publication',
  collective: 'Collective', other:       'Curator'
};

const PROFILE_KINDS = {
  promoter: {
    label:       'Promoter',
    collection:  'promoters',
    fields:      'id,name,bio,profile_image,website,social_links',
    eventFilter: 'filter[promoters][promoters_id][_eq]',
    avatar:      p => p.profile_image,
    role:        () => null,
    errorText:   "Couldn't load promoter details."
  },
  curator: {
    label:       'Curator',
    collection:  'curators',
    fields:      'id,name,bio,profile_image,logo,website,social_links,curator_type',
    eventFilter: 'filter[curators][curators_id][_eq]',
    // logo is required on curators, profile_image optional — so fall back.
    avatar:      c => c.profile_image || c.logo,
    role:        c => CURATOR_TYPE_LABELS[c.curator_type] || null,
    errorText:   "Couldn't load curator details."
  }
};

async function fetchProfile(kind, id) {
  const cfg  = PROFILE_KINDS[kind];
  const json = await apiGet(`/items/${cfg.collection}/${id}?fields=${cfg.fields}`);
  return json.data;
}

async function fetchProfileEvents(kind, id) {
  const cfg   = PROFILE_KINDS[kind];
  const today = isoDate(new Date());
  const params = new URLSearchParams({
    [cfg.eventFilter]:     id,
    'filter[status][_eq]': 'published',
    'filter[date][_gte]':  today,
    'fields':              'id,title,date,doors_time,poster,venue.name,venue.status,ticket_url',
    'sort':                'date,doors_time',
    'limit':               '20'
  });
  const json = await apiGet('/items/events', params);
  // This sheet bypasses resolveGig, so blank pending venues here too.
  return (json.data || []).map(ev => { ev.venue = publicVenue(ev.venue); return ev; });
}

function renderProfile(kind, entity, events) {
  const cfg = PROFILE_KINDS[kind];

  const avatarImg  = cfg.avatar(entity);
  const avatarSrc  = avatarImg
    ? imgUrl(avatarImg, { width: '120', height: '120', fit: 'cover' })
    : null;
  const avatarHtml = avatarSrc
    ? `<img class="profile-sheet__avatar" src="${avatarSrc}" alt="${esc(entity.name)} logo">`
    : `<div class="profile-sheet__avatar profile-sheet__avatar--placeholder">${esc(entity.name.charAt(0).toUpperCase())}</div>`;

  // Role marker — curator_type for curators, nothing for promoters
  const roleLabel = cfg.role(entity);
  const roleHtml  = roleLabel
    ? `<p class="profile-sheet__role">${esc(roleLabel)}</p>`
    : '';

  const bioHtml     = entity.bio
    ? `<p class="profile-sheet__bio">${esc(entity.bio)}</p>`
    : '';
  const websiteHtml = entity.website
    ? `<a class="profile-sheet__website" href="${esc(entity.website)}" target="_blank" rel="noopener noreferrer">Visit website ↗</a>`
    : '';

  // social_links key casing differs by collection — promoters store
  // Platforms/URL, curators store platform/url — so read both.
  const PLATFORM_LABELS = {
    instagram: 'Instagram', facebook: 'Facebook',
    x: 'X', youtube: 'YouTube', tiktok: 'TikTok',
    soundcloud: 'SoundCloud', spotify: 'Spotify', bandcamp: 'Bandcamp'
  };
  const socials    = Array.isArray(entity.social_links) ? entity.social_links : [];
  const socialHtml = socials.length > 0
    ? `<div class="profile-sheet__socials">
        ${socials.map(s => {
          const rawPlatform = s.Platforms || s.platform || '';
          const url         = s.URL       || s.url      || '';
          if (!url) return '';
          const label = PLATFORM_LABELS[rawPlatform.toLowerCase()]
            || (rawPlatform.charAt(0).toUpperCase() + rawPlatform.slice(1))
            || url;
          return `<a class="profile-sheet__social-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
        }).filter(Boolean).join('')}
      </div>`
    : '';

  const eventsHtml = events.length > 0
    ? `<div class="profile-sheet__events">
        <p class="profile-sheet__events-title">Upcoming Events</p>
        <ul class="profile-sheet__event-list">
          ${events.map(ev => {
            const timeStr   = formatTime(ev.doors_time);
            const meta      = [formatCardDate(ev.date), timeStr, ev.venue?.name].filter(Boolean).join(' · ');
            const thumbSrc  = ev.poster ? imgUrl(ev.poster, { width: '144', fit: 'contain' }) : null;
            const thumbHtml = thumbSrc
              ? `<img class="profile-sheet__event-thumb" src="${thumbSrc}" alt="" loading="lazy">`
              : `<div class="profile-sheet__event-thumb profile-sheet__event-thumb--placeholder"></div>`;
            const textHtml  = `
              <div class="profile-sheet__event-text">
                <div class="profile-sheet__event-title">${esc(ev.title)}</div>
                <div class="profile-sheet__event-meta">${esc(meta)}</div>
              </div>`;
            return ev.ticket_url
              ? `<li class="profile-sheet__event-item"><a href="${esc(ev.ticket_url)}" target="_blank" rel="noopener noreferrer" class="profile-sheet__event-link">${thumbHtml}${textHtml}</a></li>`
              : `<li class="profile-sheet__event-item">${thumbHtml}${textHtml}</li>`;
          }).join('')}
        </ul>
      </div>`
    : `<p class="profile-sheet__no-events">No upcoming events scheduled.</p>`;

  return `
    <div class="profile-sheet">
      <div class="profile-sheet__header">
        <div class="profile-sheet__accent-bg"></div>
        ${avatarHtml}
        ${roleHtml}
        <h3 class="profile-sheet__name">${esc(entity.name)}</h3>
        ${bioHtml}
        ${websiteHtml}
        ${socialHtml}
      </div>
      ${eventsHtml}
    </div>`;
}

function openProfileSheet(kind, id) {
  const cfg = PROFILE_KINDS[kind];
  if (!cfg) return;

  // data-mode drives the accent: green for promoter, cyan for curator.
  PROFILE_SHEET.setAttribute('data-mode', kind);
  PROFILE_TITLE.textContent = 'Loading…';
  PROFILE_BODY.innerHTML    = `<div class="profile-sheet__loading"><div class="spinner"></div></div>`;
  PROFILE_SHEET.classList.add('is-open');
  PROFILE_BD.classList.add('is-open');
  document.body.style.overflow = 'hidden';

  fetchProfile(kind, id)
    .then(async entity => {
      PROFILE_TITLE.textContent = entity.name;
      let events = [];
      try { events = await fetchProfileEvents(kind, id); } catch (_) {}
      PROFILE_BODY.innerHTML = renderProfile(kind, entity, events);
    })
    .catch(err => {
      console.error(`[Scene] fetchProfile(${kind}) failed:`, err);
      PROFILE_BODY.innerHTML    = `<div class="state" style="padding:2rem 1rem;"><p class="state__text">${cfg.errorText}</p></div>`;
      PROFILE_TITLE.textContent = cfg.label;
    });
}

function closeProfileSheet() {
  PROFILE_SHEET.classList.remove('is-open');
  PROFILE_BD.classList.remove('is-open');
  document.body.style.overflow = '';
}

// Tap a promoter or curator pill inside the event modal card
MODAL_CARD.addEventListener('click', e => {
  const pill = e.target.closest('[data-profile-kind][data-profile-id]');
  if (!pill) return;
  e.stopPropagation();
  openProfileSheet(pill.dataset.profileKind, Number(pill.dataset.profileId));
});

PROFILE_CLOSE.addEventListener('click', closeProfileSheet);
PROFILE_BD.addEventListener('click', closeProfileSheet);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && PROFILE_SHEET.classList.contains('is-open')) closeProfileSheet();
});

/* ============================================================
   EXHIBITIONS ON THE MAP — blue-pin family, date-scoped
   ────────────────────────────────────────────────────────────
   Art + museum shows active on the focused day, as scene-blue teardrop
   pins on their own layer (toggled by the Exhibitions switch). gigLatLng
   + groupByPin already operate on any object carrying venue.location_point
   + venue.name, so they're reused as-is. Tap → the shared #cal-modal
   (single) or the venue sheet (2+). The card markup + small date/label
   helpers are duplicated here per the codebase's per-entry-script
   convention (same as the four gig-card modal copies).
   ============================================================ */
const EXH_TYPE_LABELS = {
  'painting': 'Painting', 'sculpture': 'Sculpture', 'photography': 'Photography',
  'mixed-media': 'Mixed Media', 'installation': 'Installation',
  'group-show': 'Group Show', 'heritage': 'Heritage',
};
const EXH_AREAS = {
  'cbd': 'CBD', 'southern-suburbs': 'Southern Suburbs', 'northern-suburbs': 'Northern Suburbs',
  'atlantic-seaboard': 'Atlantic Seaboard', 'southern-peninsula': 'Southern Peninsula', 'cape-flats': 'Cape Flats',
};
function exhTypeLabel(slug) {
  return EXH_TYPE_LABELS[slug] || String(slug || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function fmtExhRange(start, end) {
  const opts = { day: 'numeric', month: 'short' };
  const d0 = new Date(start + 'T00:00:00');
  const d1 = new Date(end + 'T00:00:00');
  if (start === end) return d0.toLocaleDateString('en-ZA', opts);
  const sameMonth = d0.getMonth() === d1.getMonth() && d0.getFullYear() === d1.getFullYear();
  return sameMonth
    ? `${d0.getDate()} - ${d1.toLocaleDateString('en-ZA', opts)}`
    : `${d0.toLocaleDateString('en-ZA', opts)} - ${d1.toLocaleDateString('en-ZA', opts)}`;
}
function fmtExhClosing(end) {
  const d = new Date(end + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  if (days <= 0)  return 'Last day';
  if (days === 1) return 'Ends tomorrow';
  if (days <= 7)  return `${days} days left`;
  return 'On until ' + d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}
function exhClosingSoon(end) {
  const d = new Date(end + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000) <= 7;
}
function exhEntryMarkup(ex) {
  if (ex.is_free)    return `<div class="price price--free"><span class="price__prefix">Entry</span><span class="price__value">Free</span></div>`;
  if (ex.entry_info) return `<div class="price"><span class="price__prefix">Entry</span><span class="price__value">${esc(ex.entry_info)}</span></div>`;
  return '';
}

/* Blue teardrop divIcon — same shape/anchor as the tier pins, scene-blue fill. */
function exhibitionPinIcon(pin) {
  const count = pin.gigs.length;
  const badge = count > 1 ? `<span class="map-pin__count">${count}</span>` : '';
  return L.divIcon({
    className: 'map-pin-wrap',
    html: `<div class="map-pin map-pin--exhibition">${badge}</div>`,
    iconSize:   [34, 46],
    iconAnchor: [17, 43],
  });
}

function renderExhibitionModalCard(ex) {
  const posterSrc = imgUrl(ex.poster, { width: '800', fit: 'contain' });
  const poster = posterSrc
    ? `<img class="gig-card__poster" src="${posterSrc}" alt="${esc(ex.title)} poster" loading="lazy">`
    : `<div class="gig-card__poster-placeholder">The Scene</div>`;

  const range   = fmtExhRange(ex.start_date, ex.end_date);
  const closing = fmtExhClosing(ex.end_date);
  const soon    = exhClosingSoon(ex.end_date);

  const areaName = ex.venue?.location ? (EXH_AREAS[ex.venue.location] || ex.venue.location) : null;
  const venueHtml = ex.venue?.name
    ? `<p class="gig-card__venue"><span class="gig-card__venue-name">${esc(ex.venue.name)}</span>${areaName ? `<span class="gig-card__venue-area">${esc(areaName)}</span>` : ''}</p>`
    : '';

  const descHtml = ex.short_description ? `<p class="gig-card__desc">${esc(ex.short_description)}</p>` : '';

  const typeName = ex.exhibition_type ? exhTypeLabel(ex.exhibition_type) : null;
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
        ${exhEntryMarkup(ex)}
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
  const backActions = `
    <div class="gig-card__back-actions">
      ${backCta}
      <button type="button" class="gig-card__back-return">Return</button>
    </div>`;

  return `
    <div class="exh-card gig-card">
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
          <h3 class="gig-card__back-title">${esc(ex.title)}</h3>
          <div class="gig-card__back-divider"></div>
          ${backDesc}
          <div class="gig-card__back-meta">${esc(backMetaParts.join(' · '))}</div>
          ${backActions}
        </div>
      </div>
      <button type="button" class="gig-card__dismiss" aria-label="Close">${ICONS.x}</button>
    </div>`;
}

/* Open the exhibition in the shared #cal-modal, hero-expanding from the tapped
   pin/card. Reuses the modal's existing outside-tap / Escape / flip handlers —
   they key off .gig-card + MODAL_EL._activeGig.description, which this provides.
   No holo shader mount: exhibitions carry no curator tier. */
function openExhibitionModal(ex, originEl) {
  if (originEl) {
    const rect = originEl.getBoundingClientRect();
    const ox = Math.round(((rect.left + rect.width  / 2) / window.innerWidth)  * 100);
    const oy = Math.round(((rect.top  + rect.height / 2) / window.innerHeight) * 100);
    MODAL_CARD.style.setProperty('--origin-x', `${ox}%`);
    MODAL_CARD.style.setProperty('--origin-y', `${oy}%`);
  } else {
    MODAL_CARD.style.setProperty('--origin-x', '50%');
    MODAL_CARD.style.setProperty('--origin-y', '50%');
  }
  MODAL_CARD.innerHTML = renderExhibitionModalCard(ex);
  MODAL_EL.classList.remove('is-closing');
  MODAL_EL.classList.add('is-open');
  MODAL_EL._activeGig = ex;   // shared flip handler reads .description off this
}

/* Mini card for the chooser when a gallery shows 2+ exhibitions that day. */
function renderExhibitionMini(ex) {
  const posterSrc = imgUrl(ex.poster, { width: '320', height: '180', fit: 'contain' });
  const imageHtml = posterSrc
    ? `<img class="cal-day-card__img" src="${posterSrc}" alt="" loading="lazy">`
    : `<div class="cal-day-card__img cal-day-card__img--placeholder">${esc((ex.title || '?').charAt(0).toUpperCase())}</div>`;
  const venueName = ex.venue?.name ? esc(ex.venue.name) : '';
  const meta = [fmtExhRange(ex.start_date, ex.end_date), ex.is_free ? 'Free' : (ex.entry_info || '')].filter(Boolean);
  const metaHtml = meta.length
    ? `<div class="cal-day-card__meta">${meta.map(m => `<span>${esc(m)}</span>`).join('<span class="cal-day-card__sep">·</span>')}</div>`
    : '';
  return `
    <button class="cal-day-card" type="button" data-exh-id="${esc(String(ex.id))}">
      <div class="cal-day-card__poster">${imageHtml}</div>
      <div class="cal-day-card__body">
        <div class="cal-day-card__title">${esc(ex.title)}</div>
        ${venueName ? `<div class="cal-day-card__venue">${venueName}</div>` : ''}
        ${metaHtml}
      </div>
    </button>`;
}

function openExhibitionVenueSheet(title, list) {
  VENUE_TITLE.textContent = title;
  VENUE_BODY.innerHTML = `<div class="map-venue-list">${list.map(renderExhibitionMini).join('')}</div>`;
  VENUE_SHEET.classList.add('is-open');
  VENUE_BD.classList.add('is-open');
  document.body.style.overflow = 'hidden';
  VENUE_BODY.querySelectorAll('.cal-day-card[data-exh-id]').forEach(cardEl => {
    cardEl.addEventListener('click', () => {
      const ex = list.find(e => String(e.id) === cardEl.dataset.exhId);
      if (!ex) return;
      openExhibitionModal(ex, cardEl);
      closeVenueSheet();
    });
  });
}

function openExhibitionPin(pin, markerEl) {
  if (pin.gigs.length === 1) openExhibitionModal(pin.gigs[0], markerEl);
  else openExhibitionVenueSheet(pin.venueName || 'Gallery', pin.gigs);
}

async function fetchExhibitionsDay(iso) {
  if (state.exhibitionsByDay.has(iso)) return state.exhibitionsByDay.get(iso);
  const list = (await fetchExhibitions({ onDate: iso }))
    .map(ex => { ex.venue = publicVenue(ex.venue); return ex; });
  state.exhibitionsByDay.set(iso, list);
  return list;
}

/* Exhibitions layer toggle — re-renders the current day's markers (no refetch). */
if (EXH_TOGGLE) {
  EXH_TOGGLE.addEventListener('click', () => {
    state.showExhibitions = !state.showExhibitions;
    EXH_TOGGLE.classList.toggle('is-active', state.showExhibitions);
    EXH_TOGGLE.setAttribute('aria-pressed', String(state.showExhibitions));
    if (state.day) renderMarkers(state.day);
  });
}

/* ============================================================
   BOOT
   ============================================================ */
function init() {
  const target = parseDayParam(getParam('day')) || new Date();
  setDay(isoDate(target));
}

if (window.HoloShader) window.HoloShader.init();

init();
