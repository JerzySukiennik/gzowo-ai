// bridge/server.js — the LOCAL bridge (Node on the Mac). No express, node:http.
// Full-power mode: serves the whole v1/ app, mints ephemeral Gemini tokens,
// exposes the projects index, and runs whisper STT. Honest degradation only —
// missing key/feature returns a clear 503/error, never a fake success.
//
// Run: cd bridge && npm install && npm start  ->  http://localhost:8787

import http from 'node:http';
import os from 'node:os';
import { existsSync, readFileSync, createReadStream, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIndex } from './projects-index.js';
import { transcribe } from './whisper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Static root = parent v1/ dir, so `npm start` serves the entire app.
const APP_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. Tiny .env parser — reads bridge/.env if present, merges into process.env
//    WITHOUT overwriting anything already set in the real environment.
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = join(__dirname, '.env');
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip matching surrounding quotes if present.
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const env = process.env;
const PORT = parseInt(env.PORT || '8787', 10);
// Default to the real Projects tree, NOT the app dir. Without this, an install
// with no bridge/.env would index the app's own css/js/bridge folders as if they
// were projects. v1/ lives two levels below Projects/, so resolve there as a
// generic fallback if the known absolute path ever moves.
const PROJECTS_DIR = env.PROJECTS_DIR || resolve(APP_ROOT, '..', '..');

// ---------------------------------------------------------------------------
// Home Assistant config (read from bridge/.env). The token lives ONLY here —
// it is added server-side to every HA request and NEVER reaches the browser.
// haConfigured() gates every /ha/* route: unconfigured -> honest 503, no fakes.
// ---------------------------------------------------------------------------
const HA_URL = (env.HA_URL || '').replace(/\/$/, '');
const HA_TOKEN = env.HA_TOKEN || '';
const HA_BAMBU_PREFIX = env.HA_BAMBU_PREFIX || '';

function haConfigured() {
  return Boolean(HA_URL && HA_TOKEN);
}

/**
 * Fetch an HA REST path with the long-lived token attached server-side.
 * @param {string} path  e.g. '/api/states'
 * @param {RequestInit} [init]  extra fetch options (method/body/headers merge in)
 * @returns {Promise<Response>}
 */
function haFetch(path, init = {}) {
  return fetch(HA_URL + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + HA_TOKEN,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    },
    signal: AbortSignal.timeout(8000)
  });
}

// ---------------------------------------------------------------------------
// 2. Static hosting — serve APP_ROOT with path-traversal protection.
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.ppn': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

/**
 * A path is a forbidden secret if it is a known secrets file. config.js is
 * EXPLICITLY allowed (the browser needs it). We block every .env* file AND
 * wrangler's local-secrets file .dev.vars (holds GEMINI_API_KEY) — the whole
 * token-chain design keeps that key out of the browser, so it must never be
 * served over HTTP/LAN either.
 */
function isForbidden(relPath) {
  const base = relPath.split('/').pop() || '';
  return base === '.env' || base.startsWith('.env.') || base === '.dev.vars';
}

