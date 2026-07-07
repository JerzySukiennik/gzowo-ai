// js/memory/firebase.js — MEMORY module (memory-owned).
// Auth + cross-device memory for Gzowo. Firestore is the source of truth;
// localStorage mirrors give an instant boot and an honest offline fallback.
//
// Boot flow (per contract):
//   init() -> if config valid: initializeApp + onAuthStateChanged.
//     user present  -> state.set('user'), emit 'auth:ready' {user, demo:false},
//                      load prefs + pinned, APPLY to state, emit 'memory:ready'.
//     signed out     -> emit 'auth:ready' {user:null, demo:false}.
//   If config is placeholder -> DEMO MODE: console.warn, state.set('demo',true),
//     emit 'auth:ready' {user:null, demo:true}; all persistence via localStorage
//     keys 'gzowo.demo.*'. We NEVER pretend demo data is cloud.
//
// Everything degrades honestly: a Firestore read/write that fails is logged,
// raises ONE 'toast' warn per session, and falls back to the localStorage
// mirror so the app never blocks.

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';

// ---- Firebase modular SDK v10 (CDN, no build) ------------------------------
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore,
  initializeFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  getDocs,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ============================================================================
// Constants
// ============================================================================

// Store keys we own: loaded from prefs, applied to state, and persisted back.
const PREF_KEYS = ['theme', 'mode', 'muted', 'wakeEnabled'];

// localStorage key namespaces.
const LS = {
  demoPrefs: 'gzowo.demo.prefs',        // demo-mode prefs doc mirror
  demoFacts: 'gzowo.demo.facts',        // demo-mode facts (array of strings)
  demoTranscript: 'gzowo.demo.transcript', // demo-mode last 50 transcript entries
  cachePrefs: 'gzowo.cache.prefs',      // cloud prefs mirror (instant boot)
  cacheFacts: 'gzowo.cache.facts'       // cloud facts mirror
};

const PREF_DEBOUNCE_MS = 800;           // per-key debounce for savePref persistence
const TRANSCRIPT_FLUSH_MS = 5000;       // max time between transcript flushes
const TRANSCRIPT_FLUSH_COUNT = 10;      // flush when this many buffered
const TRANSCRIPT_WRITE_CAP = 200;       // hard cap of Firestore writes / session
const DEMO_TRANSCRIPT_CAP = 50;         // demo keeps last N locally
const FACTS_CAP = 50;                   // facts: keep newest 50

// Default pinned shape (matches Firestore prefs.pinned layout).
const EMPTY_PINNED = { idle: [], talking: [], showing: [] };

// ============================================================================
// Module state
// ============================================================================

let _demo = false;                      // running without real Firebase?
let _app = null;
let _auth = null;
let _db = null;
let _uid = null;                        // current signed-in uid (null when out)

let _prefsCache = null;                 // last-known prefs doc {theme,mode,muted,wakeEnabled,pinned}
let _factsCache = null;                 // last-known facts array (newest last)

let _offlineToastShown = false;         // 'memory offline' toast fires once/session
let _prefsSubscribed = false;           // guard: only wire state.subscribe once
const _prefUnsubs = [];                 // active state.subscribe disposers
const _prefTimers = new Map();          // key -> debounce timeout handle
let _applyingPrefs = false;             // true while we push loaded prefs INTO state
                                        // (so our own subscribers don't echo them back)

// Transcript batching.
let _transcriptBuf = [];                // pending entries {role,text,ts}
let _transcriptTimer = null;            // interval handle
let _transcriptWrites = 0;             // Firestore writes used this session

// ============================================================================
// Helpers — localStorage (safe)
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
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    // Storage full / disabled — nothing we can do, stay silent (best-effort mirror).
  }
}

// ============================================================================
// Helpers — config / degradation
// ============================================================================

/** Placeholder detection per contract: '' or starts with 'PASTE_'. */
function isPlaceholder(v) {
  return typeof v !== 'string' || v === '' || v.startsWith('PASTE_');
}

/** A Firebase config is usable only if the boot-critical fields are real. */
function isConfigValid(fb) {
  if (!fb) return false;
  return !isPlaceholder(fb.apiKey)
    && !isPlaceholder(fb.authDomain)
    && !isPlaceholder(fb.projectId);
}

/** Fire the "memory offline" toast at most once per session. */
function warnOffline(where, err) {
  console.warn('[memory] Firestore unavailable —', where, err);
  if (_offlineToastShown) return;
  _offlineToastShown = true;
  bus.emit('toast', {
    text: 'Pamięć chwilowo offline — lecę na lokalnej.',
    kind: 'warn'
  });
}

