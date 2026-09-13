/* ============================================================
   THE SCENE — MAP VIEW
   ────────────────────────────────────────────────────────────
   One evening's events as teardrop pins on a MapLibre GL map,
   sibling to the gig guide and calendar. Same Directus endpoint,
   same data shape, same design system.

   What's here:
     • Full-viewport MapLibre map over a self-hosted Protomaps
       vector basemap (public/basemap-2026-09.pmtiles)
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

/* Page-zoom lock (same contract as calendar.js), with one difference:
   the double-tap guard is SCOPED to skip the map container, so the
   map's own double-tap-to-zoom still works. The gesture* events only
   fire for page pinch-zoom on iOS; the map's pinch handling does not
   depend on them. */
document.addEventListener('gesturestart',  e => e.preventDefault(), { passive: false });
document.addEventListener('gesturechange', e => e.preventDefault(), { passive: false });
document.addEventListener('gestureend',    e => e.preventDefault(), { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', e => {
  // The map owns its own taps; buttons and links own their clicks. Cancelling
  // touchend on a control cancels the synthesised click with it, which is what
  // made rapid day-chevron taps feel dead (every second tap inside 350ms was
  // thrown away). Page zoom is already locked by the viewport meta and by
  // html { touch-action: manipulation } — this guard is the third layer.
  if (e.target.closest('#map-canvas, button, a, [role="button"], input, label')) return;
  const now = Date.now();
  if (now - lastTouchEnd < 350) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre v6 looks for its worker beside its own module file, which no longer
// exists once Vite bundles it into /assets/. Vite builds the worker and hands
// back its URL; map setup passes it to setWorkerUrl.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';

import { apiGet, fetchExhibitions } from './api.js';
import {
  esc, isoDate, addDays, formatCardDate, formatLongDate,
  formatTime, getParam, imgUrl, dateForDayName, gigTier,
  publicVenue, resolveGig
} from './utils.js';
import { ICONS } from './icons.js';
import { renderGigCard, renderDayCard } from './gig-card.js';
import { createCardModal } from './card-modal.js';
import { createProfileSheet } from './profile-sheet.js';

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

// TIER + THEATRE COALESCING — gigTier, resolveGig and publicVenue are
// all single-sourced in utils.js, shared with app.js and calendar.js.

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
   COORDINATES: Directus geometry.Point arrives as GeoJSON
     { type: "Point", coordinates: [lng, lat] }   <- lng FIRST
   MapLibre takes the same [lng, lat] order, so the pair passes
   straight through. Guard shape and range so one malformed row can
   never take the whole marker set down. The range is the basemap
   file's own coverage: a venue outside it would sit on blank map,
   so it is treated as "no coordinates" and lands in the unmapped pill.
   ============================================================ */
// [[west, south], [east, north]]: the bbox basemap-2026-09.pmtiles was cut to.
// Re-cutting the file with a different bbox means updating this too.
const BASEMAP_BOUNDS = [[18.20, -34.50], [19.15, -33.60]];

function gigLngLat(gig) {
  const p = gig.venue?.location_point;
  if (!p || p.type !== 'Point' || !Array.isArray(p.coordinates)) return null;
  const [lng, lat] = p.coordinates.map(Number);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  const [[west, south], [east, north]] = BASEMAP_BOUNDS;
  if (lng < west || lng > east || lat < south || lat > north) return null;
  return [lng, lat];
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
    const lngLat = gigLngLat(gig);
    if (!lngLat) { unmapped.push(gig); continue; }
    const key = lngLat[0].toFixed(6) + ',' + lngLat[1].toFixed(6);   // "lng,lat", never parsed back
    if (!pins.has(key)) {
      pins.set(key, { lngLat, venueName: gig.venue?.name || '', gigs: [] });
    }
    pins.get(key).gigs.push(gig);
  }
  return { pins: [...pins.values()], unmapped };
}

/* ============================================================
   MAP: MapLibre GL rendering a self-hosted Protomaps vector basemap.
   public/basemap-2026-09.pmtiles is a Cape Town extract the browser
   reads in small HTTP range requests; its fonts and sprites sit
   beside it in public/basemap-assets/, so no third party is in the
   map's runtime path. Style = Protomaps "white" flavor nudged toward
   the old Carto Positron look (off-white ground, blue-grey water) so
   the pin contrast work (charcoal outlines, pewter silver) still
   holds. Attribution is a licence condition (OSM ODbL): restyled
   small in CSS, never hidden.
   ============================================================ */
const CITY_CENTRE = [18.4241, -33.9249];   // Cape Town city bowl, [lng, lat]
const SITE_ROOT   = window.location.origin + import.meta.env.BASE_URL;
const BASEMAP_URL = SITE_ROOT + 'basemap-2026-09.pmtiles';
const ASSETS_URL  = SITE_ROOT + 'basemap-assets/';

const POSITRON_FLAVOR = {
  ...namedFlavor('white'),
  background:  '#FAFAF8',
  earth:       '#FAFAF8',
  water:       '#D4DADC',
  park_a:      '#EEF1EC',
  park_b:      '#E6EAE4',
  wood_a:      '#EEF1EC',
  wood_b:      '#E6EAE4',
  scrub_a:     '#F2F4F0',
  scrub_b:     '#EEF1EC',
  ocean_label: '#8E9CA1',
};

// Both must run before the Map is constructed.
maplibregl.setWorkerUrl(maplibreWorkerUrl);
maplibregl.addProtocol('pmtiles', new Protocol().tile);

const map = new maplibregl.Map({
  container: CANVAS_EL,
  style: {
    version: 8,
    glyphs: ASSETS_URL + 'fonts/{fontstack}/{range}.pbf',
    sprite: ASSETS_URL + 'sprites/v4/white',
    sources: {
      protomaps: {
        type: 'vector',
        url: 'pmtiles://' + BASEMAP_URL,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors &copy; <a href="https://protomaps.com" target="_blank" rel="noopener noreferrer">Protomaps</a>',
      },
    },
    layers: layers('protomaps', POSITRON_FLAVOR, { lang: 'en' }),
  },
  center: CITY_CENTRE,
  zoom: 12,
  maxBounds: BASEMAP_BOUNDS,   // no panning off the extract onto blank map
  attributionControl: { compact: false },
  // Flat north-up map: MapLibre rotates and tilts by default.
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

// Separate sets so the exhibitions toggle clears the blue family without
// touching gig pins. Plain arrays: they only ever need bulk-clearing.
const gigMarkers = [];
const exhibitionMarkers = [];

function clearMarkers(markers) {
  for (const m of markers) m.remove();
  markers.length = 0;
}

/* Teardrop pin as a DOM marker. The teardrop is pure CSS (.map-pin);
   .map-pin-wrap is the 34x46 box MapLibre positions, and its CSS size
   is load-bearing (see styles.css). anchor 'bottom' + 3px lands the
   drop's tip, 43px down the box, on the venue. */
function createPinMarker(pin, pinClass, label, onTap) {
  const count = pin.gigs.length;
  const el = document.createElement('div');
  el.className = 'map-pin-wrap';
  el.innerHTML = `<div class="map-pin ${pinClass}">${count > 1 ? `<span class="map-pin__count">${count}</span>` : ''}</div>`;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', label);
  // MapLibre already swallows a click that ends a map drag, but gives custom
  // markers no keyboard activation, so Enter/Space opens a focused pin here.
  el.addEventListener('click', () => onTap(el));
  el.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onTap(el);
  });
  return new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, 3] })
    .setLngLat(pin.lngLat)
    .addTo(map);
}

