/* ============================================================
   THE SCENE: COVER MODE
   ────────────────────────────────────────────────────────────
   Shared by calendar.js and app.js: turns a promoter/curator's
   cover_image into the whole-page fixed background (body.has-cover-bg,
   styles.css), with the header becoming frosted glass over it
   (.gigs-header--cover).

   Text colour and framing are both editor-set in Scene Studio, not
   computed from the image: cover_text_tone and cover_focal, read by
   the caller from the promoter/curator record and passed straight
   through here. See docs/decisions.md for why (a computed approach
   was tried first and dropped).
   ============================================================ */

import { imgUrl } from './utils.js';

/* Minimum box the cover image must fill, in CSS pixels. The background
   sits under a white veil (body.has-cover-bg::before) and behind the
   header's own frosted glass, so it doesn't need full device-pixel
   sharpness, capped well below what a naive DPR x screen-size request
   would ask for, since fit=outside (below) can't crop to compensate. */
export function getCoverBoxDims() {
  const CAP = 1800;
  const FLOOR = 320;
  // window.innerWidth/innerHeight can read 0 in a webview that hasn't finished
  // laying out yet. Observed live on a cold load: the app requested
  // width=0&height=0, and Directus answers a zero-dimension transform with a
  // JSON error rather than an image, so the cover silently never appeared and
  // the preload below resolved via onerror. Fall back through clientWidth to a
  // phone-sized default, and floor the result so a small-but-nonzero reading
  // can't ask for a postage stamp either.
  const vw = window.innerWidth  || document.documentElement.clientWidth  || 390;
  const vh = window.innerHeight || document.documentElement.clientHeight || 844;
  return {
    width:  String(Math.max(FLOOR, Math.min(Math.round(vw * 1.5), CAP))),
    height: String(Math.max(FLOOR, Math.min(Math.round(vh * 1.5), CAP)))
  };
}

/* fileId: cover_image UUID, or null/undefined: no cover, nothing to do.
   tone:   'light' | 'dark' | null/undefined: cover_text_tone. Anything
           other than 'light' leaves the default (dark text) CSS tier in
           place; there is no 'light' class to remove because none is
           ever added except this one attribute.
   focal:  { x, y } percentages, or null/undefined: cover_focal. Missing
           or malformed defaults to centred (50% 50%), today's behaviour.
   headerEl: the header element to turn into the frosted-glass panel
           (.gigs-header on the gig guide, .calendar-header on the
           calendar).

   Returns a Promise that resolves once the background image has loaded
   (or failed to); callers gate their loading-reveal on this so the
   artwork is actually painted by the time the page is shown, not still
   fetching behind a background-image that hasn't arrived yet. Resolves
   immediately when there's no cover to load. */
export function applyCoverMode(fileId, tone, focal, headerEl) {
  if (!fileId) return Promise.resolve();

  const { width, height } = getCoverBoxDims();
  const url = imgUrl(fileId, { width, height, fit: 'outside', withoutEnlargement: 'true' });

  // The custom properties are inert until has-cover-bg switches the layer on,
  // so they are safe to set immediately.
  document.body.style.setProperty('--cover-image', `url("${url}")`);
  const hasFocal = focal && typeof focal.x === 'number' && typeof focal.y === 'number';
  document.body.style.setProperty('--cover-focal', hasFocal ? `${focal.x}% ${focal.y}%` : '50% 50%');

  return new Promise((resolve) => {
    const img = new Image();

    // Switch the page over only once the bytes are actually here. Adding
    // has-cover-bg up front painted the veil gradient over an empty layer while
    // the image was still downloading, which is the flash this whole mechanism
    // exists to avoid, and it meant the page background had to be flattened
    // during the loading hold to compensate. Deferring it lets the normal
    // iridescent background stay up while a promoter/curator view loads, so a
    // slow load looks like the app loading rather than a broken page.
    const engage = () => {
      document.body.classList.add('has-cover-bg');
      if (headerEl) headerEl.classList.add('gigs-header--cover');
      if (tone === 'light') document.body.setAttribute('data-cover-text', 'light');
      resolve();
    };

    img.onload = () => {
      // decode() finishes the bitmap decode off the paint path, so "loaded"
      // can't fire before the pixels are genuinely ready to paint.
      if (img.decode) img.decode().then(engage, engage);
      else engage();
    };
    // A cover that fails to load leaves the plain identity card standing, which
    // is the right fallback. It must never block the reveal either.
    img.onerror = () => resolve();
    img.src = url;
  });
}