// ============================================================================
// Helpers — prefs normalization
// ============================================================================

/** Sanitize a raw prefs doc into a known shape (missing keys stay undefined
 *  where the contract wants optionality, but pinned is always fully shaped). */
function normalizePrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const pinnedRaw = p.pinned && typeof p.pinned === 'object' ? p.pinned : {};
  return {
    theme: p.theme,
    mode: p.mode,
    muted: p.muted,
    wakeEnabled: p.wakeEnabled,
    pinned: {
      idle: Array.isArray(pinnedRaw.idle) ? pinnedRaw.idle : [],
      talking: Array.isArray(pinnedRaw.talking) ? pinnedRaw.talking : [],
      showing: Array.isArray(pinnedRaw.showing) ? pinnedRaw.showing : []
    }
  };
}

/** Return only the {theme?,mode?,muted?,wakeEnabled?} view of a prefs doc. */
function prefsPublicView(p) {
  const out = {};
  for (const k of PREF_KEYS) {
    if (p && p[k] !== undefined) out[k] = p[k];
  }
  return out;
}

// ============================================================================
// Apply prefs to state + wire persistence
// ============================================================================

/**
 * Push loaded prefs INTO the shared state store (theme/mode/muted/wakeEnabled)
 * BEFORE 'memory:ready' is emitted. Guarded by _applyingPrefs so the
 * persistence subscribers below don't immediately write them back.
 */
function applyPrefsToState(prefs) {
  _applyingPrefs = true;
  try {
    for (const k of PREF_KEYS) {
      if (prefs && prefs[k] !== undefined) {
        state.set(k, prefs[k]);
      }
    }
  } finally {
    _applyingPrefs = false;
  }
}

/**
 * Wire debounced persistence: any change to theme/mode/muted/wakeEnabled in
 * state (from HUD, voice tools, etc.) is written through savePref after 800ms.
 * Idempotent — only wires once per session.
 */
function wirePrefPersistence() {
  if (_prefsSubscribed) return;
  _prefsSubscribed = true;

  for (const key of PREF_KEYS) {
    const unsub = state.subscribe(key, (val) => {
      // Ignore the echo from our own applyPrefsToState().
      if (_applyingPrefs) return;
      // Debounce per key.
      const prev = _prefTimers.get(key);
      if (prev) clearTimeout(prev);
      _prefTimers.set(key, setTimeout(() => {
        _prefTimers.delete(key);
        memory.savePref(key, val);
      }, PREF_DEBOUNCE_MS));
    });
    _prefUnsubs.push(unsub);
  }
}

// ============================================================================
// Firestore doc references (real mode only)
// ============================================================================

function userDocRef() {
  return doc(_db, 'users', _uid);
}
function prefsDocRef() {
  return doc(_db, 'users', _uid, 'meta', 'prefs');
}
function factsColRef() {
  return collection(_db, 'users', _uid, 'facts');
}
function transcriptsColRef() {
  return collection(_db, 'users', _uid, 'transcripts');
}

// ============================================================================
// Prefs I/O
// ============================================================================

/**
 * Read prefs. Instant-boot strategy: return the localStorage mirror first if we
 * have one (handled by caller reading cache), then reconcile with the network
 * read here. This function performs the authoritative read and updates caches.
 */
async function readPrefsDoc() {
  if (_demo) {
    return normalizePrefs(lsGet(LS.demoPrefs, {}));
  }
  try {
    const snap = await getDoc(prefsDocRef());
    const data = snap.exists() ? snap.data() : {};
    const norm = normalizePrefs(data);
    lsSet(LS.cachePrefs, norm); // refresh instant-boot mirror
    return norm;
  } catch (err) {
    warnOffline('readPrefs', err);
    return normalizePrefs(lsGet(LS.cachePrefs, {}));
  }
}

/** Persist the whole (cached) prefs doc back to its store. */
async function writePrefsDoc(prefs) {
  const norm = normalizePrefs(prefs);
  if (_demo) {
    lsSet(LS.demoPrefs, norm);
    return;
  }
  // Always keep the mirror fresh so a later failure still boots correctly.
  lsSet(LS.cachePrefs, norm);
  try {
    // merge:true so partial docs never clobber sibling fields (e.g. pinned).
    await setDoc(prefsDocRef(), norm, { merge: true });
  } catch (err) {
    warnOffline('writePrefs', err);
    // Mirror already written above — honest local fallback.
  }
}

// ============================================================================
// Facts I/O
// ============================================================================

