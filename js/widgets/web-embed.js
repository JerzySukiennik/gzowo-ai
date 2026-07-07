// js/widgets/web-embed.js — WEB widget + web tools (embed / YouTube / fetch).
//
// Two capabilities for the assistant:
//   (a) EMBED a web page or YouTube video as a widget in the Showing state.
//   (b) FETCH a page's text so the model can read/summarize it out loud.
//
// Sites that refuse iframing get an HONEST fallback panel — never a white lie.
//
// Contracts honored:
//   - export async function init()  — idempotent, NEVER throws; registers the
//     'web' widget factory + three tools on the shared toolRouter.
//   - Handlers return the REAL result object (toolRouter sends it verbatim to the
//     Gemini model), so the model can only claim a success the result confirms.
//
// B&W law: the widget's own chrome (address strip, loading cover, block panel)
// is strict grayscale from design tokens. The ONLY exempt surface is the <iframe>
// body — that is external content, like widget color, and we don't control it.

import { defineWidget, el } from './widget-base.js';
import { layout } from '../core/layout-engine.js';
import { toolRouter } from '../core/tool-router.js';
import { bridgeClient } from '../bridge-client.js';

const CONFIG = window.GZOWO_CONFIG || {};

// How long to wait for a frame's `load` before assuming the site blocks embedding.
const BLOCK_TIMEOUT_MS = 6000;
// Timebox for the deployed-Worker /fetch path.
const WORKER_FETCH_TIMEOUT_MS = 12000;
// Cap the text handed back to the model so the tool response stays lean. The
// bridge/Worker already cap at 8000; we trim to 6000 for the read-aloud excerpt.
const EXCERPT_CAP = 6000;

// ---------------------------------------------------------------------------
// Scoped styles — all selectors carry a `web-`/`.web` prefix so nothing leaks.
// Injected fresh into each widget body (single-instance widget, id 'web'), which
// keeps it race-free across a replace: the style lives and dies with its body.
// ---------------------------------------------------------------------------
const WEB_CSS = `
.web{position:relative;display:flex;flex-direction:column;width:100%;height:100%;
  background:var(--bg-raised);overflow:hidden;}
.web-bar{flex:0 0 auto;display:flex;align-items:center;gap:var(--space-2);
  padding:6px var(--space-3);border-bottom:1px solid var(--line);
  font-family:var(--font-mono);font-size:var(--text-xs);
  letter-spacing:var(--tracking);color:var(--fg-dim);
  white-space:nowrap;overflow:hidden;}
.web-host{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.web-stage{position:relative;flex:1 1 auto;min-height:0;}
.web-frame{position:absolute;inset:0;width:100%;height:100%;border:0;
  background:var(--bg-raised);}
.web-cover{position:absolute;inset:0;display:flex;align-items:center;
  justify-content:center;background:var(--bg-raised);
  font-family:var(--font-mono);font-size:var(--text-sm);
  letter-spacing:var(--tracking-wide);color:var(--fg-dim);}
.web-cover-txt{animation:web-pulse 1.4s var(--ease-in-out) infinite;}
@keyframes web-pulse{0%,100%{opacity:.35}50%{opacity:1}}
.web-blocked{position:absolute;inset:0;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:var(--space-3);
  padding:var(--space-5);text-align:center;background:var(--bg-raised);
  font-family:var(--font-mono);}
.web-blocked-title{font-size:var(--text-sm);letter-spacing:var(--tracking-wide);
  color:var(--fg);}
.web-blocked-host{font-size:var(--text-xs);letter-spacing:var(--tracking);
  color:var(--fg-dim);}
.web-blocked-hint{max-width:36ch;font-size:var(--text-xs);line-height:1.6;
  color:var(--fg-faint);}
.web-empty{display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:var(--space-3);height:100%;padding:var(--space-5);
  text-align:center;background:var(--bg-raised);font-family:var(--font-mono);}
.web-empty-msg{font-size:var(--text-sm);letter-spacing:var(--tracking-wide);
  color:var(--fg-dim);}
.web-empty-hint{max-width:36ch;font-size:var(--text-xs);line-height:1.6;
  color:var(--fg-faint);}
`;

function injectStyle(bodyEl) {
  const style = document.createElement('style');
  style.textContent = WEB_CSS;
  bodyEl.appendChild(style);
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
/**
 * Normalize a user-spoken address: prepend https:// when no scheme is present,
 * then accept ONLY http(s). Anything else (ftp:, javascript:, garbage) -> null.
 * @param {*} raw
 * @returns {string|null} a canonical http(s) URL, or null if not a web address.
 */
function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  // A scheme is only real if it's followed by '://' (so 'javascript:' / 'mailto:'
  // fall through to the https prefix and then fail host parsing -> null).
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.toString();
}

/** Best-effort hostname for display; falls back to the raw string. */
function hostOf(url) {
  try { return new URL(url).hostname; } catch { return String(url || ''); }
}

