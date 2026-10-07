/* ============================================================
   THE SCENE: SHARE AN EVENT (public app)
   ────────────────────────────────────────────────────────────
   The Share button on a gig card's back face. A shared link points
   at the marketing site's event page, thescenecapetown.co.za/event/<id>
   (Scene Website/event.html), which anyone can open without the app
   and which carries a "get the app" banner.

   Three paths, chosen at tap time:
     - navigator.share exists (iOS webview, most mobile browsers):
       open the phone's own share menu directly. It already lists
       WhatsApp and Copy, so our panel would only add a tap.
     - Android's WebView (every Android user inside the Fabrik app; it
       never implements navigator.share): copy the message at once and
       confirm it in a small panel on the card's back face. No WhatsApp
       option here, see IN_ANDROID_WEBVIEW below for why it dead-ends.
     - anything else without a share menu (e.g. some desktop browsers):
       the panel offers WhatsApp (a wa.me click-to-chat link) and Copy.

   Links use the event's numeric id, never its slug: slugs repeat for
   recurring nights and theatre-run nights borrow their run's.

   shareData() is pure and is called by renderGigCard() (gig-card.js).
   wireShare() installs one document-level click listener, idempotent,
   called by both card surfaces in card-modal.js (createCardModal and
   attachCardFlip), whose flip handlers exempt the share controls so a
   tap on them never flips the card.
   ============================================================ */

import { esc, formatTime } from './utils.js';
import { ICONS } from './icons.js';

const SITE = 'https://thescenecapetown.co.za';

/* "Thursday 8 October": no comma or leading zero, unlike en-ZA's
   built-in long format, so it reads naturally inside a sentence. */
function sentenceDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const weekday = d.toLocaleDateString('en-ZA', { weekday: 'long' });
  const month   = d.toLocaleDateString('en-ZA', { month: 'long' });
  return `${weekday} ${d.getDate()} ${month}`;
}

function priceSentence(gig) {
  if (gig.is_free) return 'Entry is free.';
  const prices = (Array.isArray(gig.ticket_tiers) ? gig.ticket_tiers : [])
    .map(t => parseFloat(t.price))
    .filter(p => !isNaN(p) && p > 0);
  if (!prices.length) return '';
  const low = Math.min(...prices);
  return prices.length > 1 ? `Tickets start at R${low}.` : `Tickets are R${low}.`;
}

/* → { url, text } for a card, or null when there's no event page to link
   to (a featured whole run whose nights haven't been resolved yet). A
   featured run links to its next upcoming night (shareEventId, set by
   attachRunDateRanges in api.js); the event page coalesces the run's
   title/poster/tickets onto that night. */
export function shareData(gig) {
  const id = gig._isFeaturedRun ? gig.shareEventId : gig.id;
  if (!/^\d+$/.test(String(id ?? ''))) return null;

  const url = `${SITE}/event/${id}`;
  // WhatsApp renders *text* as bold; a stray asterisk in a title would
  // break the pair, so strip them from the title first.
  const title = String(gig.title || '').replace(/\*/g, '').trim();

  let line = `Hey, I found this on The Scene Cape Town: *${title}*`;
  if (gig.venue?.name) line += ` at ${gig.venue.name}`;
  if (gig._isFeaturedRun) {
    if (gig.dateRange) line += `, ${gig.dateRange.replace(/^Runs\b/, 'running')}`;
  } else {
    if (gig.date) line += `, ${sentenceDate(gig.date)}`;
    const time = formatTime(gig.doors_time);
    if (time) line += `, doors ${time}`;
  }
  line += '.';

  return { url, text: [line, priceSentence(gig), url].filter(Boolean).join('\n') };
}

/* Clipboard API first, then the execCommand fallback for webviews that
   don't expose it (same pattern as event-submission.html's copy button). */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/* Android's System WebView (what the Fabrik app runs us in on Android) tags
   its user agent with "; wv)". Inside it a wa.me link is a dead end: wa.me
   immediately hands off to WhatsApp's app link, and the WebView only follows
   that if the host app passes it to the OS, which Fabrik doesn't, so the user
   lands on an error page (confirmed on-device 7 Oct 2026). Ticket links work
   there only because they're ordinary web pages. So in this one environment
   the panel never offers WhatsApp: Share copies the message straight away. */