async function readFacts() {
  if (_demo) {
    const arr = lsGet(LS.demoFacts, []);
    return Array.isArray(arr) ? arr.slice(-FACTS_CAP) : [];
  }
  try {
    // Newest-last: order by ts asc, cap to newest FACTS_CAP by taking the tail
    // of a desc-limited query then reversing.
    const q = query(factsColRef(), orderBy('ts', 'desc'), limit(FACTS_CAP));
    const snap = await getDocs(q);
    const rows = [];
    snap.forEach((d) => {
      const t = d.data() && d.data().text;
      if (typeof t === 'string') rows.push(t);
    });
    rows.reverse(); // -> newest last
    lsSet(LS.cacheFacts, rows);
    return rows;
  } catch (err) {
    warnOffline('loadFacts', err);
    const arr = lsGet(LS.cacheFacts, []);
    return Array.isArray(arr) ? arr.slice(-FACTS_CAP) : [];
  }
}

// ============================================================================
// Transcript batching
// ============================================================================

/** Ensure the periodic flush timer is running (real mode only). */
function ensureTranscriptTimer() {
  if (_demo || _transcriptTimer) return;
  _transcriptTimer = setInterval(() => {
    flushTranscript();
  }, TRANSCRIPT_FLUSH_MS);
}

/** Write buffered transcript entries to Firestore (batched addDoc), honoring
 *  the per-session write cap. Fire-and-forget; failures are silent-dropped
 *  after mirroring the buffer locally so nothing blocks. */
async function flushTranscript() {
  if (_demo) { _transcriptBuf = []; return; }
  if (_transcriptBuf.length === 0) return;
  if (!_uid) return;

  // Take a snapshot and clear the buffer up front so new appends keep flowing.
  const batch = _transcriptBuf;
  _transcriptBuf = [];

  const col = transcriptsColRef();
  for (const entry of batch) {
    if (_transcriptWrites >= TRANSCRIPT_WRITE_CAP) {
      // Cap hit: stop writing this session. Drop the rest silently (transcripts
      // are non-critical). Only note it once via the offline toast channel.
      warnOffline('transcript-cap', new Error('per-session transcript write cap reached'));
      break;
    }
    try {
      await addDoc(col, {
        role: entry.role,
        text: entry.text,
        ts: entry.ts != null ? entry.ts : Date.now()
      });
      _transcriptWrites += 1;
    } catch (err) {
      // Silent-drop after a single honest warn — never block the app.
      warnOffline('appendTranscript', err);
      break;
    }
  }
}

// ============================================================================
// Sign-in success flow (shared by real onAuthStateChanged and demo signIn)
// ============================================================================

/**
 * Common post-auth flow: publish the user, load prefs + pinned, apply prefs to
 * state, wire persistence, then emit 'memory:ready'. Also writes the users/{uid}
 * doc (real mode) with lastLogin.
 * @param {{uid:string,name:string,email:string}} user
 */
async function onSignedIn(user) {
  _uid = user.uid;
  state.set('user', user);
  state.set('authResolved', true);
  bus.emit('auth:ready', { user, demo: _demo });

  // Touch the user doc (real mode) — name/email/lastLogin. Best-effort.
  if (!_demo) {
    try {
      await setDoc(
        userDocRef(),
        { name: user.name, email: user.email, lastLogin: serverTimestamp() },
        { merge: true }
      );
    } catch (err) {
      warnOffline('userDoc', err);
    }
  }

  // Instant-boot: seed cache from the local mirror first (real mode), so the UI
  // has something immediately, then reconcile with the authoritative read.
  if (!_demo) {
    const mirror = lsGet(LS.cachePrefs, null);
    if (mirror) _prefsCache = normalizePrefs(mirror);
  }

  // Authoritative prefs read (network in real mode, LS in demo).
  _prefsCache = await readPrefsDoc();
  _factsCache = await readFacts();

  // Apply prefs to state BEFORE 'memory:ready', then wire persistence so later
  // changes flow back out (debounced). Order matters: apply first, wire after,
  // so the initial apply is never mistaken for a user edit.
  applyPrefsToState(_prefsCache);
  wirePrefPersistence();
  ensureTranscriptTimer();

  bus.emit('memory:ready', { prefs: prefsPublicView(_prefsCache) });
}

/** Sign-out flow: clear session-scoped memory, flush pending transcript. */
function onSignedOut() {
  flushTranscript(); // best-effort final flush of whatever is buffered
  _uid = null;
  state.set('user', null);
  state.set('authResolved', true);
  bus.emit('auth:ready', { user: null, demo: _demo });
}