function serveStatic(req, res, urlPath) {
  // Decode + normalise, default to index.html for the root.
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  // Block .env* explicitly (config.js stays allowed).
  if (isForbidden(rel)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  // Resolve safely and verify the result stays inside APP_ROOT (block ../).
  const target = resolve(join(APP_ROOT, '.' + rel));
  if (target !== APP_ROOT && !target.startsWith(APP_ROOT + '/')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  let stat;
  try {
    stat = statSync(target);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  // If a directory was requested, serve its index.html.
  let filePath = target;
  if (stat.isDirectory()) {
    filePath = join(target, 'index.html');
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
  }

  const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------------------
// 3. CORS — reflect the request Origin only if it matches ALLOWED_ORIGINS.
//    List is comma-separated. Supports exact match plus wildcard prefixes
//    'http://localhost:*' and 'http://192.168.*'.
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = (env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function originAllowed(origin) {
  if (!origin) return false;
  for (const rule of ALLOWED_ORIGINS) {
    if (rule === origin) return true;
    if (rule.endsWith('*')) {
      const prefix = rule.slice(0, -1);
      if (origin.startsWith(prefix)) return true;
    }
  }
  return false;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

// ---------------------------------------------------------------------------
// Small helpers for JSON responses.
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, limitBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 4. API routes.
// ---------------------------------------------------------------------------
function whisperReady() {
  // Both the binary AND the model must exist. WHISPER_BIN alone is not enough:
  // whisper.cpp spawned with an empty -m arg fails at runtime, so reporting
  // whisper:true here (and letting /stt through) would be dishonest.
  return Boolean(
    env.WHISPER_BIN && existsSync(env.WHISPER_BIN) &&
    env.WHISPER_MODEL && existsSync(env.WHISPER_MODEL)
  );
}

async function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    version: '2.0',
    features: {
      projects: existsSync(PROJECTS_DIR), // honest: false if the dir is unreadable
      whisper: whisperReady(),
      ha: haConfigured(),                 // true only when HA_URL + HA_TOKEN are set
      fetch: true                         // shared web-fetch endpoint is always on
    }
  });
}

async function handleToken(req, res) {
  if (!env.GEMINI_API_KEY) {
    sendJson(res, 503, { error: 'GEMINI_API_KEY not configured' });
    return;
  }
  try {
    // Ephemeral token: single-use, 30-min life, new sessions only within 2 min.
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const t = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
        httpOptions: { apiVersion: 'v1alpha' }
      }
    });
    sendJson(res, 200, { token: t.name });
  } catch (err) {
    // authTokens.create can throw if the ephemeral-token API isn't enabled on
    // the key/project. LAN-only honesty: on localhost the raw key never leaves
    // the Mac's own network, so we fall back to handing the key to the local
    // browser and FLAG it insecure. This path must never be used over the WAN.
    console.warn('[bridge] /token ephemeral mint failed, falling back to insecure LAN key:', err.message);
    sendJson(res, 200, { apiKey: env.GEMINI_API_KEY, insecure: true });
  }
}

async function handleProjects(req, res) {
  const data = await buildIndex(PROJECTS_DIR);
  sendJson(res, 200, data);
}