/**
 * Turn a YouTube link or bare 11-char id into a privacy-friendly nocookie embed.
 * Handles youtube.com/watch?v=, youtu.be/, /shorts/, /embed/ and a bare id.
 * @param {*} input
 * @returns {string|null} embed URL (autoplay) or null if not resolvable.
 */
function youtubeToEmbed(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  const ID = /^[A-Za-z0-9_-]{11}$/;

  // Bare video id.
  if (ID.test(s)) return embedUrl(s);

  // Pull the id out of any recognized URL shape.
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,       // youtube.com/watch?v=ID
    /youtu\.be\/([A-Za-z0-9_-]{11})/,  // youtu.be/ID
    /\/shorts\/([A-Za-z0-9_-]{11})/,   // youtube.com/shorts/ID
    /\/embed\/([A-Za-z0-9_-]{11})/     // youtube.com/embed/ID
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m && ID.test(m[1])) return embedUrl(m[1]);
  }
  return null;
}

function embedUrl(id) {
  return 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1';
}

// ---------------------------------------------------------------------------
// Widget definitions
// ---------------------------------------------------------------------------
/**
 * The real embedding widget. `id` is fixed 'web' (single web view at a time).
 * @param {string} url            an http(s) page URL, or a YouTube embed URL.
 * @param {string} [titleOverride] header label (e.g. 'YOUTUBE'); defaults to
 *        'WEB · <hostname>'.
 */
export function webDef(url, titleOverride) {
  const host = hostOf(url);
  const title = titleOverride || ('WEB · ' + host);
  return defineWidget({
    id: 'web',
    title,
    size: 'lg',
    render(bodyEl) {
      injectStyle(bodyEl);

      const root = el('div', 'web');

      // Address strip — hostname only, mono/dim (chrome stays B&W).
      const bar = el('div', 'web-bar');
      bar.append(el('span', 'web-host', host));

      const stage = el('div', 'web-stage');

      const frame = document.createElement('iframe');
      frame.className = 'web-frame';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
      frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('title', title);
      frame.src = url;

      // Loading cover (pulsing 'ŁADUJĘ…') — hidden once we settle.
      const cover = el('div', 'web-cover');
      cover.append(el('span', 'web-cover-txt', 'ŁADUJĘ…'));

      // Honest block panel — shown only if the site refuses embedding.
      const blocked = el('div', 'web-blocked');
      blocked.style.display = 'none';
      blocked.append(
        el('div', 'web-blocked-title', 'TA STRONA BLOKUJE OSADZANIE'),
        el('div', 'web-blocked-host', host),
        el('div', 'web-blocked-hint',
          'Mogę ją pobrać i streścić — powiedz „pobierz treść tej strony”.')
      );

      stage.append(frame, cover, blocked);
      root.append(bar, stage);
      bodyEl.append(root);

      // --- Block detection ---------------------------------------------------
      // Cross-origin iframes don't surface useful errors, so we keep it simple:
      //   load  -> assume ok, hide the cover.
      //   6s w/ no load -> assume the site blocks embedding, show the panel.
      // Either path clears the cover, so there is never an infinite spinner.
      let settled = false;
      let timer = 0;

      function markLoaded() {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = 0; }
        cover.style.display = 'none';
      }
      function markBlocked() {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = 0; }
        cover.style.display = 'none';
        blocked.style.display = 'flex';
      }

      frame.addEventListener('load', markLoaded);
      frame.addEventListener('error', markBlocked); // rarely fires, but honest if it does
      timer = setTimeout(markBlocked, BLOCK_TIMEOUT_MS);

      // cleanup: kill the timer + tear down the iframe so any audio/video stops
      // the moment the widget is hidden or trashed.
      return () => {
        if (timer) { clearTimeout(timer); timer = 0; }
        frame.removeEventListener('load', markLoaded);
        frame.removeEventListener('error', markBlocked);
        try { frame.src = 'about:blank'; } catch (_e) { /* ignore */ }
        try { frame.remove(); } catch (_e) { /* ignore */ }
      };
    }
  });
}

/**
 * Empty-state widget for show_widget{name:'web'} (no address yet). Honestly asks
 * for an address by voice instead of embedding about:blank.
 */
function emptyWebDef() {
  return defineWidget({
    id: 'web',
    title: 'WEB',
    size: 'lg',
    render(bodyEl) {
      injectStyle(bodyEl);
      const wrap = el('div', 'web-empty');
      wrap.append(
        el('div', 'web-empty-msg', 'Podaj adres strony głosem.'),
        el('div', 'web-empty-hint',
          'Np. „otwórz stronę wikipedia.org” albo „pokaż film z YouTube”.')
      );
      bodyEl.append(wrap);
    }
  });
}

/**
 * Mount a web def, replacing any existing one. The widget id is fixed ('web'),
 * so a plain addWidget on a second call would only pulse the stale iframe —
 * we remove the old view first so a new page/video actually takes over.
 * @param {object} def frozen def from webDef()/emptyWebDef()
 * @returns {string|null} widget id
 */
function mountWeb(def) {
  try {
    const exists = typeof layout.getWidgets === 'function' &&
      layout.getWidgets().some((w) => w && w.id === 'web');
    if (exists) layout.removeWidget('web');
  } catch (_e) { /* engine may be a stub — proceed to add */ }
  return layout.addWidget(def);
}

