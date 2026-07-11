// bridge/server.js — the LOCAL bridge (Node on the Mac). No express, node:http.
// Full-power mode: serves the whole v1/ app, mints ephemeral Gemini tokens,
// exposes the projects index, and runs whisper STT. Honest degradation only —
// missing key/feature returns a clear 503/error, never a fake success.
//
// Run: cd bridge && npm install && npm start  ->  http://localhost:8787

import http from 'node:http';
import os from 'node:os';
import { existsSync, readFileSync, createReadStream, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIndex } from './projects-index.js';
import { transcribe } from './whisper.js';
import { brainConfigured, brainPassOk, brainIndex, brainReadFile, brainAppendDraft, brainSaveNote, brainFlightLog, brainSearch } from './brain.js';
import { appleNotesAdd, appleNotesRead } from './apple-notes.js';
import { pushNotify, notifyConfigured } from './notify.js';

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
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  // Audio (vendored SFX + the "Żaba" music). m4r is iTunes-ringtone AAC == m4a.
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4r': 'audio/mp4',
  '.ogg': 'audio/ogg'
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
  // HEAD: reply with headers only (no body). wake-word.js probes the Vosk model
  // with a HEAD request to test reachability, so this must return 200 — piping a
  // body on HEAD is illegal, and skipping HEAD entirely 404s the reachability check.
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
  try { headers['Content-Length'] = String(statSync(filePath).size); } catch { /* ignore */ }
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
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

