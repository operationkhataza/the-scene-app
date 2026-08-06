/* ============================================================
   THE SCENE — SHARED PROFILE SHEET (public app)
   ────────────────────────────────────────────────────────────
   The promoter/curator bottom sheet: fetch, render, and the
   open/close lifecycle. One sheet serves both entity types —
   everything that differs between them lives in PROFILE_KINDS.
   Previously copy-pasted into app.js, calendar.js and map.js
   (~180 lines each) — lifted here so behaviour is one source of
   truth.

   Extraction task: ClickUp "Extract shared gig-card modal module
   in Scene App", filed during the map-view build (Jul 2026).
   ============================================================ */

import { apiGet } from './api.js';
import { esc, isoDate, imgUrl, formatCardDate, formatDateRange, formatTime, resolveGig } from './utils.js';

// Directus curator_type values → the label shown above the name.
// Promoters have no equivalent field, so their cards omit the line.
const CURATOR_TYPE_LABELS = {
  individual: 'Curator',    publication: 'Publication',
  collective: 'Collective', other:       'Curator'
};

export const PROFILE_KINDS = {
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
    'fields':              'id,title,date,doors_time,poster,venue.name,venue.status,ticket_url,'
                          + 'parent_run.id,parent_run.status,parent_run.title,parent_run.poster,'
                          + 'parent_run.ticket_url,parent_run.venue.name,parent_run.venue.status',
    'sort':                'date,doors_time',
    // Raised from 20 to 100 raw nights so a long theatre run can't starve the
    // list before it's collapsed to one row below.
    'limit':                '100'
  });
  // Parent-status guard, same as app.js/calendar.js/map.js: a published night
  // whose parent run is draft/pending must not leak through as a blank row.
  params.set('filter[_or][0][parent_run][_null]', 'true');
  params.set('filter[_or][1][parent_run][status][_eq]', 'published');

  const json = await apiGet('/items/events', params);
  // resolveGig coalesces theatre-run fields (title/poster/ticket_url/venue) onto
  // each night and blanks a pending venue — this sheet used to bypass it and do
  // its own publicVenue call; now shares the same single source as the guide.
  const resolved = (json.data || []).map(resolveGig);

  // Collapse every night of the same production into one row carrying the
  // run's date span, so a 17-night run doesn't fill the whole list. Ordinary
  // (non-run) events pass through untouched.
  const runs = new Map();   // parent_run id -> the merged entry already in `out`
  const out  = [];
  for (const ev of resolved) {
    const runId = (ev.parent_run && typeof ev.parent_run === 'object') ? ev.parent_run.id : null;
    if (runId == null) { out.push(ev); continue; }
    const merged = runs.get(runId);
    if (!merged) {
      const entry = { ...ev, dateStart: ev.date, dateEnd: ev.date, _runId: runId };
      runs.set(runId, entry);
      out.push(entry);
    } else {
      if (ev.date < merged.dateStart) merged.dateStart = ev.date;
      if (ev.date > merged.dateEnd)   merged.dateEnd   = ev.date;
    }
  }
  out.sort((a, b) => (a.dateStart || a.date || '').localeCompare(b.dateStart || b.date || ''));
  return out.slice(0, 20);
}