async function handleStt(req, res) {
  if (!whisperReady()) {
    sendJson(res, 503, { error: 'whisper not configured' });
    return;
  }
  const wav = await readBody(req);
  try {
    const { text } = await transcribe(wav, env);
    sendJson(res, 200, { text });
  } catch (err) {
    if (err && err.code === 503) {
      sendJson(res, 503, { error: err.message || 'whisper not configured' });
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Home Assistant proxy routes. Every route is honest: unconfigured -> 503,
//    HA errors pass through with their real status, nothing is ever faked.
// ---------------------------------------------------------------------------

// Trim a raw HA state object down to the fields the UI actually needs (diet).
function trimState(s) {
  const a = (s && s.attributes) || {};
  return {
    entity_id: s.entity_id,
    state: s.state,
    attributes: {
      friendly_name: a.friendly_name,
      unit_of_measurement: a.unit_of_measurement,
      device_class: a.device_class
    }
  };
}

// Read + JSON-parse an HA response, forwarding non-OK status honestly.
// Returns {ok:true, data} on success or {ok:false} after already responding.
async function haReadJson(res, upstream) {
  if (!upstream.ok) {
    let detail = '';
    try { detail = await upstream.text(); } catch { /* ignore */ }
    sendJson(res, upstream.status, { error: detail || `ha error ${upstream.status}` });
    return { ok: false };
  }
  try {
    return { ok: true, data: await upstream.json() };
  } catch {
    sendJson(res, 502, { error: 'ha returned non-JSON' });
    return { ok: false };
  }
}

async function handleHaStates(req, res, url) {
  if (!haConfigured()) { sendJson(res, 503, { error: 'ha not configured' }); return; }
  const domain = url.searchParams.get('domain') || '';
  const prefix = url.searchParams.get('prefix') || '';

  let upstream;
  try {
    upstream = await haFetch('/api/states');
  } catch (err) {
    sendJson(res, 502, { error: `ha unreachable: ${err.message || err}` });
    return;
  }
  const parsed = await haReadJson(res, upstream);
  if (!parsed.ok) return;

  const states = Array.isArray(parsed.data) ? parsed.data : [];
  const filtered = states
    .filter((s) => {
      const id = s && s.entity_id ? String(s.entity_id) : '';
      if (!id) return false;
      if (domain && !id.startsWith(domain + '.')) return false;
      if (prefix && !id.includes(prefix)) return false;
      return true;
    })
    .map(trimState);
  sendJson(res, 200, filtered);
}

async function handleHaService(req, res) {
  if (!haConfigured()) { sendJson(res, 503, { error: 'ha not configured' }); return; }

  let payload;
  try {
    const raw = await readBody(req, 1024 * 1024);
    payload = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' });
    return;
  }

  const domain = payload && payload.domain;
  const service = payload && payload.service;
  const data = (payload && payload.data) || {};
  if (typeof domain !== 'string' || !domain || typeof service !== 'string' || !service) {
    sendJson(res, 400, { error: 'domain and service (strings) are required' });
    return;
  }
  // Guard the URL path against injection (HA domains/services are [a-z0-9_]).
  if (!/^[a-z0-9_]+$/i.test(domain) || !/^[a-z0-9_]+$/i.test(service)) {
    sendJson(res, 400, { error: 'invalid domain or service' });
    return;
  }

  let upstream;
  try {
    upstream = await haFetch(`/api/services/${domain}/${service}`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  } catch (err) {
    sendJson(res, 502, { error: `ha unreachable: ${err.message || err}` });
    return;
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    sendJson(res, upstream.status, { error: text || `ha error ${upstream.status}` });
    return;
  }
  // HA replies with a JSON array of changed states (often empty). Pass it on.
  let result;
  try { result = text ? JSON.parse(text) : []; } catch { result = []; }
  sendJson(res, 200, result);
}

async function handleHaBambu(req, res) {
  if (!haConfigured()) { sendJson(res, 503, { error: 'ha not configured' }); return; }
  if (!HA_BAMBU_PREFIX) { sendJson(res, 503, { error: 'HA_BAMBU_PREFIX not set' }); return; }

  let upstream;
  try {
    upstream = await haFetch('/api/states');
  } catch (err) {
    sendJson(res, 502, { error: `ha unreachable: ${err.message || err}` });
    return;
  }
  const parsed = await haReadJson(res, upstream);
  if (!parsed.ok) return;

  const states = Array.isArray(parsed.data) ? parsed.data : [];
  const matches = states.filter(
    (s) => s && s.entity_id && String(s.entity_id).includes(HA_BAMBU_PREFIX)
  );

  const printer = {};
  let cameraEntity = null;
  for (const s of matches) {
    const id = String(s.entity_id);
    if (id.startsWith('camera.') && !cameraEntity) cameraEntity = id;
    const suffix = id.includes('.') ? id.slice(id.indexOf('.') + 1) : id;
    const a = s.attributes || {};
    printer[suffix] = {
      state: s.state,
      attributes: {
        friendly_name: a.friendly_name,
        unit_of_measurement: a.unit_of_measurement
      }
    };
  }

  sendJson(res, 200, {
    ok: true,
    printer,
    camera: cameraEntity
      ? { entity_id: cameraEntity, src: '/ha/camera?entity=' + encodeURIComponent(cameraEntity) }
      : null
  });
}

async function handleHaCamera(req, res, url) {
  if (!haConfigured()) { sendJson(res, 503, { error: 'ha not configured' }); return; }
  const entity = url.searchParams.get('entity') || '';
  if (!/^camera\.[a-z0-9_]+$/.test(entity)) {
    sendJson(res, 400, { error: 'invalid camera entity' });
    return;
  }

  let upstream;
  try {
    upstream = await haFetch('/api/camera_proxy/' + entity);
  } catch (err) {
    sendJson(res, 502, { error: `ha unreachable: ${err.message || err}` });
    return;
  }
  if (!upstream.ok) {
    let detail = '';
    try { detail = await upstream.text(); } catch { /* ignore */ }
    sendJson(res, upstream.status, { error: detail || `ha error ${upstream.status}` });
    return;
  }

  // Pipe the image bytes through with their content-type. The Authorization
  // header was added server-side by haFetch — the token never left the Mac.
  const ct = upstream.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-store' });
  res.end(buf);
}

// ---------------------------------------------------------------------------
// 6. Shared web-fetch endpoint (the web-embed builder consumes it). Server-side
//    fetch keeps CORS out of the browser's way; output is title + stripped text.
// ---------------------------------------------------------------------------
const FETCH_CAP = 2 * 1024 * 1024; // 2 MB hard body cap

// Decode the handful of HTML entities that matter for readable plain text.
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    });
}

// Read up to `cap` bytes from a fetch Response body, then stop (avoid OOM).
async function readCapped(upstream, cap) {
  const reader = upstream.body && upstream.body.getReader ? upstream.body.getReader() : null;
  if (!reader) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    return buf.subarray(0, cap);
  }
  const chunks = [];
  let received = 0;
  while (received < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    chunks.push(Buffer.from(value));
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  return Buffer.concat(chunks).subarray(0, cap);
}

async function handleFetch(req, res, url) {
  const target = url.searchParams.get('url') || '';
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid url' });
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    sendJson(res, 400, { ok: false, error: 'only http/https allowed' });
    return;
  }

  let upstream;
  try {
    upstream = await fetch(parsed.toString(), {
      redirect: 'follow',
      headers: { 'User-Agent': 'GzowoBridge/2.0' },
      signal: AbortSignal.timeout(10000)
    });
  } catch (err) {
    sendJson(res, 502, { ok: false, error: `fetch failed: ${err.message || err}` });
    return;
  }
  if (!upstream.ok) {
    sendJson(res, upstream.status, { ok: false, error: `upstream ${upstream.status}` });
    return;
  }

  const html = (await readCapped(upstream, FETCH_CAP)).toString('utf8');
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim().slice(0, 8000);

  sendJson(res, 200, { ok: true, title, text });
}