// GET /ha/rooms — the user-maintained light↔room map (bridge/ha-rooms.json).
// Read FRESH each call so Jurek can edit the file without restarting the bridge
// (v4-b #9). Missing/invalid file -> empty list, honest.
// Lenient parse: Jurek hand-edits this file and naturally writes bare words like
// `"rooms": [Salon, Dom]`. Strict JSON.parse would reject the WHOLE map (all his
// rooms silently gone). So on failure we auto-quote bare tokens inside rooms arrays
// and retry — the loose edit just works.
function parseRoomsLenient(raw) {
  try { return JSON.parse(raw); } catch (_e) { /* try to repair */ }
  const repaired = raw.replace(/("rooms"\s*:\s*)\[([^\]]*)\]/g, (m, pre, inner) => {
    const items = inner.split(',').map((x) => x.trim()).filter(Boolean)
      .map((x) => JSON.stringify(x.replace(/^["']|["']$/g, '')));
    return pre + '[' + items.join(', ') + ']';
  });
  return JSON.parse(repaired); // if still broken, caller catches
}

// Config/sub switches that are NOT lamps (mirror of the client filter).
const SWITCH_NOISE = /_led$|_auto_off|_auto_update|_enabled$|_overload|_cloud|_signal|_consumption|_voltage|_current$|_power_protection|_child_lock|_inching|_indicator|_backlight|_do_not_disturb|_power_on|_relay_status|_night_light|_status_led/i;

function isLampEntity(s) {
  const id = String(s.entity_id || '');
  if (id.startsWith('light.')) return true;
  if (!id.startsWith('switch.')) return false;
  if (SWITCH_NOISE.test(id)) return false;
  const n = ((s.attributes && s.attributes.friendly_name) || '').toLowerCase();
  return /lamp|świat|swiat|żyrand|zyrand|kinkiet|sufit|taśm|tasm/.test(n);
}

async function handleHaRooms(req, res) {
  const p = join(__dirname, 'ha-rooms.json');
  const README = 'Uzupełnij pole rooms dla każdego światła — nazwy pokoi/miejsc PL. Encja może mieć ' +
    'wiele miejsc (np. ["salon","dom"]). Wtedy "zapal wszystkie światła w salonie" zadziała. Zapisz ' +
    'plik, most przeładuje sam. Ta lista dociąga się sama z HA (light + switch będące lampami).';

  // 1. Read the file (may be missing / loosely edited).
  let existing = [];
  try {
    const raw = await readFile(p, 'utf8');
    const data = parseRoomsLenient(raw);
    existing = Array.isArray(data.lights) ? data.lights : (Array.isArray(data) ? data : []);
  } catch (_e) { existing = []; }

  const byId = new Map(existing.map((l) => [l.entity_id, {
    entity_id: l.entity_id,
    name: l.name || l.entity_id,
    rooms: Array.isArray(l.rooms) ? l.rooms : []
  }]));

  // 2. If HA is reachable, MERGE IN every lamp (add missing, refresh names).
  let addedNew = false;
  let reachable = false;
  if (haConfigured()) {
    try {
      const upstream = await haFetch('/api/states');
      if (upstream.ok) {
        reachable = true;
        const states = await upstream.json();
        for (const s of (Array.isArray(states) ? states : [])) {
          if (!isLampEntity(s)) continue;
          const name = (s.attributes && s.attributes.friendly_name) || s.entity_id;
          const cur = byId.get(s.entity_id);
          if (cur) { cur.name = name; }                       // refresh name, keep rooms
          else { byId.set(s.entity_id, { entity_id: s.entity_id, name, rooms: [] }); addedNew = true; }
        }
      }
    } catch (_e) { /* HA offline — fall back to the file as-is */ }
  }

  const lights = [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'pl'));

  // 3. Persist the merged list back so Jurek can fill rooms for EVERYTHING — but
  //    only when we actually added new lamps (avoid rewriting the file every call
  //    and never clobber it with less than it had).
  if (addedNew) {
    try { await writeFile(p, JSON.stringify({ _README: README, lights }, null, 2)); }
    catch (_e) { /* read-only fs — still return the merged view */ }
  }

  sendJson(res, 200, { ok: true, lights, reachable, addedNew });
}

// POST /ha/rooms — LEARN a lamp permanently (Jurek v4-g). When Gzowo controls an
// entity Jurek named that wasn't in the map, it persists {entity_id, name, rooms}
// here so home_devices keeps it and control_room finds it forever. Rooms union
// with any existing. Body: {entity_id, name?, rooms?:string[]|string}.
async function handleHaRoomsLearn(req, res) {
  let payload;
  try { payload = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); }
  catch { sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); return; }

  const entity_id = String(payload.entity_id || '').trim();
  if (!/^(light|switch)\.[a-z0-9_]+$/i.test(entity_id)) {
    sendJson(res, 400, { ok: false, error: 'entity_id musi być light.* albo switch.*' });
    return;
  }
  let rooms = payload.rooms;
  if (typeof rooms === 'string') rooms = rooms.split(',').map((x) => x.trim()).filter(Boolean);
  if (!Array.isArray(rooms)) rooms = [];

  const p = join(__dirname, 'ha-rooms.json');
  const README = 'Uzupełnij pole rooms dla każdego światła. Ta lista dociąga się sama z HA i uczy ' +
    'się nowych lamp, gdy Jurek je nazwie (POST /ha/rooms).';
  let existing = [];
  try {
    const data = parseRoomsLenient(await readFile(p, 'utf8'));
    existing = Array.isArray(data.lights) ? data.lights : (Array.isArray(data) ? data : []);
  } catch (_e) { existing = []; }

  const byId = new Map(existing.map((l) => [l.entity_id, {
    entity_id: l.entity_id, name: l.name || l.entity_id,
    rooms: Array.isArray(l.rooms) ? l.rooms : []
  }]));

  const cur = byId.get(entity_id) || { entity_id, name: entity_id, rooms: [] };
  if (payload.name && String(payload.name).trim()) cur.name = String(payload.name).trim();
  // Union rooms (case-insensitive) so relearning doesn't duplicate.
  const seen = new Set(cur.rooms.map((r) => String(r).toLowerCase()));
  for (const r of rooms) { const k = String(r).toLowerCase(); if (!seen.has(k)) { cur.rooms.push(r); seen.add(k); } }
  const isNew = !byId.has(entity_id);
  byId.set(entity_id, cur);

  const lights = [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'pl'));
  try { await writeFile(p, JSON.stringify({ _README: README, lights }, null, 2)); }
  catch (e) { sendJson(res, 500, { ok: false, error: 'nie udało się zapisać mapy: ' + (e.message || e) }); return; }

  sendJson(res, 200, { ok: true, learned: entity_id, name: cur.name, rooms: cur.rooms, is_new: isNew });
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
// 6b. Embed proxy — serves a remote page AS OUR OWN document so the app can
// iframe sites that send X-Frame-Options/CSP frame-ancestors (their headers die
// here; we only re-emit the body). <base> keeps relative assets loading from the
// ORIGINAL host, and <meta http-equiv=CSP> is stripped (it could re-block).
// Upstream failure returns a marker page (`gz-proxy-error`) that the client can
// read reliably (same-origin) and escalate to the text-fallback. LAN-local only.
// ---------------------------------------------------------------------------
const PROXY_CAP = 4 * 1024 * 1024; // 4 MB document cap