// ---------------------------------------------------------------------------
// Tool declarations (Gemini functionDeclaration shape)
// ---------------------------------------------------------------------------
const SHOW_WEB_DECL = {
  name: 'show_web',
  description: 'Osadź stronę WWW jako widget. Podaj pełny adres http(s).',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Pełny adres strony, np. https://example.com' }
    },
    required: ['url']
  }
};

const SHOW_YOUTUBE_DECL = {
  name: 'show_youtube',
  description: 'Osadź film z YouTube (link albo ID filmu).',
  parameters: {
    type: 'object',
    properties: {
      url_or_id: { type: 'string', description: 'Link do filmu albo 11-znakowe ID filmu' }
    },
    required: ['url_or_id']
  }
};

const FETCH_WEB_DECL = {
  name: 'fetch_web',
  description: 'Pobierz treść tekstową strony (do przeczytania/streszczenia). Zwraca tytuł i tekst.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Pełny adres strony do pobrania' }
    },
    required: ['url']
  }
};

// ---------------------------------------------------------------------------
// Tool handlers — each returns the REAL result object sent to the model.
// ---------------------------------------------------------------------------
async function showWebHandler(args) {
  const url = normalizeUrl(args && args.url);
  if (!url) return { ok: false, error: 'to nie wygląda na adres www' };
  const host = hostOf(url);
  try {
    mountWeb(webDef(url));
  } catch (_e) {
    return { ok: false, error: 'nie udało się osadzić strony' };
  }
  return {
    ok: true,
    embedded: host,
    note: 'jeśli strona blokuje iframe, pokażę uczciwy komunikat'
  };
}

async function showYoutubeHandler(args) {
  const embed = youtubeToEmbed(args && args.url_or_id);
  if (!embed) {
    return { ok: false, error: 'nie rozpoznaję linku do YouTube — poproś Jurka o pełny link' };
  }
  try {
    mountWeb(webDef(embed, 'YOUTUBE'));
  } catch (_e) {
    return { ok: false, error: 'nie udało się osadzić filmu' };
  }
  return { ok: true };
}

async function fetchWebHandler(args) {
  const url = normalizeUrl(args && args.url);
  if (!url) return { ok: false, error: 'to nie wygląda na adres www' };

  const workerBase = (CONFIG.worker && CONFIG.worker.url) ? String(CONFIG.worker.url) : '';
  const bridgeUp = !!(bridgeClient &&
    typeof bridgeClient.online === 'function' && bridgeClient.online() &&
    typeof bridgeClient.fetchPage === 'function');

  // (a) Local bridge — best path (server-side fetch, tags stripped).
  if (bridgeUp) {
    try {
      const r = await bridgeClient.fetchPage(url);
      if (r && r.ok) return okFetch(r.title, r.text);
      // Bridge answered but couldn't fetch. If there is no Worker to try, be
      // honest right now instead of silently falling through.
      if (!workerBase) return { ok: false, error: honestFetchError(r) };
    } catch (_e) {
      if (!workerBase) return { ok: false, error: 'most nie odpowiedział przy pobieraniu strony' };
      // else: fall through to the Worker path
    }
  }

  // (b) Deployed Cloudflare Worker — same {ok,title,text} shape.
  if (workerBase) {
    try {
      const endpoint = workerBase.replace(/\/$/, '') + '/fetch?url=' + encodeURIComponent(url);
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(WORKER_FETCH_TIMEOUT_MS) });
      let data = null;
      try { data = await res.json(); } catch (_e) { data = null; }
      if (res.ok && data && data.ok) return okFetch(data.title, data.text);
      return { ok: false, error: honestFetchError(data) };
    } catch (_e) {
      return { ok: false, error: 'nie udało się pobrać — Worker nie odpowiada' };
    }
  }

  // (c) Neither source available.
  return { ok: false, error: 'nie mam jak pobrać — uruchom most albo skonfiguruj Workera' };
}

function okFetch(title, text) {
  return {
    ok: true,
    title: title ? String(title) : '',
    excerpt: String(text || '').slice(0, EXCERPT_CAP)
  };
}

function honestFetchError(r) {
  if (r && typeof r.error === 'string' && r.error) return r.error;
  return 'nie udało się pobrać treści tej strony';
}

// ---------------------------------------------------------------------------
// init — register the widget factory + tools. Idempotent, never throws.
// ---------------------------------------------------------------------------
export async function init() {
  try {
    // show_widget{name:'web'} -> honest empty state (not about:blank).
    toolRouter.registerWidget('web', () => emptyWebDef());

    toolRouter.registerTool(SHOW_WEB_DECL, showWebHandler);
    toolRouter.registerTool(SHOW_YOUTUBE_DECL, showYoutubeHandler);
    toolRouter.registerTool(FETCH_WEB_DECL, fetchWebHandler);
  } catch (e) {
    console.warn('[web-embed] init degraded:', e && e.message ? e.message : e);
  }
}