function renderProfile(kind, entity, events) {
  const cfg = PROFILE_KINDS[kind];

  // Avatar — image or initial placeholder
  const avatarImg = cfg.avatar(entity);
  const avatarSrc = avatarImg
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

  const bioHtml = entity.bio
    ? `<p class="profile-sheet__bio">${esc(entity.bio)}</p>`
    : '';

  const websiteHtml = entity.website
    ? `<a class="profile-sheet__website" href="${esc(entity.website)}" target="_blank" rel="noopener noreferrer">Visit website ↗</a>`
    : '';

  // social_links key casing differs by collection — promoters store
  // Platforms/URL, curators store platform/url — so read both.
  // Map stored values back to display labels (stored as lowercase slugs)
  const PLATFORM_LABELS = {
    instagram: 'Instagram', facebook: 'Facebook',
    x: 'X', youtube: 'YouTube', tiktok: 'TikTok',
    soundcloud: 'SoundCloud', spotify: 'Spotify', bandcamp: 'Bandcamp'
  };
  const socials = Array.isArray(entity.social_links) ? entity.social_links : [];
  const socialHtml = socials.length > 0
    ? `<div class="profile-sheet__socials">
        ${socials.map(s => {
          const rawPlatform = s.Platforms || s.platform || '';
          const url         = s.URL      || s.url      || '';
          if (!url) return '';
          const label = PLATFORM_LABELS[rawPlatform.toLowerCase()]
            || (rawPlatform.charAt(0).toUpperCase() + rawPlatform.slice(1))
            || url;
          return `<a class="profile-sheet__social-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
        }).filter(Boolean).join('')}
      </div>`
    : '';

  // Upcoming events list — each item is a thumbnail + text row
  const eventsHtml = events.length > 0
    ? `<div class="profile-sheet__events">
        <p class="profile-sheet__events-title">Upcoming Events</p>
        <ul class="profile-sheet__event-list">
          ${events.map(ev => {
            // A collapsed theatre run (see fetchProfileEvents) shows its date span
            // instead of a single date + time — it has neither one true date nor
            // a single doors_time across all its nights.
            const meta = ev._runId != null
              ? [formatDateRange(ev.dateStart, ev.dateEnd), ev.venue?.name].filter(Boolean).join(' · ')
              : [formatCardDate(ev.date), formatTime(ev.doors_time), ev.venue?.name].filter(Boolean).join(' · ');
            const thumbSrc = ev.poster ? imgUrl(ev.poster, { width: '144', fit: 'contain' }) : null;
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

/* createProfileSheet({ sheet, backdrop, title, body, onOpen })
   → { open(kind, id), close() }

   onOpen(kind) — called right before the sheet opens. The gig guide
   uses this to keep its own state.activeSheetContent in sync, since
   it reuses its filter sheet's elements for this rather than a
   dedicated pair — and for the same reason keeps its own close path
   (the filter/profile footer-jump handling) rather than calling
   close() here. calendar.js and map.js, which have a dedicated
   #profile-sheet, use both open() and close() as-is. */
export function createProfileSheet({ sheet, backdrop, title, body, onOpen }) {
  async function open(kind, id) {
    const cfg = PROFILE_KINDS[kind];
    if (!cfg) return;

    if (onOpen) onOpen(kind);

    // data-mode drives the accent: green for promoter, cyan for curator.
    sheet.setAttribute('data-mode', kind);

    // Open immediately with a skeleton so the sheet feels instant.
    title.textContent = 'Loading…';
    body.innerHTML     = `<div class="profile-sheet__loading"><div class="spinner"></div></div>`;
    sheet.classList.add('is-open');
    backdrop.classList.add('is-open');
    document.body.style.overflow = 'hidden';

    // Tier 1 — entity metadata (fatal: nothing to show without this)
    let entity;
    try {
      entity = await fetchProfile(kind, id);
    } catch (err) {
      console.error(`[Scene] fetchProfile(${kind}) failed:`, err);
      body.innerHTML    = `<div class="state" style="padding: 2rem 1rem;"><p class="state__text">${cfg.errorText}</p></div>`;
      title.textContent = cfg.label;
      return;
    }

    title.textContent = entity.name;

    // Tier 2 — upcoming events (non-fatal: sheet still renders without them)
    let events = [];
    try {
      events = await fetchProfileEvents(kind, id);
    } catch (err) {
      console.warn(`[Scene] fetchProfileEvents(${kind}) failed — rendering without events list:`, err);
    }

    body.innerHTML = renderProfile(kind, entity, events);
  }

  function close() {
    sheet.classList.remove('is-open');
    backdrop.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  return { open, close };
}