// GET /embed-check?url= — does the site allow being iframed directly? Reads
// X-Frame-Options + CSP frame-ancestors from a real response (headers only; the
// body is cancelled). The client uses the verdict to pick direct-iframe vs proxy
// WITHOUT ever flashing Chrome's sad-tab error page at Jurek.
async function handleEmbedCheck(req, res, url) {
  const target = url.searchParams.get('url') || '';
  let parsed;
  try { parsed = new URL(target); } catch { parsed = null; }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    sendJson(res, 400, { ok: false, error: 'invalid url' });
    return;
  }
  let upstream;
  try {
    upstream = await fetch(parsed.toString(), {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) GzowoBridge/2.0' },
      signal: AbortSignal.timeout(8000)
    });
  } catch (err) {
    sendJson(res, 200, { ok: true, reachable: false, embeddable: false });
    return;
  }
  try { upstream.body && upstream.body.cancel && upstream.body.cancel(); } catch { /* ignore */ }
  const xfo = (upstream.headers.get('x-frame-options') || '').toLowerCase();
  const csp = (upstream.headers.get('content-security-policy') || '').toLowerCase();
  const blockedByXfo = xfo.includes('deny') || xfo.includes('sameorigin');
  const fa = csp.match(/frame-ancestors\s+([^;]+)/);
  // Any frame-ancestors that isn't a wildcard blocks a foreign embedder like us.
  const blockedByCsp = Boolean(fa && !fa[1].includes('*'));
  sendJson(res, 200, {
    ok: true,
    reachable: upstream.ok,
    embeddable: upstream.ok && !blockedByXfo && !blockedByCsp
  });
}

