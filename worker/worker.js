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
 * liveConnectConstraints LOCK the session config server-side, mitigating token
 * abuse / tool-injection (SPEC §2). We keep the lock MINIMAL (model + session
 * resumption) so the browser can still set its own persona, tools AND response
 * modality on top. We deliberately do NOT lock responseModalities: the app ships
 * four modes (GŁOS/TEKST × GŁOS/TEKST) and the two text-output modes connect with
 * Modality.TEXT — locking the token to AUDIO here would silently break them over
 * the worker path (client TEXT vs token-locked AUDIO conflict).
 */
async function handleToken(request, env, cors) {
  if (!env.GEMINI_API_KEY) {
    return json({ error: 'GEMINI_API_KEY not configured' }, 503, cors);
  }

  const now = Date.now();
  const body = {
    uses: 1,
    expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
    newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(),
    liveConnectConstraints: {
      model: 'models/gemini-2.5-flash-preview-native-audio-dialog',
      config: {
        sessionResumption: {}
      }
    },
    fieldMask: ''
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
      return json({ error: 'not found' }, 404, cors);
    } catch (err) {
      return json({ error: err.message || 'internal error' }, 500, cors);
    }
  }
};
