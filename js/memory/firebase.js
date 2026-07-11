// js/memory/firebase.js — MEMORY module (memory-owned), v2.
//
// Firestore ONLY. There is NO Firebase Auth here anymore — identity is owned by
// js/auth/custom-auth.js (salted PBKDF2 hashes in users/{username}). This module:
//   • initializes the Firestore app once (getDb() -> Firestore|null),
//   • attaches the logged-in user (attachUser) and loads their prefs + facts,
//   • mirrors everything to localStorage for an instant boot + honest offline,
//   • persists pref changes (debounced 800ms) and batches transcript writes.
//
// Docs are keyed by USERNAME (lowercase):
//   users/{username}                 root doc (created + owned by custom-auth)
//   users/{username}/meta/prefs      {theme,mode,muted,wakeEnabled,skills,pinned}
//   users/{username}/facts           {text,ts}          (learned facts about Jurek)
//   users/{username}/transcripts     {role,text,ts}     (batched conversation log)
//   users/{username}/notes           reserved for skills.js
//
// Everything degrades honestly: any Firestore read/write failure is logged, raises
// ONE 'toast' warn per session, and falls back to the localStorage mirror so the
// app never blocks. init() never throws; if config is a placeholder or Firestore
// fails to init, getDb() stays null and the app runs on local mirrors only.

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';

// ---- Firebase modular SDK v10 (CDN, no build) — FIRESTORE ONLY -------------
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  initializeFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  addDoc,
  deleteDoc,
  query,
  orderBy,
  limit,
  getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ============================================================================
// Constants
// ============================================================================

// Store keys we own: loaded from prefs, applied to state, persisted back.
// v2 adds 'skills' (array of enabled skill ids); v4 adds 'dashboardMode' (#18).
const PREF_KEYS = ['theme', 'mode', 'muted', 'wakeEnabled', 'dashboardMode', 'widgetConfirm', 'skills'];

const PREF_DEBOUNCE_MS = 800;           // per-key debounce for savePref persistence
const TRANSCRIPT_FLUSH_MS = 5000;       // max time between transcript flushes
const TRANSCRIPT_FLUSH_COUNT = 10;      // flush when this many buffered
const TRANSCRIPT_WRITE_CAP = 200;       // hard cap of Firestore writes / session
const LOCAL_TRANSCRIPT_CAP = 50;        // offline mirror keeps last N locally
const FACTS_CAP = 50;                   // facts: keep newest 50

// Default pinned shape (matches Firestore prefs.pinned layout).
const EMPTY_PINNED = { idle: [], talking: [], showing: [] };

// localStorage mirror keys are namespaced per username so two accounts on one
// device never clobber each other.
function prefsMirrorKey(u) { return 'gzowo.cache.prefs::' + u; }
function factsMirrorKey(u) { return 'gzowo.cache.facts::' + u; }
function transcriptMirrorKey(u) { return 'gzowo.cache.transcript::' + u; }

// ============================================================================
// Module state
// ============================================================================

let _app = null;
let _db = null;                         // Firestore | null (null => local-only)
let _username = null;                   // current attached user (lowercase) | null

let _prefsCache = null;                 // last-known prefs doc
let _factsCache = null;                 // last-known facts array (newest last)

let _offlineToastShown = false;         // 'memory offline' toast fires once/session
let _prefsSubscribed = false;           // guard: only wire state.subscribe once
const _prefUnsubs = [];                 // active state.subscribe disposers
const _prefTimers = new Map();          // key -> debounce timeout handle
let _applyingPrefs = false;             // true while we push loaded prefs INTO state

// Transcript batching.
let _transcriptBuf = [];                // pending entries {role,text,ts}
let _transcriptTimer = null;            // interval handle
let _transcriptWrites = 0;              // Firestore writes used this session

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
    // Storage full / disabled — best-effort mirror, stay silent.
  }
}

// ============================================================================
// Helpers — config / degradation
// ============================================================================

/** Placeholder detection: '' or starts with 'PASTE_'. */
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
    text: 'Pamięć chwilowo offline — działam na lokalnej kopii.',
    kind: 'warn'
  });
}

// ============================================================================
// Helpers — prefs normalization
// ============================================================================

/** Sanitize a raw prefs doc into a known shape. Unset scalar prefs stay
 *  `undefined` (ignoreUndefinedProperties handles the write side); pinned is
 *  always fully shaped. */
function normalizePrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const pinnedRaw = p.pinned && typeof p.pinned === 'object' ? p.pinned : {};
  return {
    theme: p.theme,
    mode: p.mode,
    muted: p.muted,
    wakeEnabled: p.wakeEnabled,
    dashboardMode: p.dashboardMode,
    widgetConfirm: p.widgetConfirm,
    skills: Array.isArray(p.skills) ? p.skills : undefined,
    pinned: {
      idle: Array.isArray(pinnedRaw.idle) ? pinnedRaw.idle : [],
      talking: Array.isArray(pinnedRaw.talking) ? pinnedRaw.talking : [],
      showing: Array.isArray(pinnedRaw.showing) ? pinnedRaw.showing : []
    }
  };
}

/** Return only the {theme?,mode?,muted?,wakeEnabled?,skills?} view. */
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
 * Push loaded prefs INTO the shared state store BEFORE 'memory:ready'. Guarded
 * by _applyingPrefs so the persistence subscribers below don't echo them back.
 * @param {object} prefs
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
 * Wire debounced persistence: any change to a PREF_KEY in state (from settings,
 * voice tools, etc.) is written through savePref after 800ms. Idempotent.
 */
function wirePrefPersistence() {
  if (_prefsSubscribed) return;
  _prefsSubscribed = true;

  for (const key of PREF_KEYS) {
    const unsub = state.subscribe(key, (val) => {
      if (_applyingPrefs) return;         // ignore the echo from applyPrefsToState()
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
// Firestore doc references (cloud mode only — guarded by _db && _username)
// ============================================================================

function prefsDocRef() {
  return doc(_db, 'users', _username, 'meta', 'prefs');
}
function factsColRef() {
  return collection(_db, 'users', _username, 'facts');
}
function transcriptsColRef() {
  return collection(_db, 'users', _username, 'transcripts');
}

// ============================================================================
// Prefs I/O
// ============================================================================

/** Authoritative prefs read; refreshes the instant-boot mirror. */
async function readPrefsDoc() {
  if (!_db || !_username) {
    return normalizePrefs(lsGet(prefsMirrorKey(_username), {}));
  }
  try {
    const snap = await getDoc(prefsDocRef());
    const data = snap.exists() ? snap.data() : {};
    const norm = normalizePrefs(data);
    lsSet(prefsMirrorKey(_username), norm);
    return norm;
  } catch (err) {
    warnOffline('readPrefs', err);
    return normalizePrefs(lsGet(prefsMirrorKey(_username), {}));
  }
}

/** Persist the whole (cached) prefs doc. Mirror is written first so a later
 *  network failure still boots correctly. */
async function writePrefsDoc(prefs) {
  const norm = normalizePrefs(prefs);
  if (_username) lsSet(prefsMirrorKey(_username), norm);
  if (!_db || !_username) return;
  try {
    // merge:true so partial writes never clobber sibling fields (e.g. pinned).
    await setDoc(prefsDocRef(), norm, { merge: true });
  } catch (err) {
    warnOffline('writePrefs', err);       // mirror already written — honest fallback
  }
}

// ============================================================================
// Facts I/O
// ============================================================================

async function readFacts() {
  if (!_db || !_username) {
    const arr = lsGet(factsMirrorKey(_username), []);
    return Array.isArray(arr) ? arr.slice(-FACTS_CAP) : [];
  }
  try {
    // Newest-last: take the newest FACTS_CAP by desc ts, then reverse.
    const q = query(factsColRef(), orderBy('ts', 'desc'), limit(FACTS_CAP));
    const snap = await getDocs(q);
    const rows = [];
    snap.forEach((d) => {
      const t = d.data() && d.data().text;
      if (typeof t === 'string') rows.push(t);
    });
    rows.reverse();                        // -> newest last
    lsSet(factsMirrorKey(_username), rows);
    return rows;
  } catch (err) {
    warnOffline('loadFacts', err);
    const arr = lsGet(factsMirrorKey(_username), []);
    return Array.isArray(arr) ? arr.slice(-FACTS_CAP) : [];
  }
}

// ============================================================================
// Transcript batching
// ============================================================================

/** Ensure the periodic flush timer is running (cloud mode only). */
function ensureTranscriptTimer() {
  if (!_db || _transcriptTimer) return;
  _transcriptTimer = setInterval(flushTranscript, TRANSCRIPT_FLUSH_MS);
}

/** Write buffered transcript entries to Firestore, honoring the per-session
 *  write cap. Fire-and-forget; failures warn once and stop, never block. */
async function flushTranscript() {
  if (!_db || !_username) { _transcriptBuf = []; return; }
  if (_transcriptBuf.length === 0) return;

  // Snapshot + clear so new appends keep flowing while we write.
  const batch = _transcriptBuf;
  _transcriptBuf = [];

  const col = transcriptsColRef();
  for (const entry of batch) {
    if (_transcriptWrites >= TRANSCRIPT_WRITE_CAP) {
      warnOffline('transcript-cap', new Error('per-session transcript write cap reached'));
      break;                               // drop the rest silently (non-critical)
    }
    try {
      await addDoc(col, {
        role: entry.role,
        text: entry.text,
        ts: entry.ts != null ? entry.ts : Date.now()
      });
      _transcriptWrites += 1;
    } catch (err) {
      warnOffline('appendTranscript', err);
      break;
    }
  }
}

// ============================================================================
// Public: init() — Firestore app only. Never throws.
// ============================================================================

export async function init() {
  const CONFIG = window.GZOWO_CONFIG || {};
  const fb = CONFIG.firebase;

  if (!isConfigValid(fb)) {
    console.warn('[memory] Firebase config is a placeholder — cloud memory off, running on local mirrors only.');
    _db = null;
    return;
  }

  try {
    _app = initializeApp(fb);
    // initializeFirestore (not getFirestore) so we can set ignoreUndefinedProperties.
    // normalizePrefs() emits `undefined` for any pref the user hasn't set yet;
    // without this, a setDoc() carrying an undefined sibling field THROWS and
    // silently kills all cloud pref persistence on fresh accounts.
    _db = initializeFirestore(_app, { ignoreUndefinedProperties: true });
  } catch (err) {
    console.warn('[memory] Firestore init failed — running on local mirrors only.', err);
    _db = null;
  }
}

// ============================================================================
// Public: attachUser() — called by custom-auth on every successful auth.
// ============================================================================

/**
 * Bind a username, load their prefs + facts (mirror-first for an instant boot),
 * apply prefs to state, wire debounced persistence, ensure the transcript timer,
 * and emit 'memory:ready' {prefs}. Never throws.
 * @param {string} username
 */
export async function attachUser(username) {
  _username = String(username || '').toLowerCase();

  // Instant boot: seed caches from the local mirror and apply immediately, so the
  // UI has the right theme/mode before any network read resolves.
  const mirror = lsGet(prefsMirrorKey(_username), null);
  if (mirror) {
    _prefsCache = normalizePrefs(mirror);
    applyPrefsToState(_prefsCache);
  }
  const factsMirror = lsGet(factsMirrorKey(_username), null);
  if (Array.isArray(factsMirror)) _factsCache = factsMirror.slice(-FACTS_CAP);

  // Authoritative reads (network in cloud mode, mirror otherwise), then reconcile.
  try {
    _prefsCache = await readPrefsDoc();
    _factsCache = await readFacts();
  } catch (err) {
    // readPrefsDoc/readFacts already degrade internally; this is belt-and-braces.
    console.warn('[memory] attachUser load failed', err);
    if (!_prefsCache) _prefsCache = normalizePrefs({});
    if (!_factsCache) _factsCache = [];
  }

  applyPrefsToState(_prefsCache);
  wirePrefPersistence();
  ensureTranscriptTimer();

  bus.emit('memory:ready', { prefs: prefsPublicView(_prefsCache) });
}

// ============================================================================
// Public: accessors
// ============================================================================

/** @returns {import('firebase/firestore').Firestore|null} */
export function getDb() {
  return _db;
}

/** @returns {string|null} */
export function getUsername() {
  return _username;
}

// ============================================================================
// Public: memory { ... }
// ============================================================================

export const memory = {
  attachUser,
  getDb,
  getUsername,

  /**
   * Load prefs -> {theme?,mode?,muted?,wakeEnabled?,skills?}. Uses the reconciled
   * in-memory cache when available, else reads the store.
   * @returns {Promise<object>}
   */
  async loadPrefs() {
    if (!_prefsCache) _prefsCache = await readPrefsDoc();
    return prefsPublicView(_prefsCache);
  },

  /**
   * Persist a single pref key/value. Updates the cached prefs doc and writes it
   * through (mirrors + degrades honestly). Only known pref keys are accepted.
   * @param {'theme'|'mode'|'muted'|'wakeEnabled'|'skills'} key
   * @param {*} val
   */
  savePref(key, val) {
    if (!PREF_KEYS.includes(key)) return;
    if (!_prefsCache) _prefsCache = normalizePrefs({});
    _prefsCache[key] = val;
    writePrefsDoc(_prefsCache);            // fire-and-forget
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
   * Append a transcript entry. Buffered in RAM, flushed every 5s / every 10
   * entries, capped at 200 Firestore writes/session. Without a db (local mode)
   * the last 50 are mirrored to localStorage. Fire-and-forget.
   * @param {{role:'user'|'gzowo', text:string, ts?:number}} entry
   */
  appendTranscript(entry) {
    if (!entry || typeof entry.text !== 'string') return;
    const rec = {
      role: entry.role === 'gzowo' ? 'gzowo' : 'user',
      text: entry.text,
      ts: entry.ts != null ? entry.ts : Date.now()
    };

    if (!_db) {
      // Local mode: keep a bounded honest mirror, no cloud writes.
      if (!_username) return;
      const arr = lsGet(transcriptMirrorKey(_username), []);
      const next = (Array.isArray(arr) ? arr : []).concat(rec).slice(-LOCAL_TRANSCRIPT_CAP);
      lsSet(transcriptMirrorKey(_username), next);
      return;
    }

    _transcriptBuf.push(rec);
    ensureTranscriptTimer();
    if (_transcriptBuf.length >= TRANSCRIPT_FLUSH_COUNT) flushTranscript();
  },

  /**
   * Save a learned fact about the user. Newest-last; cache trimmed to FACTS_CAP.
   * Fire-and-forget write with honest local fallback.
   * @param {string} text
   */
  async saveFact(text) {
    if (typeof text !== 'string' || text.trim() === '') return;
    const clean = text.trim();

    if (!_factsCache) _factsCache = [];
    _factsCache = _factsCache.concat(clean).slice(-FACTS_CAP);
    if (_username) lsSet(factsMirrorKey(_username), _factsCache);

    if (!_db || !_username) return;
    try {
      await addDoc(factsColRef(), { text: clean, ts: Date.now() });
    } catch (err) {
      warnOffline('saveFact', err);
    }
  },

  /**
   * Load learned facts -> string[] (max 50, newest last). Refreshes the cache.
   * @returns {Promise<string[]>}
   */
  async loadFacts() {
    _factsCache = await readFacts();
    return [..._factsCache];
  },

  /**
   * SYNC access to the last-loaded facts. gemini-live builds its system prompt
   * from this at connect() time WITHOUT awaiting the network (latency contract).
   * @returns {string[]}
   */
  getFactsCached() {
    return Array.isArray(_factsCache) ? [..._factsCache] : [];
  },

  /**
   * Forget facts matching `queryText` (case-insensitive substring). Updates the
   * cache + mirror and deletes the matching Firestore docs. Returns removed texts.
   * @param {string} queryText
   * @returns {Promise<string[]>}
   */
  async forgetFact(queryText) {
    const q = String(queryText || '').toLowerCase().trim();
    if (!q) return [];
    if (!_factsCache) _factsCache = [];
    const removed = _factsCache.filter((t) => String(t).toLowerCase().includes(q));
    if (!removed.length) return [];
    _factsCache = _factsCache.filter((t) => !String(t).toLowerCase().includes(q));
    if (_username) lsSet(factsMirrorKey(_username), _factsCache);

    if (_db && _username) {
      try {
        // No substring queries in Firestore — scan recent facts, delete matches.
        const snap = await getDocs(query(factsColRef(), orderBy('ts', 'desc'), limit(FACTS_CAP)));
        const dels = [];
        snap.forEach((d) => {
          const t = d.data() && d.data().text;
          if (typeof t === 'string' && t.toLowerCase().includes(q)) dels.push(deleteDoc(d.ref));
        });
        await Promise.all(dels);
      } catch (err) { warnOffline('forgetFact', err); }
    }
    return removed;
  },

  /**
   * Search the conversation history for `queryText` (case-insensitive substring).
   * Cloud: scans the newest `scan` transcripts; local: the mirror. Returns the
   * matching {role,text,ts} entries (newest first, capped).
   * @param {string} queryText
   * @param {number} [max=12]
   * @returns {Promise<Array<{role:string,text:string,ts:number}>>}
   */
  async searchTranscripts(queryText, max = 12) {
    const q = String(queryText || '').toLowerCase().trim();
    if (!q) return [];
    const pick = (rows) => rows
      .filter((r) => r && typeof r.text === 'string' && r.text.toLowerCase().includes(q))
      .slice(0, max);

    if (!_db || !_username) {
      const arr = lsGet(transcriptMirrorKey(_username), []);
      const rows = (Array.isArray(arr) ? arr : []).slice().reverse();  // newest first
      return pick(rows);
    }
    try {
      const snap = await getDocs(query(transcriptsColRef(), orderBy('ts', 'desc'), limit(400)));
      const rows = [];
      snap.forEach((d) => { const x = d.data(); if (x) rows.push({ role: x.role, text: x.text, ts: x.ts }); });
      return pick(rows);
    } catch (err) {
      warnOffline('searchTranscripts', err);
      const arr = lsGet(transcriptMirrorKey(_username), []);
      return pick((Array.isArray(arr) ? arr : []).slice().reverse());
    }
  }
};
