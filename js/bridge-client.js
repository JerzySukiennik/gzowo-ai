// js/bridge-client.js — browser side of the local bridge (infra-owned).
// Health-polls CONFIG.bridge.url, mirrors online/features onto the bus + state,
// and exposes projects / stt / token helpers. Everything is timeboxed and the
// health poll is the ONLY loop — no retry storms. init() NEVER throws.
//
// Token chain (getToken): bridge /token -> worker /token -> null. Honest
// degradation: a bridge that just fell emits one plain Polish toast.

import { bus } from './core/event-bus.js';
import { state } from './core/state-manager.js';

const CONFIG = window.GZOWO_CONFIG;

// Timeouts (ms) — keep the UI snappy; a dead bridge must not hang callers.
const HEALTH_TIMEOUT = 3000;
const POLL_INTERVAL = 10000;
const TOKEN_TIMEOUT = 3000;
const PROJECTS_TIMEOUT = 5000;
const STT_TIMEOUT = 20000;
const HA_STATES_TIMEOUT = 6000;   // read path — fast
const HA_SERVICE_TIMEOUT = 8000;  // mutating call — a touch more slack
const HA_BAMBU_TIMEOUT = 8000;    // reads the full state list, then filters
const FETCH_PAGE_TIMEOUT = 12000; // remote page fetch happens server-side

// Parse a non-OK bridge response into a thrown {status, error, ...} object.
async function parseErr(res) {
  let err = { status: res.status };
  try { err = { ...err, ...(await res.json()) }; } catch { /* non-JSON body */ }
  return err;
}

function bridgeUrl(path) {
  const base = (CONFIG && CONFIG.bridge && CONFIG.bridge.url) || '';
  return base.replace(/\/$/, '') + path;
}

function workerUrl(path) {
  const base = (CONFIG && CONFIG.worker && CONFIG.worker.url) || '';
  if (!base) return null;
  return base.replace(/\/$/, '') + path;
}

