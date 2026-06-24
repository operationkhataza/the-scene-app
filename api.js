/* ============================================================
   THE SCENE — SHARED API (public, read-only)
   ────────────────────────────────────────────────────────────
   Minimal fetch wrapper for the public Scene App (gig guide +
   calendar). No auth, no token, no refresh — the public surface
   is anonymous by design. Do NOT copy Scene Studio's bearer-token
   / 401-refresh machinery here; that's the operator tool's job.
   ============================================================ */

export const API = 'https://api.thescenecapetown.co.za';

/* apiGet(path, params)
   Removes the repeated `fetch → check res.ok → throw → res.json()`
   boilerplate. Returns the FULL Directus envelope ({ data, meta })
   so callers that need `meta` (e.g. the calendar's filter_count
   pagination) still get it; most callers just read `.data`.

   `params` accepts a plain object OR an already-built URLSearchParams
   / query string, so call sites that build complex Directus filter
   keys (e.g. filter[promoters][promoters_id][_eq]) pass their existing
   params unchanged. */
export async function apiGet(path, params) {
  let qs = '';
  if (params instanceof URLSearchParams) qs = params.toString();
  else if (typeof params === 'string')   qs = params;
  else if (params && typeof params === 'object') {
    const u = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v != null && u.set(k, v));
    qs = u.toString();
  }
  const res = await fetch(`${API}${path}${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json(); // full envelope: { data, meta }
}

/* ============================================================
   FEATURED EVENTS — the paid/curated spotlight carousel
   ────────────────────────────────────────────────────────────
   One source for both surfaces. Reads `featured_slots` (one row =
   one event featured for one week) and returns the expanded event
   objects that are featured RIGHT NOW: status=active AND the current
   moment falls inside [week_start, week_end]. Expiry is therefore
   read-time — a slot whose week has passed simply stops matching, so
   no cron is needed to "unfeature" anything.

   Returns RAW event objects (not slots). Each caller runs its own
   resolveGig() for theatre coalescing — kept out of here so this stays
   DOM/state-free. `description` is requested eagerly (only a handful of
   events) so the calendar modal needs no lazy hydrate for these.
   ============================================================ */
const FEATURED_EVENT_SUBFIELDS = [
  'id', 'title', 'slug', 'date', 'doors_time',
  'short_description', 'description', 'ticket_url', 'poster',
  'is_free', 'ticket_tiers', 'age_restriction', 'tags',
  'venue.name', 'venue.location',
  'event_category.id', 'event_category.name', 'event_category.slug',
  'artists.artists_id.name',
  'curators.curators_id.name', 'curators.curators_id.logo',
  'promoters.promoters_id.id', 'promoters.promoters_id.name', 'promoters.promoters_id.profile_image',
  // Theatre parent run — production-wide fields a night inherits (resolveGig coalesces).
  'parent_run.id', 'parent_run.status', 'parent_run.title', 'parent_run.slug',
  'parent_run.short_description', 'parent_run.description', 'parent_run.ticket_url',
  'parent_run.poster', 'parent_run.is_free', 'parent_run.ticket_tiers',
  'parent_run.age_restriction', 'parent_run.tags',
  'parent_run.venue.name', 'parent_run.venue.location',
];

export async function fetchFeatured() {
  const nowIso = new Date().toISOString();
  const fields = ['id', 'sort', 'week_start', 'week_end',
    ...FEATURED_EVENT_SUBFIELDS.map(f => `event.${f}`)].join(',');

  const params = new URLSearchParams({
    'filter[status][_eq]':      'active',
    'filter[week_start][_lte]': nowIso,
    'filter[week_end][_gte]':   nowIso,
    'filter[event][status][_eq]': 'published', // never spotlight a hidden event
    'fields': fields,
    'sort':   'sort',
    'limit':  '12',
  });

  try {
    const json = await apiGet('/items/featured_slots', params);
    // Map slots → their event; drop any slot whose event the public can't read
    // (e.g. unpublished) — Directus returns those nested objects as null.
    return (json.data || []).map(s => s.event).filter(Boolean);
  } catch (err) {
    console.warn('[Scene] featured fetch failed (carousel hidden):', err);
    return [];
  }
}
