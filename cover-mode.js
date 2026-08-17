/* ============================================================
   THE SCENE — COVER MODE
   ────────────────────────────────────────────────────────────
   Shared by calendar.js and app.js: turns a promoter/curator's
   cover_image into the whole-page fixed background (body.has-cover-bg,
   styles.css), with the header becoming frosted glass over it
   (.gigs-header--cover).

   Text colour and framing are both editor-set in Scene Studio, not
   computed from the image — cover_text_tone and cover_focal, read by
   the caller from the promoter/curator record and passed straight
   through here. See docs/decisions.md for why (a computed approach
   was tried first and dropped).
   ============================================================ */

import { imgUrl } from './utils.js';

/* Minimum box the cover image must fill, in CSS pixels. The background
   sits under a white veil (body.has-cover-bg::before) and behind the
   header's own frosted glass, so it doesn't need full device-pixel
   sharpness — capped well below what a naive DPR × screen-size request
   would ask for, since fit=outside (below) can't crop to compensate. */
export function getCoverBoxDims() {
  const CAP = 1800;
  return {
    width:  String(Math.min(Math.round(window.innerWidth  * 1.5), CAP)),
    height: String(Math.min(Math.round(window.innerHeight * 1.5), CAP))
  };
}

/* fileId: cover_image UUID, or null/undefined — no cover, nothing to do.
   tone:   'light' | 'dark' | null/undefined — cover_text_tone. Anything
           other than 'light' leaves the default (dark text) CSS tier in
           place; there is no 'light' class to remove because none is
           ever added except this one attribute.
   focal:  { x, y } percentages, or null/undefined — cover_focal. Missing
           or malformed defaults to centred (50% 50%), today's behaviour.
   headerEl: the header element to turn into the frosted-glass panel
           (.gigs-header on the gig guide, .calendar-header on the
           calendar).

   Returns a Promise that resolves once the background image has loaded
   (or failed to) — callers gate their loading-reveal on this so the
   artwork is actually painted by the time the page is shown, not still
   fetching behind a background-image that hasn't arrived yet. Resolves
   immediately when there's no cover to load. */
export function applyCoverMode(fileId, tone, focal, headerEl) {
  if (!fileId) return Promise.resolve();

  const { width, height } = getCoverBoxDims();
  const url = imgUrl(fileId, { width, height, fit: 'outside', withoutEnlargement: 'true' });

  document.body.style.setProperty('--cover-image', `url("${url}")`);
  const hasFocal = focal && typeof focal.x === 'number' && typeof focal.y === 'number';
  document.body.style.setProperty('--cover-focal', hasFocal ? `${focal.x}% ${focal.y}%` : '50% 50%');
  document.body.classList.add('has-cover-bg');
  if (headerEl) headerEl.classList.add('gigs-header--cover');

  if (tone === 'light') {
    document.body.setAttribute('data-cover-text', 'light');
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      // decode() lets the browser finish the (potentially large) bitmap
      // decode off the paint path before we tell the caller it's safe to
      // reveal — without it, "loaded" can fire before the pixels are
      // actually ready to paint, reintroducing a smaller version of the
      // flash this whole mechanism exists to remove.
      if (img.decode) img.decode().then(resolve).catch(resolve);
      else resolve();
    };
    img.onerror = () => resolve(); // a broken image must never block the reveal
    img.src = url;
  });
}
