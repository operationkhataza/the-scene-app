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
   one event OR one whole theatre run featured for one week) and returns
   the targets featured RIGHT NOW: status=active AND the current moment
   falls inside [week_start, week_end]. Expiry is therefore read-time — a
   slot whose week has passed simply stops matching, so no cron is needed
   to "unfeature" anything.

   Returns a mix of RAW event objects (each caller runs its own
   resolveGig() for theatre coalescing) and gig-like RUN items
   (makeRunItem() — flagged `_isFeaturedRun`, carrying a `dateRange`;
   resolveGig passes them through untouched). Kept DOM/state-free.
   `description` is requested eagerly (few rows) so the calendar modal
   needs no lazy hydrate for these. ============================================================ */
const FEATURED_EVENT_SUBFIELDS = [
  'id', 'title', 'slug', 'date', 'doors_time',
  'short_description', 'description', 'ticket_url', 'poster',
  'is_free', 'ticket_tiers', 'age_restriction', 'tags',
  'venue.name', 'venue.location', 'venue.status',
  'event_category.id', 'event_category.name', 'event_category.slug',
  'artists.artists_id.name',
  'curators.curators_id.name', 'curators.curators_id.logo',
  'promoters.promoters_id.id', 'promoters.promoters_id.name', 'promoters.promoters_id.profile_image',
  // Theatre parent run — production-wide fields a night inherits (resolveGig coalesces).
  'parent_run.id', 'parent_run.status', 'parent_run.title', 'parent_run.slug',
  'parent_run.short_description', 'parent_run.description', 'parent_run.ticket_url',
  'parent_run.poster', 'parent_run.is_free', 'parent_run.ticket_tiers',
  'parent_run.age_restriction', 'parent_run.tags',
  'parent_run.venue.name', 'parent_run.venue.location', 'parent_run.venue.status',
];

/* Production-wide fields for a featured theatre RUN (the parent). A run-only
   slot carries these on `theatre_run` instead of an `event`; makeRunItem()
   reshapes them into a gig-like object so the carousel renderers stay uniform. */
const FEATURED_RUN_SUBFIELDS = [
  'id', 'status', 'title', 'slug', 'short_description', 'description',
  'ticket_url', 'poster', 'is_free', 'ticket_tiers', 'age_restriction', 'tags',
  'venue.name', 'venue.location', 'venue.status',
];

/* A featured theatre run reshaped to look like a resolved gig, so both
   renderFeaturedCard() and the calendar modal can consume it unchanged.
   `id` is a "run:<n>" string (never collides with a numeric event id);
   `dateRange` is filled in by attachRunDateRanges() once the nights load. */
function makeRunItem(run) {
  return {
    id: 'run:' + run.id,
    _isFeaturedRun: true,
    _runId: run.id,
    title: run.title,
    slug: run.slug,
    short_description: run.short_description,
    description: run.description,
    poster: run.poster,
    ticket_url: run.ticket_url,
    is_free: run.is_free,
    ticket_tiers: run.ticket_tiers,
    age_restriction: run.age_restriction,
    tags: run.tags,
    venue: run.venue,
    dateRange: '',
  };
}

/* Format a run's performance dates into one short label: "Runs 12-28 Jul" (same
   month), "Runs 28 Jul - 3 Aug" (spanning months), or just "5 Jul" for a single
   performance. Prefers upcoming nights; falls back to the full span if they've
   all passed. */
function fmtRunDates(dates) {
  const sorted = [...dates].filter(Boolean).sort();
  if (!sorted.length) return '';
  const todayIso = new Date().toISOString().slice(0, 10);
  const upcoming = sorted.filter(d => d >= todayIso);
  const use   = upcoming.length ? upcoming : sorted;
  const first = use[0], last = use[use.length - 1];
  const opts  = { day: 'numeric', month: 'short' };
  const d0 = new Date(first + 'T00:00:00');
  const d1 = new Date(last  + 'T00:00:00');
  if (first === last) return d0.toLocaleDateString('en-ZA', opts);
  const sameMonth = d0.getMonth() === d1.getMonth() && d0.getFullYear() === d1.getFullYear();
  const range = sameMonth
    ? `${d0.getDate()}-${d1.toLocaleDateString('en-ZA', opts)}`
    : `${d0.toLocaleDateString('en-ZA', opts)} - ${d1.toLocaleDateString('en-ZA', opts)}`;
  return `Runs ${range}`;
}

/* One extra query for all featured runs at once: pull their published nights and
   attach a formatted `dateRange` to each run item in place. Mirrors how the
   Studio theatre dashboard reads nights by parent_run (no reverse alias needed). */
async function attachRunDateRanges(runItems) {
  const ids = runItems.map(r => r._runId);
  if (!ids.length) return;
  let nights = [];
  try {
    const json = await apiGet('/items/events', {
      'filter[parent_run][_in]': ids.join(','),
      'filter[status][_eq]': 'published',
      'fields': 'date,parent_run',
      'sort': 'date',
      'limit': '500',
    });
    nights = json.data || [];
  } catch (err) {
    console.warn('[Scene] featured run dates failed (cards show no range):', err);
    return;
  }
  const byRun = new Map();
  for (const n of nights) {
    const pid = (n.parent_run && typeof n.parent_run === 'object') ? n.parent_run.id : n.parent_run;
    if (pid == null || !n.date) continue;
    if (!byRun.has(pid)) byRun.set(pid, []);
    byRun.get(pid).push(n.date);
  }
  for (const item of runItems) item.dateRange = fmtRunDates(byRun.get(item._runId) || []);
}

/* Returns the items to spotlight RIGHT NOW (status=active AND now inside the
   slot's week). A slot points at either an `event` (returned as-is; the caller
   runs resolveGig) or a whole `theatre_run` (returned as a gig-like run item via
   makeRunItem, with `_isFeaturedRun` + a `dateRange`). Order follows slot `sort`.
   Unpublished targets read back as null (public policy) and are dropped. */
export async function fetchFeatured() {
  const nowIso = new Date().toISOString();
  const fields = [
    'id', 'sort', 'week_start', 'week_end',
    ...FEATURED_EVENT_SUBFIELDS.map(f => `event.${f}`),
    ...FEATURED_RUN_SUBFIELDS.map(f => `theatre_run.${f}`),
  ].join(',');

  // NOTE: no `filter[event][status]` here — that nested filter would drop every
  // run-only slot (null event). Published-only is enforced by the public policy
  // (unpublished targets read back as null) + the branch checks below.
  const params = new URLSearchParams({
    'filter[status][_eq]':      'active',
    'filter[week_start][_lte]': nowIso,
    'filter[week_end][_gte]':   nowIso,
    'fields': fields,
    'sort':   'sort',
    'limit':  '12',
  });

  try {
    const json  = await apiGet('/items/featured_slots', params);
    const slots = json.data || [];
    const items = [];
    const runItems = [];
    for (const s of slots) {
      if (s.event) {
        items.push(s.event);                          // caller runs resolveGig
      } else if (s.theatre_run && typeof s.theatre_run === 'object') {
        const runItem = makeRunItem(s.theatre_run);
        items.push(runItem);
        runItems.push(runItem);
      }
    }
    await attachRunDateRanges(runItems);              // fills dateRange in place
    return items;
  } catch (err) {
    console.warn('[Scene] featured fetch failed (carousel hidden):', err);
    return [];
  }
}