// ============================================================================
// Public: init()
// ============================================================================

export async function init() {
  const CONFIG = window.GZOWO_CONFIG || {};
  const fb = CONFIG.firebase;

  // ---- DEMO MODE (placeholder config) --------------------------------------
  if (!isConfigValid(fb)) {
    _demo = true;
    console.warn(
      '[memory] DEMO MODE — Firebase config is placeholder. Persistence via localStorage only; nic nie leci do chmury.'
    );
    state.set('demo', true);
    state.set('authResolved', true);
    // Signed-out at boot; the intro shows the demo badge off state.get('demo').
    bus.emit('auth:ready', { user: null, demo: true });
    return;
  }

  // ---- REAL MODE -----------------------------------------------------------
  try {
    _app = initializeApp(fb);
    _auth = getAuth(_app);
    // initializeFirestore (not getFirestore) so we can set ignoreUndefinedProperties.
    // normalizePrefs() emits `undefined` for any pref the user hasn't set yet;
    // without this, the first setDoc() with an undefined sibling field THROWS
    // ("Unsupported field value: undefined"), silently killing ALL cloud prefs +
    // pinned persistence on fresh accounts (only the localStorage mirror survives).
    _db = initializeFirestore(_app, { ignoreUndefinedProperties: true });
  } catch (err) {
    // Firebase itself failed to initialize — degrade to demo so the app boots.
    console.warn('[memory] Firebase init failed — falling back to demo mode.', err);
    _demo = true;
    state.set('demo', true);
    state.set('authResolved', true);
    bus.emit('auth:ready', { user: null, demo: true });
    return;
  }

  // Auth listener drives the whole flow. It fires immediately with the current
  // user (or null) and again on every sign-in/out.
  onAuthStateChanged(_auth, (fbUser) => {
    if (fbUser) {
      const email = fbUser.email || '';
      const name = fbUser.displayName || (email ? email.split('@')[0] : 'GOŚĆ');
      // onSignedIn is async; fire-and-forget (errors are internally handled).
      onSignedIn({ uid: fbUser.uid, name, email }).catch((err) => {
        console.error('[memory] onSignedIn failed', err);
        // Still surface auth so boot never hangs.
        bus.emit('memory:ready', { prefs: {} });
      });
    } else {
      onSignedOut();
    }
  });
}

// ============================================================================
// Public: signIn / signOutUser
// ============================================================================

/**
 * Sign in. Real mode maps Firebase errors to Edek-flavored PL messages.
 * Demo mode accepts any non-empty credentials and synthesizes a demo user,
 * firing the same auth:ready/memory:ready flow.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ok:true}|{ok:false,error:string}>}
 */
export async function signIn(email, password) {
  // ---- DEMO ----
  if (_demo) {
    if (!email || !password) {
      return { ok: false, error: 'Podaj login i hasło, człowieku.' };
    }
    const local = String(email).split('@')[0] || 'GOŚĆ';
    const user = { uid: 'demo', name: local, email: String(email) };
    await onSignedIn(user);
    return { ok: true };
  }

  // ---- REAL ----
  if (!_auth) {
    return { ok: false, error: 'Coś nie pykło — spróbuj jeszcze raz' };
  }
  try {
    await signInWithEmailAndPassword(_auth, email, password);
    // onAuthStateChanged will drive onSignedIn -> auth:ready/memory:ready.
    return { ok: true };
  } catch (err) {
    return { ok: false, error: mapAuthError(err && err.code) };
  }
}

/** Map Firebase auth error codes to short PL messages in Edek tone. */
function mapAuthError(code) {
  switch (code) {
    case 'auth/wrong-password':
      return 'Złe hasło';
    case 'auth/user-not-found':
      return 'Nie ma takiego konta';
    case 'auth/invalid-credential':
      // v10 collapses wrong-password/user-not-found into invalid-credential.
      return 'Złe hasło albo nie ma takiego konta';
    case 'auth/network-request-failed':
      return 'Błąd sieci';
    default:
      return 'Coś nie pykło — spróbuj jeszcze raz';
  }
}

export async function signOutUser() {
  // Flush any buffered transcript before tearing down.
  await flushTranscript();

  if (_demo) {
    // Demo has no real session; just publish the signed-out state.
    onSignedOut();
    return;
  }
  if (!_auth) return;
  try {
    await signOut(_auth);
    // onAuthStateChanged(null) will fire onSignedOut for us.
  } catch (err) {
    console.warn('[memory] signOut failed', err);
    // Force the signed-out state locally so the UI isn't stuck.
    onSignedOut();
  }
}