/* Tap a pin → gig card modal (single event) or venue chooser (2+).
   The hero-expand grows from the pin element itself. */
function openPin(pin, markerEl) {
  if (pin.gigs.length === 1) {
    cardModal.open(pin.gigs[0], markerEl);
  } else {
    openVenueSheet(pin.venueName || 'Venue', pin.gigs);
  }
}

/* ============================================================
   RENDER: clear + refill the pins for the focused day, then frame
   the night: fitBounds over the pins (padded, zoom-capped so one
   lone venue doesn't open at street level), or the city-bowl
   default when nothing is mapped. Gig pin tier = the HIGHEST tier
   among the venue's events that night (brightest signal wins, same
   rule as the calendar's pips).
   ============================================================ */
function renderMarkers(iso) {
  const gigs = state.gigsByDay.get(iso) || [];
  const { pins, unmapped } = groupByPin(gigs);
  state.unmapped = unmapped;

  clearMarkers(gigMarkers);
  for (const pin of pins) {
    const tier = Math.max(...pin.gigs.map(gigTier));
    const n = pin.gigs.length;
    gigMarkers.push(createPinMarker(pin, `map-pin--t${tier}`,
      `${pin.venueName || 'Venue'}: ${n} event${n === 1 ? '' : 's'}`,
      el => openPin(pin, el)));
  }

  // Exhibitions: a separate blue-pin family, date-scoped to this day and
  // gated by the layer toggle. groupByPin works on them unchanged (they carry
  // venue.name + venue.location_point just like gigs). We keep the RAW list
  // (pre-toggle) for the empty-state test so hiding the layer never fakes an
  // empty night.
  const rawExhibitions = state.exhibitionsByDay.get(iso) || [];
  const exhibitions = state.showExhibitions ? rawExhibitions : [];
  const { pins: exPins } = groupByPin(exhibitions);

  clearMarkers(exhibitionMarkers);
  for (const pin of exPins) {
    const n = pin.gigs.length;
    exhibitionMarkers.push(createPinMarker(pin, 'map-pin--exhibition',
      `${pin.venueName || 'Gallery'}: ${n} exhibition${n === 1 ? '' : 's'}`,
      el => openExhibitionPin(pin, el)));
  }

  const allLngLats = [...pins.map(p => p.lngLat), ...exPins.map(p => p.lngLat)];
  if (allLngLats.length > 0) {
    const bounds = allLngLats.reduce(
      (b, lngLat) => b.extend(lngLat),
      new maplibregl.LngLatBounds(allLngLats[0], allLngLats[0]));
    // duration 0: MapLibre animates fitBounds by default, which would add a
    // camera flight to every day step.
    map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 0 });
  } else {
    map.jumpTo({ center: CITY_CENTRE, zoom: 12 });
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
    clearMarkers(gigMarkers);
    clearMarkers(exhibitionMarkers);
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
      clearMarkers(gigMarkers);
      clearMarkers(exhibitionMarkers);
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
   card. priceMarkup, priceLabel, renderDayCard and the card
   builder itself now live in gig-card.js, shared with app.js and
   calendar.js. No categoryLookup is passed here — fetchDay's
   fields query already requests event_category expanded, so
   gigCategoryRefs's expanded-object branch resolves it without
   one. `description` is fetched eagerly here (single-evening
   payload), so the builder's loading-state branch never fires.
   ============================================================ */
function renderModalCard(gig) {
  return renderGigCard(gig, { dismiss: true });
}

/* The open/close/backdrop/Escape/flip machinery now lives in
   card-modal.js, shared with app.js and calendar.js. blockedBy lists
   both stacked sheets — a promoter/curator profile and the venue
   chooser can each be open on top of this modal. The per-open render
   override lets the exhibitions layer below reuse this same modal
   instance for a second entity type instead of hand-rolling its own
   open/close pair. */
const cardModal = createCardModal({
  modal: MODAL_EL,
  card: MODAL_CARD,
  render: renderModalCard,
  blockedBy: [PROFILE_SHEET, VENUE_SHEET],
  onProfilePill: openProfileSheet,
});

/* ============================================================
   VENUE CHOOSER SHEET — a marker holding 2+ events that night, or
   the "not on the map yet" pill's list. renderDayCard (gig-card.js,
   shared with calendar.js) stacks mini-cards in the shared .sheet
   component; tapping one closes the sheet and opens the event
   modal from the card.
   ============================================================ */

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
      cardModal.open(gig, cardEl);
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
   PROFILE SHEET — fetch/render/open/close now live in
   profile-sheet.js, shared with app.js and calendar.js. Opens on
   top of the event modal when a promoter or curator pill is tapped.
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

/* ============================================================
   EXHIBITIONS ON THE MAP — blue-pin family, date-scoped
   ────────────────────────────────────────────────────────────
   Art + museum shows active on the focused day, as scene-blue teardrop
   pins in their own marker set (toggled by the Exhibitions switch). gigLngLat
   + groupByPin already operate on any object carrying venue.location_point
   + venue.name, so they're reused as-is. Tap → the shared #cal-modal
   (single, via cardModal.open with a render override) or the venue
   sheet (2+). The card markup + small date/label helpers below are
   exhibitions' own — a different entity shape to the gig cards, so
   not part of the gig-card.js extraction.
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
      cardModal.open(ex, cardEl, { render: renderExhibitionModalCard });
      closeVenueSheet();
    });
  });
}

// No holo shader concern: renderExhibitionModalCard never sets data-curated,
// so the shared modal's shader mount attempt simply matches nothing.
function openExhibitionPin(pin, markerEl) {
  if (pin.gigs.length === 1) cardModal.open(pin.gigs[0], markerEl, { render: renderExhibitionModalCard });
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
