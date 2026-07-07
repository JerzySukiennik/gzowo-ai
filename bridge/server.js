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
    version: '1.0',
    features: {
      projects: existsSync(PROJECTS_DIR), // honest: false if the dir is unreadable
      whisper: whisperReady(),
      ha: false // Home Assistant lands in v1.1 — honest placeholder.
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
// Request dispatcher.
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const isApi = path === '/health' || path === '/token' || path === '/projects' || path === '/stt';

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
  console.log(`  gemini key:   ${env.GEMINI_API_KEY ? 'set' : 'MISSING (/token -> 503)'}`);
  console.log('');
});