// ============================================================================
// Public: memory { ... }
// ============================================================================

export const memory = {
  /**
   * Load prefs -> {theme?,mode?,muted?,wakeEnabled?}. Uses the in-memory cache
   * when available (already reconciled at sign-in), else reads the store.
   * @returns {Promise<{theme?:string,mode?:object,muted?:boolean,wakeEnabled?:boolean}>}
   */
  async loadPrefs() {
    if (!_prefsCache) {
      _prefsCache = await readPrefsDoc();
    }
    return prefsPublicView(_prefsCache);
  },

  /**
   * Persist a single pref key/value. Updates the cached prefs doc and writes it
   * through (debounced at the call site via state.subscribe, but also safe to
   * call directly). Only known pref keys are accepted.
   * @param {'theme'|'mode'|'muted'|'wakeEnabled'} key
   * @param {*} val
   */
  savePref(key, val) {
    if (!PREF_KEYS.includes(key)) return;
    if (!_prefsCache) _prefsCache = normalizePrefs({});
    _prefsCache[key] = val;
    // Fire-and-forget write; internally mirrors + degrades honestly.
    writePrefsDoc(_prefsCache);
  },

  /**
   * Read pinned widget ids for a UI state from the cached prefs doc.
   * @param {'idle'|'talking'|'showing'} uiState
   * @returns {string[]}
   */
  getPinned(uiState) {
    const pinned = (_prefsCache && _prefsCache.pinned) || EMPTY_PINNED;
    const arr = pinned[uiState];
    return Array.isArray(arr) ? [...arr] : [];
  },

  /**
   * Set pinned widget ids for a UI state and persist the prefs doc.
   * @param {'idle'|'talking'|'showing'} uiState
   * @param {string[]} ids
   */
  async setPinned(uiState, ids) {
    if (!['idle', 'talking', 'showing'].includes(uiState)) return;
    if (!_prefsCache) _prefsCache = normalizePrefs({});
    if (!_prefsCache.pinned) _prefsCache.pinned = { ...EMPTY_PINNED };
    _prefsCache.pinned[uiState] = Array.isArray(ids) ? [...ids] : [];
    await writePrefsDoc(_prefsCache);
  },

  /**
   * Append a transcript entry. Buffered in RAM, flushed every 5s or every 10
   * entries, capped at 200 Firestore writes/session. Fire-and-forget. In demo
   * mode we keep only the last 50 entries in localStorage (no cloud).
   * @param {{role:'user'|'gzowo', text:string, ts?:number}} entry
   */
  appendTranscript(entry) {
    if (!entry || typeof entry.text !== 'string') return;
    const rec = {
      role: entry.role === 'gzowo' ? 'gzowo' : 'user',
      text: entry.text,
      ts: entry.ts != null ? entry.ts : Date.now()
    };

    if (_demo) {
      // Demo: mirror last N locally, no cloud writes.
      const arr = lsGet(LS.demoTranscript, []);
      const next = (Array.isArray(arr) ? arr : []).concat(rec).slice(-DEMO_TRANSCRIPT_CAP);
      lsSet(LS.demoTranscript, next);
      return;
    }

    _transcriptBuf.push(rec);
    ensureTranscriptTimer();
    if (_transcriptBuf.length >= TRANSCRIPT_FLUSH_COUNT) {
      // Fire-and-forget size-triggered flush.
      flushTranscript();
    }
  },

  /**
   * Save a learned fact about the user. Newest-last semantics; cache trimmed to
   * FACTS_CAP. Fire-and-forget write with honest local fallback.
   * @param {string} text
   */
  async saveFact(text) {
    if (typeof text !== 'string' || text.trim() === '') return;
    const clean = text.trim();

    if (!_factsCache) _factsCache = [];
    _factsCache = _factsCache.concat(clean).slice(-FACTS_CAP);

    if (_demo) {
      lsSet(LS.demoFacts, _factsCache);
      return;
    }

    // Keep the cloud mirror fresh regardless of network outcome.
    lsSet(LS.cacheFacts, _factsCache);
    try {
      await addDoc(factsColRef(), { text: clean, ts: Date.now() });
    } catch (err) {
      warnOffline('saveFact', err);
    }
  },

  /**
   * Load learned facts -> string[] (max 50, newest last).
   * @returns {Promise<string[]>}
   */
  async loadFacts() {
    _factsCache = await readFacts();
    return [..._factsCache];
  }
};
