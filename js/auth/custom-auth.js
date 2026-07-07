// js/auth/custom-auth.js — auth-owned, v2. Custom salted-hash auth on Firestore.
//
// Why not Firebase Auth? It forces a 6-char minimum. Jurek wanted 4. So identity
// lives in users/{username} = {salt,hash,iters,createdAt,lastLogin} and we verify
// it ourselves with WebCrypto PBKDF2. Passwords are NEVER stored, logged or sent
// in plaintext — only the salted hash leaves this module.
//
// Security trade-off (documented in firestore.rules + README): the salt+hash are
// world-readable, so a 4-char password is brute-forceable offline, and the rules
// can't verify identity without Firebase Auth. Accepted for a personal app.
//
// LOCAL fallback: when the Firebase config is a placeholder or Firestore failed to
// init (memory.getDb() === null), identical salted-hash records live in
// localStorage 'gzowo.localUsers' and the screen shows a 'TRYB LOKALNY' badge.
// Everything else works the same.

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';
import { memory, getDb } from '../memory/firebase.js';
import { mountAuthScreen } from './auth-screen.js';

import {
  doc,
  getDoc,
  setDoc,
  updateDoc
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ============================================================================
// Constants
// ============================================================================

const USERNAME_RE = /^[a-z0-9_-]{2,24}$/i;
const MIN_PASSWORD = 4;

const PBKDF2_ITERS = 150000;
const SALT_BYTES = 16;
const KEY_BITS = 256;                    // 32-byte derived key

const LS_SESSION = 'gzowo.session';      // {username}
const LS_LOCAL_USERS = 'gzowo.localUsers'; // {username:{salt,hash,iters}}

const RESTORE_TIMEOUT_MS = 3000;         // session-verify network budget

// ============================================================================
// Module state
// ============================================================================

let _bootDone = false;                   // has 'boot:done' fired yet?
let _succeeded = false;                  // shared success path runs exactly once

// Register the boot gate at import time (custom-auth is imported before boot:done).
bus.on('boot:done', () => { _bootDone = true; });

// ============================================================================
// Helpers — localStorage
// ============================================================================

function lsGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* best-effort */ }
}
function lsRemove(key) {
  try { localStorage.removeItem(key); } catch { /* best-effort */ }
}

// ============================================================================
// Helpers — mode + records
// ============================================================================

/** True when we have no Firestore (placeholder config or init failure). */
export function isLocal() {
  return !getDb();
}

function saveSession(username) {
  lsSet(LS_SESSION, { username });
}
function clearSession() {
  lsRemove(LS_SESSION);
}

function getLocalUser(username) {
  const all = lsGet(LS_LOCAL_USERS, {}) || {};
  return all[username] || null;
}
function setLocalUser(username, rec) {
  const all = lsGet(LS_LOCAL_USERS, {}) || {};
  all[username] = rec;
  lsSet(LS_LOCAL_USERS, all);
}

function userDocRef(username) {
  return doc(getDb(), 'users', username);
}

/** Promise.race a network op against a timeout so boot never hangs. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

// ============================================================================
// Helpers — WebCrypto PBKDF2 (hex-encoded salt + hash)
// ============================================================================

/** bytes -> lowercase hex string */
export function hexEncode(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/** hex string -> Uint8Array */
export function hexDecode(hex) {
  const clean = String(hex || '');
  const n = clean.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/**
 * Derive a PBKDF2-HMAC-SHA256 key. Password bytes are never retained.
 * @param {string} password
 * @param {Uint8Array} saltBytes
 * @param {number} iters
 * @returns {Promise<Uint8Array>} 32-byte derived key
 */
export async function deriveHash(password, saltBytes, iters) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: iters, hash: 'SHA-256' },
    keyMaterial, KEY_BITS
  );
  return new Uint8Array(bits);
}

/** Constant-time-ish hex comparison (length-independent early return only). */
function hexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Build a fresh {salt,hash,iters} record for a password. */
async function makeRecord(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hashBytes = await deriveHash(password, salt, PBKDF2_ITERS);
  return { salt: hexEncode(salt), hash: hexEncode(hashBytes), iters: PBKDF2_ITERS };
}

// ============================================================================
// Shared success path — runs exactly once per session
// ============================================================================

/**
 * attachUser -> publish user to state -> emit 'auth:ready' (deferred until AFTER
 * 'boot:done' so late-initialized modules never miss it).
 * @param {string} username
 * @returns {Promise<{ok:true,user:{username:string}}>}
 */
async function succeed(username) {
  if (_succeeded) return { ok: true, user: { username } };
  _succeeded = true;

  try {
    await memory.attachUser(username);
  } catch (err) {
    console.warn('[auth] attachUser failed (continuing)', err);
  }

  state.set('user', { username });
  state.set('authResolved', true);

  const emit = () => bus.emit('auth:ready', { user: { username } });
  if (_bootDone) emit();
  else bus.once('boot:done', emit);

  return { ok: true, user: { username } };
}

// ============================================================================
// Public: exists / register / login / restoreSession / logout
// ============================================================================

/**
 * @param {string} username
 * @returns {Promise<boolean>}
 */
export async function exists(username) {
  const u = String(username || '').toLowerCase();
  if (!USERNAME_RE.test(u)) return false;

  if (isLocal()) return !!getLocalUser(u);

  try {
    const snap = await getDoc(userDocRef(u));
    return snap.exists();
  } catch (err) {
    // Couldn't confirm (network). Treat as "not found" — a duplicate register is
    // still blocked server-side by the create rule, so no data corruption.
    console.warn('[auth] exists() lookup failed', err);
    return false;
  }
}

