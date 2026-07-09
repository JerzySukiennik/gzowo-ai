// worker/worker.js — Cloudflare Worker (ES module syntax). NO npm deps: raw
// fetch to the Gemini REST endpoint. Deployed-mode token minter: keeps the
// Gemini key server-side and hands the browser only short-lived ephemeral
// tokens. Also a tiny allowlisted CORS proxy for keyless public APIs.
//
// Secrets live ONLY in env (wrangler secret put GEMINI_API_KEY) — never here.

const GEMINI_TOKEN_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1alpha/auth_tokens';

// Hosts the /proxy endpoint is allowed to reach. Weather is keyless + public.
// Extend in v1.1 for the web-embed/fetch feature.
const PROXY_ALLOWLIST = ['api.open-meteo.com'];

/**
 * Match an Origin against the ALLOWED_ORIGINS list (same semantics as the
 * bridge): comma-separated, exact match plus wildcard prefixes ending in '*'.
 * @param {string|null} origin
 * @param {string} allowed  raw ALLOWED_ORIGINS value
 * @returns {string|null} the value to echo in Access-Control-Allow-Origin
 */
function resolveOrigin(origin, allowed) {
  // Tradeoff: if ALLOWED_ORIGINS is unset we default to '*'. That's convenient
  // for a public voice frontend on GitHub Pages (the token is already short-
  // lived and config-locked), but for a private deploy set ALLOWED_ORIGINS to
  // your exact site origin in wrangler.toml [vars].
  if (!allowed) return '*';
  const rules = allowed.split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin) return null;
  for (const rule of rules) {
    if (rule === '*') return '*';
    if (rule === origin) return origin;
    if (rule.endsWith('*') && origin.startsWith(rule.slice(0, -1))) return origin;
  }
  return null;
}

/**
 * Build CORS headers for a response.
 * @param {Request} request
 * @param {Record<string,string>} env
 * @returns {Record<string,string>}
 */
function corsHeaders(request, env) {
  const allow = resolveOrigin(request.headers.get('Origin'), env.ALLOWED_ORIGINS);
  const headers = {
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '600'
  };
  if (allow) {
    headers['Access-Control-Allow-Origin'] = allow;
    if (allow !== '*') headers['Vary'] = 'Origin';
  }
  return headers;
}

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
  });
}

/**
 * GET /token — mint an ephemeral Gemini token via REST.
 *
 * We mint an UNLOCKED token (uses:1 + short expiry only), mirroring the bridge's
 * proven SDK call. Two reasons:
 *   1. The v1alpha endpoint rejects a top-level `liveConnectConstraints` field
 *      ("Unknown name liveConnectConstraints at 'auth_token'") — the server-side
 *      config-lock shape the SPEC assumed is no longer accepted here.
 *   2. Not pinning a model lets the client-side 3.1→2.5 fallback (gemini-live.js)
 *      work over the Worker path too, not just the bridge.
 * Security posture stays reasonable for a personal app: single-use, 2-min new-
 * session window, 30-min hard expiry — same as the bridge. If Google restores a
 * working constraints shape and we want the lock back, add it here AND keep it in
 * sync with config.js gemini.model.
 */
async function handleToken(request, env, cors) {
  if (!env.GEMINI_API_KEY) {
    return json({ error: 'GEMINI_API_KEY not configured' }, 503, cors);
  }

  const now = Date.now();
  const body = {
    uses: 1,
    expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
    newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString()
  };

  let upstream;
  try {
    upstream = await fetch(GEMINI_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    return json({ error: `upstream fetch failed: ${err.message}` }, 502, cors);
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    // Pass the real status + body honestly. If Google changed the endpoint
    // shape, surface it (501-style) rather than faking a token.
    return json({ error: text || `token endpoint returned ${upstream.status}` }, upstream.status, cors);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ error: 'token endpoint returned non-JSON — shape changed?' }, 501, cors);
  }
  if (!data || !data.name) {
    return json({ error: 'token endpoint returned no name field — shape changed?' }, 501, cors);
  }
  return json({ token: data.name }, 200, cors);
}

/**
 * GET /proxy?url=... — allowlisted CORS proxy for keyless public APIs.
 */
async function handleProxy(request, env, cors) {
  const target = new URL(request.url).searchParams.get('url');
  if (!target) {
    return json({ error: 'missing url param' }, 400, cors);
  }
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return json({ error: 'invalid url' }, 400, cors);
  }
  if (parsed.protocol !== 'https:' || !PROXY_ALLOWLIST.includes(parsed.hostname)) {
    return json({ error: `host not allowed: ${parsed.hostname}` }, 400, cors);
  }

  let upstream;
  try {
    upstream = await fetch(parsed.toString(), { headers: { Accept: 'application/json' } });
  } catch (err) {
    return json({ error: `upstream fetch failed: ${err.message}` }, 502, cors);
  }

  // Stream the body back, preserving content-type, adding CORS.
  const headers = { ...cors };
  const ct = upstream.headers.get('Content-Type');
  if (ct) headers['Content-Type'] = ct;
  return new Response(upstream.body, { status: upstream.status, headers });
}

