// js/bridge-client.js — browser side of the local bridge (infra-owned).
// Health-polls CONFIG.bridge.url, mirrors online/features onto the bus + state,
// and exposes projects / stt / token helpers. Everything is timeboxed and the
// health poll is the ONLY loop — no retry storms. init() NEVER throws.
//
// Token chain (getToken): bridge /token -> worker /token -> null. Honest
// degradation: a bridge that just fell emits one Polish toast in Edek's tone.

import { bus } from './core/event-bus.js';
import { state } from './core/state-manager.js';

const CONFIG = window.GZOWO_CONFIG;

// Timeouts (ms) — keep the UI snappy; a dead bridge must not hang callers.
const HEALTH_TIMEOUT = 3000;
const POLL_INTERVAL = 10000;
const TOKEN_TIMEOUT = 3000;
const PROJECTS_TIMEOUT = 5000;
const STT_TIMEOUT = 20000;

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
  _features: { projects: false, whisper: false, ha: false },
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
   * One health probe. Updates state on transitions, emits 'bridge:status',
   * and toasts once (Edek tone) the first time the bridge drops after being up.
   */
  async _poll() {
    let online = false;
    let features = { projects: false, whisper: false, ha: false };
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

      // First drop after having been online: honest degradation, Edek style.
      if (!online && this._everOnline) {
        bus.emit('toast', { text: 'Most padł — lecę w trybie lite.', kind: 'warn' });
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