export const bridgeClient = {
  _online: false,
  _features: { projects: false, whisper: false, ha: false, fetch: false },
  _everOnline: false,   // have we ever seen the bridge up? (gates the "fell" toast)
  _polling: false,

  /**
   * Start health polling. Idempotent, never throws.
   */
  async init() {
    if (this._polling) return;
    this._polling = true;
    await this._poll();               // first probe immediately
    setInterval(() => this._poll(), POLL_INTERVAL); // the ONLY loop
  },

  /** @returns {boolean} last known online status */
  online() {
    return this._online;
  },

  /**
   * Last known feature map from /health. Consumers (e.g. the Home Assistant
   * connector) read this to decide availability without re-probing.
   * @returns {{projects:boolean, whisper:boolean, ha:boolean, fetch:boolean}}
   */
  features() {
    return this._features;
  },

  /**
   * One health probe. Updates state on transitions, emits 'bridge:status',
   * and toasts once the first time the bridge drops after having been up.
   */
  async _poll() {
    let online = false;
    let features = { projects: false, whisper: false, ha: false, fetch: false };
    try {
      const res = await fetch(bridgeUrl('/health'), {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT)
      });
      if (res.ok) {
        const data = await res.json();
        online = Boolean(data && data.ok);
        if (data && data.features) features = data.features;
      }
    } catch {
      online = false;
    }

    const changed = online !== this._online;
    this._online = online;
    this._features = features;

    if (online) this._everOnline = true;

    if (changed) {
      // Mirror to the shared store and announce on the bus.
      state.set('bridgeOnline', online);
      bus.emit('bridge:status', { online, features });

      // First drop after having been online: honest degradation notice.
      if (!online && this._everOnline) {
        bus.emit('toast', { text: 'Most offline — część funkcji niedostępna.', kind: 'warn' });
      }
    }
  },

  /**
   * Fetch the light projects index from the bridge.
   * @returns {Promise<Array>} throws {offline:true} when the bridge is down.
   */
  async getProjects() {
    if (!this._online) throw { offline: true };
    const res = await fetch(bridgeUrl('/projects'), {
      signal: AbortSignal.timeout(PROJECTS_TIMEOUT)
    });
    if (!res.ok) throw { status: res.status };
    return res.json();
  },

  /**
   * Transcribe a WAV blob via the bridge's whisper STT.
   * @param {Blob} blob  audio/wav
   * @returns {Promise<{text:string}>}
   */
  async stt(blob) {
    if (!this._online) throw { offline: true };
    const res = await fetch(bridgeUrl('/stt'), {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: blob,
      signal: AbortSignal.timeout(STT_TIMEOUT)
    });
    if (!res.ok) {
      let err = { status: res.status };
      try { err = { ...err, ...(await res.json()) }; } catch { /* ignore */ }
      throw err;
    }
    return res.json();
  },

  /**
   * List Home Assistant states via the bridge (already trimmed server-side).
   * @param {{domain?:string, prefix?:string}} [opts] optional filters
   * @returns {Promise<Array<{entity_id:string,state:string,attributes:object}>>}
   *          throws {offline:true} when the bridge is down; {status,error} on non-OK.
   */
  async haStates({ domain, prefix } = {}) {
    if (!this._online) throw { offline: true };
    const qs = new URLSearchParams();
    if (domain) qs.set('domain', domain);
    if (prefix) qs.set('prefix', prefix);
    const q = qs.toString();
    const res = await fetch(bridgeUrl('/ha/states' + (q ? '?' + q : '')), {
      signal: AbortSignal.timeout(HA_STATES_TIMEOUT)
    });
    if (!res.ok) throw await parseErr(res);
    return res.json();
  },

  /**
   * Call a Home Assistant service through the bridge.
   * @param {{domain:string, service:string, data?:object}} payload
   * @returns {Promise<Array>} HA's changed-states array (may be empty).
   *          throws {offline:true} when the bridge is down; {status,error} on non-OK.
   */
  async haService({ domain, service, data } = {}) {
    if (!this._online) throw { offline: true };
    const res = await fetch(bridgeUrl('/ha/service'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, service, data: data || {} }),
      signal: AbortSignal.timeout(HA_SERVICE_TIMEOUT)
    });
    if (!res.ok) throw await parseErr(res);
    return res.json();
  },

  /**
   * Fetch the Bambu printer + camera summary the bridge assembles from HA.
   * @returns {Promise<{ok:boolean, printer:object, camera:object|null}>}
   *          throws {offline:true} when the bridge is down; {status,error} on non-OK.
   */
  async haBambu() {
    if (!this._online) throw { offline: true };
    const res = await fetch(bridgeUrl('/ha/bambu'), {
      signal: AbortSignal.timeout(HA_BAMBU_TIMEOUT)
    });
    if (!res.ok) throw await parseErr(res);
    return res.json();
  },

  /**
   * Server-side fetch of a web page (title + stripped text) via the bridge.
   * @param {string} url  http/https URL to fetch
   * @returns {Promise<{ok:boolean, title:string, text:string}>}
   *          throws {offline:true} when the bridge is down; {status,error} on non-OK.
   */
  async fetchPage(url) {
    if (!this._online) throw { offline: true };
    const res = await fetch(bridgeUrl('/fetch?url=' + encodeURIComponent(url)), {
      signal: AbortSignal.timeout(FETCH_PAGE_TIMEOUT)
    });
    if (!res.ok) throw await parseErr(res);
    return res.json();
  },

  /**
   * Resolve a Gemini credential. Chain: bridge /token -> worker /token -> null.
   * Returns {token} (ephemeral name) or {apiKey} (LAN-only insecure fallback),
   * or null if neither source is available. Never throws.
   * @returns {Promise<{token:string}|{apiKey:string}|null>}
   */
  async getToken() {
    // 1. Local bridge — best path (ephemeral token or LAN insecure key).
    try {
      const res = await fetch(bridgeUrl('/token'), {
        signal: AbortSignal.timeout(TOKEN_TIMEOUT)
      });
      if (res.ok) {
        const data = await res.json();
        if (data && (data.token || data.apiKey)) return data;
      }
    } catch {
      /* fall through to worker */
    }

    // 2. Cloudflare Worker — deployed-mode ephemeral token.
    const wurl = workerUrl('/token');
    if (wurl) {
      try {
        const res = await fetch(wurl, { signal: AbortSignal.timeout(TOKEN_TIMEOUT) });
        if (res.ok) {
          const data = await res.json();
          if (data && data.token) return { token: data.token };
        }
      } catch {
        /* fall through to null */
      }
    }

    // 3. Nothing available — caller degrades honestly.
    return null;
  }
};

/**
 * Module init entry point (main.js calls bridgeClient.init(); this mirror keeps
 * the `export async function init()` convention available too). Never throws.
 */
export async function init() {
  return bridgeClient.init();
}
