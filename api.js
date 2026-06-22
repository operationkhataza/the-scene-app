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
