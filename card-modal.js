/* ============================================================
   THE SCENE — SHARED CARD MODAL CONTROLLER (public app)
   ────────────────────────────────────────────────────────────
   The hero-expand modal (open/close, the holo-shader mount, the
   outside-tap/Escape close, and the flip delegation) for the gig
   guide's featured-carousel modal, the calendar's day-panel and
   featured modals, and the map's pin/venue-sheet modal. Previously
   copy-pasted three times (plus a fourth hand-rolled variant for
   map.js's exhibition modal) and had started to drift — lifted
   here so behaviour is one source of truth.

   Extraction task: ClickUp "Extract shared gig-card modal module
   in Scene App", filed during the map-view build (Jul 2026).
   ============================================================ */

/* createCardModal({ modal, card, render, blockedBy, onProfilePill, onOpen })
   → { open(item, originEl, opts), close(), get activeItem() }

   modal / card    — the #cal-modal / #cal-modal-card elements (shared
                      across all uses on a page, including exhibitions).
   render          — default render(item) → HTML string. Overridable
                      per-open via opts.render (map.js's exhibition
                      modal reuses the same modal for a second entity
                      type this way).
   blockedBy       — sheet elements that must all be closed before
                      Escape closes this modal (a stacked sheet closes
                      itself first, on its own Escape handler).
   onProfilePill   — (kind, id) called when a promoter/curator pill
                      inside the card is tapped. Omit to skip wiring
                      the listener (the card never renders pills). */
export function createCardModal({ modal, card, render, blockedBy = [], onProfilePill, onOpen }) {
  let activeItem = null;

  /* Open the modal, animating from the origin of the tapped element
     (a card, pin, or chooser row; null centres it). */
  function open(item, originEl, opts = {}) {
    const renderFn = opts.render || render;

    if (originEl) {
      const rect   = originEl.getBoundingClientRect();
      const vw     = window.innerWidth;
      const vh     = window.innerHeight;
      const cardCX = rect.left + rect.width  / 2;
      const cardCY = rect.top  + rect.height / 2;
      const ox = Math.round((cardCX / vw) * 100);
      const oy = Math.round((cardCY / vh) * 100);
      card.style.setProperty('--origin-x', `${ox}%`);
      card.style.setProperty('--origin-y', `${oy}%`);
    } else {
      card.style.setProperty('--origin-x', '50%');
      card.style.setProperty('--origin-y', '50%');
    }

    card.innerHTML = renderFn(item);
    modal.classList.remove('is-closing');
    modal.classList.add('is-open');

    // Mount holographic shader on tier-3 cards. Two rAF ticks so the modal
    // is fully painted and getBoundingClientRect() returns real dimensions
    // before the canvas is sized and the first frame is drawn. A card with
    // no data-curated="3" (e.g. an exhibition) simply matches nothing —
    // refresh()/forceRender() are no-ops in that case.
    if (window.HoloShader) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.HoloShader.refresh();
        window.HoloShader.forceRender();
      }));
    }

    // Stored so the flip handler — and any onOpen race guard, e.g.
    // calendar's description hydration — can check whether the user has
    // since moved on to a different item.
    activeItem = item;
    if (onOpen) onOpen(item);
  }

  function close() {
    if (!modal.classList.contains('is-open')) return;
    modal.classList.add('is-closing');
    modal.classList.remove('is-open');

    setTimeout(() => {
      if (!modal.classList.contains('is-open')) {
        // Refresh shader to tear down any canvas on the departing card
        // before we wipe the HTML, so the Map/observer don't hold stale refs.
        if (window.HoloShader) window.HoloShader.refresh();
        card.innerHTML = '';
        modal.classList.remove('is-closing');
      }
    }, 160);
  }

  // Close when tapping outside the card (capture phase, before the flip handler).
  card.addEventListener('click', e => {
    if (!modal.classList.contains('is-open')) return;
    if (!e.target.closest('.gig-card')) close();
  }, true);

  // Close on Escape — but not while a stacked sheet (filters, a promoter/
  // curator profile, or a venue chooser) is open on top of it; that closes
  // first on its own Escape handler.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (blockedBy.some(el => el && el.classList.contains('is-open'))) return;
    close();
  });

  // Flip delegation — wired once on the card container.
  card.addEventListener('click', e => {
    if (!modal.classList.contains('is-open')) return;

    // Dismiss button sits on the card shell (both faces) and closes the
    // modal outright — checked before the flip exemptions below.
    if (e.target.closest('.gig-card__dismiss')) {
      e.stopPropagation();
      close();
      return;
    }

    if (e.target.closest('.gig-card__back-cta'))   return;
    if (e.target.closest('.gig-card__ticket-pill')) return;
    if (e.target.closest('[data-profile-kind]'))    return;  // promoter + curator pills

    const inner    = card.querySelector('.gig-card__inner');
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
      // Flips unconditionally — an empty back face just shows "No
      // description added yet." rather than staying inert.
      inner.classList.add('is-flipped');
    }
  });

  // Promoter / curator pill inside the modal card.
  if (onProfilePill) {
    card.addEventListener('click', e => {
      const pill = e.target.closest('[data-profile-kind][data-profile-id]');
      if (!pill) return;
      e.stopPropagation();
      onProfilePill(pill.dataset.profileKind, Number(pill.dataset.profileId));
    });
  }

  return {
    open,
    close,
    get activeItem() { return activeItem; },
  };
}

/* ============================================================
   FEED CARD FLIP — delegated flip for a static list of gig cards
   (the gig guide's feed). Cards are rebuilt via innerHTML on every
   filter/search change, so a single delegated listener on the list
   container survives every re-render rather than needing rebinding
   per card. No dismiss button on this surface — there's nothing to
   close, the user just scrolls away.
   ============================================================ */
export function attachCardFlip(host) {
  host.addEventListener('click', e => {
    if (e.target.closest('.gig-card__ticket-pill')) return;
    if (e.target.closest('.gig-card__back-cta'))    return;
    if (e.target.closest('[data-profile-kind]'))    return;  // promoter + curator pills

    const closeBtn = e.target.closest('.gig-card__back-return');
    if (closeBtn) {
      const inner = closeBtn.closest('.gig-card__inner');
      if (inner) inner.classList.remove('is-flipped');
      return;
    }

    const inner = e.target.closest('.gig-card__inner');
    if (!inner || inner.classList.contains('is-flipped')) return;
    inner.classList.add('is-flipped');
  });
}