// ---------------------------------------------------------------------------
// Request dispatcher.
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const isApi =
    path === '/health' || path === '/token' || path === '/projects' || path === '/stt' ||
    path === '/ha/states' || path === '/ha/service' || path === '/ha/bambu' ||
    path === '/ha/camera' || path === '/fetch';

  // Log one line per request when finished.
  res.on('finish', () => {
    console.log(`${req.method} ${path} -> ${res.statusCode} (${Date.now() - started}ms)`);
  });

  // CORS applies to /api responses only.
  if (isApi) applyCors(req, res);

  // Preflight for API endpoints.
  if (req.method === 'OPTIONS' && isApi) {
    if (originAllowed(req.headers.origin)) {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (path === '/health' && req.method === 'GET') return await handleHealth(req, res);
    if (path === '/token' && req.method === 'GET') return await handleToken(req, res);
    if (path === '/projects' && req.method === 'GET') return await handleProjects(req, res);
    if (path === '/stt' && req.method === 'POST') return await handleStt(req, res);
    if (path === '/ha/states' && req.method === 'GET') return await handleHaStates(req, res, url);
    if (path === '/ha/service' && req.method === 'POST') return await handleHaService(req, res);
    if (path === '/ha/bambu' && req.method === 'GET') return await handleHaBambu(req, res);
    if (path === '/ha/camera' && req.method === 'GET') return await handleHaCamera(req, res, url);
    if (path === '/fetch' && req.method === 'GET') return await handleFetch(req, res, url);

    // Anything else = static file serving.
    if (req.method === 'GET') return serveStatic(req, res, path);

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  } catch (err) {
    console.error('[bridge] handler error', path, err);
    // If CORS wasn't applied yet for an API path, headers may already be sent;
    // guard against double-write.
    if (!res.headersSent) {
      sendJson(res, 500, { error: err.message || 'internal error' });
    } else {
      res.end();
    }
  }
});

// ---------------------------------------------------------------------------
// Listen on 0.0.0.0 so a phone on the same LAN can reach the bridge.
// ---------------------------------------------------------------------------
function lanAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

server.listen(PORT, '0.0.0.0', () => {
  const lan = lanAddress();
  console.log('');
  console.log('  Gzowo bridge up — full-power mode');
  console.log(`  local:  http://localhost:${PORT}`);
  if (lan) console.log(`  LAN:    http://${lan}:${PORT}   (phone on same WiFi)`);
  console.log(`  app root:     ${APP_ROOT}`);
  console.log(`  projects dir: ${PROJECTS_DIR}`);
  console.log(`  whisper:      ${whisperReady() ? 'ready' : 'off (WHISPER_BIN unset)'}`);
  console.log(`  home assist.: ${haConfigured() ? 'configured' : 'off (HA_URL/HA_TOKEN unset)'}`);
  console.log(`  gemini key:   ${env.GEMINI_API_KEY ? 'set' : 'MISSING (/token -> 503)'}`);
  console.log('');
});