async function handleProxy(req, res, url) {
  const target = url.searchParams.get('url') || '';
  let parsed;
  try { parsed = new URL(target); } catch { parsed = null; }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<meta name="gz-proxy-error" content="invalid url">');
    return;
  }

  // Optional forwarded header (v4 #21 connectors): &h=Name:%20Value — lets a
  // user-built API connector pass its auth header through the bridge (the value
  // never needs CORS and stays out of the page URL the iframe shows).
  const fwd = url.searchParams.get('h') || '';
  const fwdHeaders = { 'User-Agent': 'Mozilla/5.0 (Macintosh) GzowoBridge/2.0' };
  const ci = fwd.indexOf(':');
  if (ci > 0) {
    const hn = fwd.slice(0, ci).trim();
    const hv = fwd.slice(ci + 1).trim();
    if (/^[A-Za-z0-9-]+$/.test(hn) && hv) fwdHeaders[hn] = hv;
  }

  let upstream;
  try {
    upstream = await fetch(parsed.toString(), {
      redirect: 'follow',
      headers: fwdHeaders,
      signal: AbortSignal.timeout(12000)
    });
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<meta name="gz-proxy-error" content="unreachable">');
    return;
  }
  if (!upstream.ok) {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<meta name="gz-proxy-error" content="upstream ' + upstream.status + '">');
    return;
  }

  const ct = upstream.headers.get('content-type') || '';
  const body = await readCapped(upstream, PROXY_CAP);

  // Non-HTML (pdf/image/…): pipe the bytes through untouched.
  if (!/text\/html/i.test(ct)) {
    res.writeHead(200, { 'Content-Type': ct || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  let html = body.toString('utf8');
  // Strip <meta> CSP (header CSP already died with the upstream response).
  html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
  // <base> so relative links/assets resolve against the REAL site (post-redirect).
  const finalUrl = upstream.url || parsed.toString();
  const baseTag = '<base href="' + finalUrl.replace(/"/g, '&quot;') + '">';
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head([^>]*)>/i, '<head$1>' + baseTag);
  else html = baseTag + html;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

// ---------------------------------------------------------------------------
// 7. "Jurek's 2nd Brain" — read the vault (.md) + append-only drafts. Every
//    route: unconfigured -> 503, wrong/absent X-Brain-Pass -> 401. Read-only
//    except /brain/draft (append to inbox/gzowoai-drafts.md).
// ---------------------------------------------------------------------------
function brainGate(req, res) {
  if (!brainConfigured()) { sendJson(res, 503, { error: 'brain not configured' }); return false; }
  if (!brainPassOk(req)) { sendJson(res, 401, { error: 'bad brain pass' }); return false; }
  return true;
}

async function handleBrainIndex(req, res) {
  if (!brainGate(req, res)) return;
  sendJson(res, 200, await brainIndex());
}

async function handleBrainFile(req, res, url) {
  if (!brainGate(req, res)) return;
  const rel = url.searchParams.get('path') || '';
  const content = await brainReadFile(rel);
  if (content == null) { sendJson(res, 404, { error: 'not found or not a .md file' }); return; }
  sendJson(res, 200, { path: rel, content });
}

async function handleBrainDraft(req, res) {
  if (!brainGate(req, res)) return;
  let payload;
  try { payload = JSON.parse((await readBody(req, 512 * 1024)).toString('utf8') || '{}'); }
  catch { sendJson(res, 400, { error: 'invalid JSON body' }); return; }
  sendJson(res, 200, await brainAppendDraft(payload.topic, payload.text));
}

// v4-f: real dated note into inbox/ (2nd-brain capture without the drafts file).
async function handleBrainSave(req, res) {
  if (!brainGate(req, res)) return;
  let payload;
  try { payload = JSON.parse((await readBody(req, 512 * 1024)).toString('utf8') || '{}'); }
  catch { sendJson(res, 400, { error: 'invalid JSON body' }); return; }
  const text = String(payload.text || '').trim();
  if (!text) { sendJson(res, 400, { error: 'empty note' }); return; }
  sendJson(res, 200, await brainSaveNote(payload.title, text));
}

// v4-f: one flight-log file per flight in Flight-Logs/.
async function handleBrainFlightLog(req, res) {
  if (!brainGate(req, res)) return;
  let payload;
  try { payload = JSON.parse((await readBody(req, 512 * 1024)).toString('utf8') || '{}'); }
  catch { sendJson(res, 400, { error: 'invalid JSON body' }); return; }
  sendJson(res, 200, await brainFlightLog(payload));
}

// v4-f: content search across the vault (better "co wiem o X").
async function handleBrainSearch(req, res, url) {
  if (!brainGate(req, res)) return;
  const q = url.searchParams.get('q') || '';
  sendJson(res, 200, await brainSearch(q));
}

// v4-f: Apple Notes (Zakupy/TODO) — GET ?note= reads, POST {note,line} appends.
async function handleAppleNotes(req, res, url) {
  if (!brainGate(req, res)) return;
  if (req.method === 'GET') {
    const note = url.searchParams.get('note') || '';
    sendJson(res, 200, await appleNotesRead(note));
    return;
  }
  let payload;
  try { payload = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8') || '{}'); }
  catch { sendJson(res, 400, { error: 'invalid JSON body' }); return; }
  sendJson(res, 200, await appleNotesAdd(payload.note, payload.line));
}

// v4-f: push to phone via ntfy. POST {title?, message}.
async function handleNotify(req, res) {
  if (!brainGate(req, res)) return;
  let payload;
  try { payload = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); }
  catch { sendJson(res, 400, { error: 'invalid JSON body' }); return; }
  sendJson(res, 200, await pushNotify(payload.title, payload.message));
}

// ---------------------------------------------------------------------------
// 7c. Skill FORGE (v3 #16) — the builder "agent". A SEPARATE Gemini key + model
// (SKILLS_API_KEY / SKILLS_MODEL) generates a self-contained skill as JS that runs
// ONLY inside a locked sandboxed iframe on the client (allow-scripts, no
// same-origin), talking to the app through a narrow postMessage API. The key never
// reaches the browser. Honest 503 when unconfigured.
// ---------------------------------------------------------------------------
const SKILL_SYS = [
  'Jesteś generatorem mini-skilli dla asystenta "Gzowo AI". Na podstawie opisu Jurka',
  'napisz JEDEN samowystarczalny fragment JavaScriptu, który uruchomi się w ZAMKNIĘTYM',
  'sandboxie (iframe allow-scripts, BEZ dostępu do reszty aplikacji, sieci, DOM rodzica).',
  'DOSTĘPNE API (nic więcej NIE istnieje): ',
  '  GzowoSkill.render(htmlString)  // pokaż HTML w widgetcie (kolor dozwolony)',
  '  GzowoSkill.log(text)           // log do konsoli skilla',
  '  GzowoSkill.onTick(fn, ms)      // powtarzaj fn co ms (auto-czyszczone)',
  '  GzowoSkill.done()              // zakończ skilla',
  'ZASADY: żadnych importów, fetch, eval, window/parent/document.cookie, żadnych',
  'zewnętrznych zasobów. Czysty, bezpieczny JS. Zwróć WYŁĄCZNIE kod (bez markdown,',
  'bez ```), gotowy do wykonania. Krótko i konkretnie.'
].join('\n');

async function handleSkillGenerate(req, res) {
  const key = env.SKILLS_API_KEY || '';
  if (!key) { sendJson(res, 503, { ok: false, error: 'skill builder not configured (SKILLS_API_KEY)' }); return; }
  let payload;
  try { payload = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8') || '{}'); }
  catch { sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); return; }
  const desc = String(payload.description || '').trim();
  if (!desc) { sendJson(res, 400, { ok: false, error: 'brak opisu skilla' }); return; }

  const model = env.SKILLS_MODEL || 'gemini-3.5-flash';
  try {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: key });
    const result = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: 'Opis skilla: ' + desc }] }],
      config: { systemInstruction: SKILL_SYS, temperature: 0.4 }
    });
    let code = '';
    try { code = result.text || (result.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? ''); }
    catch { code = ''; }
    code = String(code).replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/i, '').trim();
    if (!code) { sendJson(res, 502, { ok: false, error: 'builder zwrócił pusty kod' }); return; }
    sendJson(res, 200, { ok: true, code, model });
  } catch (err) {
    sendJson(res, 502, { ok: false, error: 'builder error: ' + (err && err.message ? err.message : String(err)) });
  }
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
    path === '/ha/camera' || path === '/ha/rooms' || path === '/fetch' || path === '/embed-check' || path === '/proxy' ||
    path === '/brain/index' || path === '/brain/file' || path === '/brain/draft' ||
    path === '/brain/save' || path === '/brain/flightlog' || path === '/brain/search' ||
    path === '/apple-notes' || path === '/notify' || path === '/cesium-token' ||
    path === '/skills/generate';

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
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-brain-pass');
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
    if (path === '/ha/rooms' && req.method === 'GET') return await handleHaRooms(req, res);
    if (path === '/ha/rooms' && req.method === 'POST') return await handleHaRoomsLearn(req, res);
    if (path === '/fetch' && req.method === 'GET') return await handleFetch(req, res, url);
    if (path === '/proxy' && req.method === 'GET') return await handleProxy(req, res, url);
    if (path === '/embed-check' && req.method === 'GET') return await handleEmbedCheck(req, res, url);
    if (path === '/brain/index' && req.method === 'GET') return await handleBrainIndex(req, res);
    if (path === '/brain/file' && req.method === 'GET') return await handleBrainFile(req, res, url);
    if (path === '/brain/draft' && req.method === 'POST') return await handleBrainDraft(req, res);
    if (path === '/brain/save' && req.method === 'POST') return await handleBrainSave(req, res);
    if (path === '/brain/flightlog' && req.method === 'POST') return await handleBrainFlightLog(req, res);
    if (path === '/brain/search' && req.method === 'GET') return await handleBrainSearch(req, res, url);
    if (path === '/apple-notes' && (req.method === 'GET' || req.method === 'POST')) return await handleAppleNotes(req, res, url);
    if (path === '/notify' && req.method === 'POST') return await handleNotify(req, res);
    if (path === '/cesium-token' && req.method === 'GET') return sendJson(res, 200, { token: env.CESIUM_ION_TOKEN || '' });
    if (path === '/skills/generate' && req.method === 'POST') return await handleSkillGenerate(req, res);

    // Anything else = static file serving (GET + HEAD; HEAD is headers-only).
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, path);

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