const IN_ANDROID_WEBVIEW = /Android/i.test(navigator.userAgent) && /\bwv\b/.test(navigator.userAgent);

/* Panel modes (CSS shows/hides the controls per data-mode):
     choose: WhatsApp + Copy message + Cancel (browsers without a share menu)
     copied: confirmation after an automatic copy + Done
     manual: copying failed, so the message sits in a read-only box to press-and-hold + Done */
const PANEL_TITLES = {
  choose: 'Share this event',
  copied: 'Message copied',
  manual: 'Copy this message',
};

function closePanel(panel) {
  if (panel) panel.hidden = true;
}

function showPanel(panel, mode) {
  panel.dataset.mode = mode;
  panel.querySelector('.share-panel__title').textContent = PANEL_TITLES[mode];
  panel.querySelector('.share-panel__cancel').textContent = mode === 'choose' ? 'Cancel' : 'Done';
  panel.hidden = false;
  if (mode === 'choose') panel.querySelector('.share-panel__wa')?.focus();
  else panel.querySelector('.share-panel__cancel')?.focus();
}

let wired = false;

export function wireShare() {
  if (wired) return;
  wired = true;

  document.addEventListener('click', async e => {
    const openBtn = e.target.closest('.gig-card__share');
    if (openBtn) {
      const text = openBtn.dataset.shareText;
      if (navigator.share) {
        try {
          await navigator.share({ text });
          return;
        } catch (err) {
          // The user closing the share menu is not a failure.
          if (err && err.name === 'AbortError') return;
          // Anything else (e.g. the host app refusing it): fall back to our panel.
        }
      }
      const panel = openBtn.closest('.gig-card__back')?.querySelector('.share-panel');
      if (!panel) return;
      if (IN_ANDROID_WEBVIEW) {
        showPanel(panel, (await copyText(text)) ? 'copied' : 'manual');
      } else {
        showPanel(panel, 'choose');
      }
      return;
    }

    const panel = e.target.closest('.share-panel');
    if (!panel) return;

    if (e.target.closest('.share-panel__cancel')) {
      closePanel(panel);
      return;
    }

    if (e.target.closest('.share-panel__wa')) {
      // The link itself opens WhatsApp; just tidy the panel away behind it.
      setTimeout(() => closePanel(panel), 300);
      return;
    }

    if (e.target.closest('.share-panel__copy')) {
      showPanel(panel, (await copyText(panel.dataset.shareText)) ? 'copied' : 'manual');
    }
  });
}

/* Markup for the back face: the Share button (sits in the back-actions
   row) and its fallback panel (an overlay inside .gig-card__back, never a
   direct child of .gig-card; see docs/gig-guide.md's Lessons on the
   `.gig-card[data-curated] > *` trap). Returns empty strings when the card
   has nothing to link to. */
export function shareMarkup(gig) {
  const data = shareData(gig);
  if (!data) return { button: '', panel: '' };
  const text = esc(data.text);
  const waHref = esc(`https://wa.me/?text=${encodeURIComponent(data.text)}`);
  return {
    button: `<button type="button" class="gig-card__share" aria-label="Share this event" data-share-text="${text}">${ICONS.share}</button>`,
    panel: `
      <div class="share-panel" hidden data-mode="choose" data-share-text="${text}">
        <p class="share-panel__title">Share this event</p>
        <p class="share-panel__note share-panel__note--copied">Paste it into WhatsApp or any chat.</p>
        <textarea class="share-panel__text" readonly rows="5" aria-label="Message to share">${text}</textarea>
        <p class="share-panel__note share-panel__note--manual">Press and hold the text to copy it.</p>
        <a class="share-panel__wa" href="${waHref}" target="_blank" rel="noopener noreferrer">Send on WhatsApp</a>
        <button type="button" class="share-panel__copy">Copy message</button>
        <button type="button" class="share-panel__cancel">Cancel</button>
      </div>`,
  };
}