/**
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ok:true,user:{username:string}}|{ok:false,error:string}>}
 */
export async function register(username, password) {
  const u = String(username || '').toLowerCase();
  if (!USERNAME_RE.test(u)) {
    return { ok: false, error: 'Nazwa: 2–24 znaki, litery, cyfry, _ lub -.' };
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return { ok: false, error: 'Hasło musi mieć min. 4 znaki.' };
  }

  const rec = await makeRecord(password);
  const now = Date.now();

  if (isLocal()) {
    if (getLocalUser(u)) return { ok: false, error: 'Ta nazwa jest zajęta.' };
    setLocalUser(u, rec);
    saveSession(u);
    return succeed(u);
  }

  // Cloud: block duplicates up front (the create rule also enforces this).
  try {
    const snap = await getDoc(userDocRef(u));
    if (snap.exists()) return { ok: false, error: 'Ta nazwa jest zajęta.' };
  } catch (err) {
    console.warn('[auth] register pre-check failed', err);
    return { ok: false, error: 'Brak połączenia — spróbuj ponownie.' };
  }

  try {
    await setDoc(userDocRef(u), {
      salt: rec.salt, hash: rec.hash, iters: rec.iters,
      createdAt: now, lastLogin: now
    });
  } catch (err) {
    console.warn('[auth] register setDoc failed', err);
    // A denied create usually means the name was taken between check and write.
    return { ok: false, error: 'Nie udało się założyć konta — spróbuj ponownie.' };
  }

  saveSession(u);
  return succeed(u);
}

/**
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ok:true,user:{username:string}}|{ok:false,error:string}>}
 */
export async function login(username, password) {
  const u = String(username || '').toLowerCase();
  if (!USERNAME_RE.test(u)) {
    return { ok: false, error: 'Nazwa: 2–24 znaki, litery, cyfry, _ lub -.' };
  }
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, error: 'Podaj hasło.' };
  }

  let rec = null;
  if (isLocal()) {
    rec = getLocalUser(u);
  } else {
    try {
      const snap = await getDoc(userDocRef(u));
      rec = snap.exists() ? snap.data() : null;
    } catch (err) {
      console.warn('[auth] login getDoc failed', err);
      return { ok: false, error: 'Brak połączenia — spróbuj ponownie.' };
    }
  }

  if (!rec || !rec.salt || !rec.hash) {
    return { ok: false, error: 'Nie ma takiego konta.' };
  }

  const iters = Number(rec.iters) || PBKDF2_ITERS;
  const candidate = hexEncode(await deriveHash(password, hexDecode(rec.salt), iters));
  if (!hexEqual(candidate, rec.hash)) {
    return { ok: false, error: 'Złe hasło.' };
  }

  // Best-effort lastLogin touch (never blocks the login).
  if (!isLocal()) {
    updateDoc(userDocRef(u), { lastLogin: Date.now() }).catch((err) =>
      console.warn('[auth] lastLogin update failed', err)
    );
  }

  saveSession(u);
  return succeed(u);
}

/**
 * Restore a saved session. Verifies the user doc still exists (3s timeout); on a
 * network failure it trusts the cached session so offline boot works.
 * @returns {Promise<{ok:true,user:{username:string}}|{ok:false}>}
 */
export async function restoreSession() {
  const sess = lsGet(LS_SESSION, null);
  const u = sess && typeof sess.username === 'string' ? sess.username.toLowerCase() : null;
  if (!u || !USERNAME_RE.test(u)) return { ok: false };

  if (isLocal()) {
    if (getLocalUser(u)) return succeed(u);
    clearSession();
    return { ok: false };
  }

  try {
    const snap = await withTimeout(getDoc(userDocRef(u)), RESTORE_TIMEOUT_MS);
    if (snap && snap.exists()) return succeed(u);
    // Definitively gone -> stale session.
    clearSession();
    return { ok: false };
  } catch (err) {
    // Network failure / timeout -> offline boot must work; trust the cache.
    console.warn('[auth] session verify failed — trusting cached session (offline).', err);
    return succeed(u);
  }
}

/** Clear the session and reload (the only route back to the auth gate). */
export function logout() {
  clearSession();
  try { location.reload(); } catch { /* no location in some envs */ }
}

// ============================================================================
// Public: init()
// ============================================================================

/**
 * Restore a session if present (auth screen never shown, #auth-layer hidden), else
 * render the auth screen. Never throws. Does NOT block boot — the screen resolves
 * asynchronously via login()/register()'s shared success path.
 */
export async function init() {
  const layer = typeof document !== 'undefined' ? document.getElementById('auth-layer') : null;

  let restored = { ok: false };
  try {
    restored = await restoreSession();
  } catch (err) {
    console.warn('[auth] restoreSession threw (treating as no session)', err);
  }

  if (restored.ok) {
    hideAuthLayer(layer);
    return;
  }

  // No session — show the gate. mountAuthScreen wires exists/register/login and
  // handles its own success animation + hiding the layer.
  try {
    mountAuthScreen({ exists, register, login, isLocal });
  } catch (err) {
    console.error('[auth] mountAuthScreen failed', err);
  }
}

function hideAuthLayer(layer) {
  const el = layer || (typeof document !== 'undefined' ? document.getElementById('auth-layer') : null);
  if (!el) return;
  el.hidden = true;
  el.style.display = 'none';
}