// ---------------------------------------------------------------------------
// GET /fetch?url=... — read a page's text so the model can summarize it aloud.
// Mirrors the bridge's /fetch contract: validate http/https, fetch server-side
// (10s timeout, follow redirects, cap the read at 2MB), extract <title>, strip
// script/style/noscript + all tags, collapse whitespace, return
// {ok:true,title,text} with text capped at 8000 chars. Errors -> {ok:false,error}
// with status 502. Unlike /proxy this is intentionally NOT allowlisted (the whole
// point is reading arbitrary public pages), but private/loopback hosts are
// refused as light SSRF hygiene.
// ---------------------------------------------------------------------------
const FETCH_TIMEOUT_MS = 10000;
const FETCH_MAX_BYTES = 2 * 1024 * 1024; // 2MB
const FETCH_TEXT_CAP = 8000;

/** Reject loopback / private / link-local hosts (light SSRF guard). */
function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '::' ) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 127) return true;             // this-host / loopback
    if (a === 10) return true;                          // private
    if (a === 192 && b === 168) return true;            // private
    if (a === 172 && b >= 16 && b <= 31) return true;   // private
    if (a === 169 && b === 254) return true;            // link-local / metadata
  }
  return false;
}

/** Read a response body, stopping hard at maxBytes even if content-length lies. */
async function readCapped(response, maxBytes) {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const buf = await response.arrayBuffer();
    const bytes = new Uint8Array(buf).subarray(0, maxBytes);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) {
      chunks.push(value);
      total += value.length;
      if (total >= maxBytes) {
        try { await reader.cancel(); } catch (_e) { /* ignore */ }
        break;
      }
    }
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    if (off >= merged.length) break;
    const slice = c.subarray(0, merged.length - off);
    merged.set(slice, off);
    off += slice.length;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

function stripTags(s) { return s.replace(/<[^>]*>/g, ' '); }
function collapseWs(s) { return s.replace(/\s+/g, ' ').trim(); }

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; } })
    .replace(/&amp;/gi, '&'); // last, so we never re-introduce entities to decode
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return decodeEntities(collapseWs(stripTags(m[1]))).slice(0, 300);
}

function htmlToText(html) {
  let s = html;
  // Drop the whole <head> (title/meta/link noise) — the title is extracted
  // separately from the original HTML, so this only removes duplication/noise.
  s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ');
  s = s.replace(/<title[\s\S]*?<\/title>/gi, ' '); // in case it sits outside <head>
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // Keep word separation across block boundaries before stripping the rest.
  s = s.replace(/<\/(p|div|section|article|li|h[1-6]|tr|header|footer|main|nav)>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = stripTags(s);
  s = decodeEntities(s);
  s = collapseWs(s);
  return s;
}

async function handleFetch(request, env, cors) {
  const target = new URL(request.url).searchParams.get('url');
  if (!target) return json({ ok: false, error: 'missing url param' }, 502, cors);

  let parsed;
  try { parsed = new URL(target); } catch { return json({ ok: false, error: 'invalid url' }, 502, cors); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return json({ ok: false, error: 'only http/https urls are allowed' }, 502, cors);
  }
  if (isBlockedHost(parsed.hostname)) {
    return json({ ok: false, error: 'ten adres jest zablokowany' }, 502, cors);
  }

  let upstream;
  try {
    upstream = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GzowoAI/2.0)',
        'Accept': 'text/html,application/xhtml+xml,text/plain'
      }
    });
  } catch (err) {
    return json({ ok: false, error: `nie udało się pobrać strony: ${err && err.message ? err.message : 'brak połączenia'}` }, 502, cors);
  }

  if (!upstream.ok) {
    return json({ ok: false, error: `strona odpowiedziała ${upstream.status}` }, 502, cors);
  }

  const ctype = upstream.headers.get('content-type') || '';
  if (ctype && !/text\/html|application\/xhtml|text\/plain|application\/xml|text\/xml/i.test(ctype)) {
    return json({ ok: false, error: 'to nie jest strona z tekstem do przeczytania' }, 502, cors);
  }

  let html;
  try {
    html = await readCapped(upstream, FETCH_MAX_BYTES);
  } catch (_err) {
    return json({ ok: false, error: 'strona urwała się w trakcie pobierania' }, 502, cors);
  }

  const title = extractTitle(html);
  const text = htmlToText(html).slice(0, FETCH_TEXT_CAP);
  return json({ ok: true, title, text }, 200, cors);
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    // CORS preflight.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/token' && request.method === 'GET') {
        return await handleToken(request, env, cors);
      }
      if (path === '/proxy' && request.method === 'GET') {
        return await handleProxy(request, env, cors);
      }
      if (path === '/fetch' && request.method === 'GET') {
        return await handleFetch(request, env, cors);
      }
      return json({ error: 'not found' }, 404, cors);
    } catch (err) {
      return json({ error: err.message || 'internal error' }, 500, cors);
    }
  }
};
