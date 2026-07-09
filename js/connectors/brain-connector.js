// js/connectors/brain-connector.js — shared source of truth for the
// "Jurek's 2nd Brain" connector state (activation + LAN pass), used by BOTH the
// Settings connector row and the brain_* voice tools so they never disagree.
//
// Model per CONNECTOR-2ND-BRAIN.md: the connector is visible but INACTIVE until
// Jurek activates it with the LAN pass. Activation + the entered pass are
// remembered per-account in localStorage (a home/LAN password, not a bank
// secret). The bridge still enforces X-Brain-Pass on every request — this is
// only the client-side gate + remembered pass.
//
// GLOBAL RULES: logic only; English comments; honest failure; never throws.

import { state } from '../core/state-manager.js';

// No hardcoded pass in the (public) client: the pass Jurek types at activation is
// what gets stored; CONFIG.brain.pass is an optional local override. An empty pass
// simply 401s at the bridge — honest failure.
const CONFIG = window.GZOWO_CONFIG || {};
const DEFAULT_PASS = (CONFIG.brain && CONFIG.brain.pass) || '';

export function bridgeUrl() { return (CONFIG.bridge && CONFIG.bridge.url) || ''; }

// localStorage key is namespaced per username so two accounts on one machine
// don't share activation. Settings only opens post-auth, so `user` is set by then;
// '__anon' is a safe pre-auth fallback that simply never matches a real account.
function nsKey() {
  const u = state.get('user');
  const name = (u && u.username) ? String(u.username) : '__anon';
  return 'gz.brain.' + name;
}

function read() {
  try { return JSON.parse(localStorage.getItem(nsKey()) || 'null'); }
  catch { return null; }
}

function write(obj) {
  try { localStorage.setItem(nsKey(), JSON.stringify(obj)); }
  catch (_e) { /* storage may be unavailable (private mode) — degrade to session */ }
}

export const brainConnector = {
  /** @returns {boolean} true once Jurek has activated the connector with the pass. */
  isActivated() { const r = read(); return Boolean(r && r.activated); },

  /** @returns {string} the remembered pass ('' until activation). */
  getPass() { const r = read(); return (r && r.pass) || DEFAULT_PASS; },

  /** Persist activation + the pass that unlocked it. */
  activate(pass) { write({ activated: true, pass: pass || DEFAULT_PASS }); },

  /** Turn the connector back off (keeps no pass). */
  deactivate() { write({ activated: false }); },

  /**
   * Validate a pass against the live bridge before activating.
   * @returns {Promise<'ok'|'badpass'|'offline'>}
   */
  async verify(pass) {
    try {
      const res = await fetch(bridgeUrl() + '/brain/index', {
        headers: { 'X-Brain-Pass': pass || '' }, cache: 'no-store'
      });
      if (res.status === 401) return 'badpass';
      if (!res.ok) return 'offline';   // 503 (brain not configured) or other -> offline
      return 'ok';
    } catch { return 'offline'; }
  },

  /**
   * Light reachability ping for the connector status pill.
   * @returns {Promise<'connected'|'offline'>}
   */
  async probe() {
    try {
      const res = await fetch(bridgeUrl() + '/health', { cache: 'no-store' });
      return res.ok ? 'connected' : 'offline';
    } catch { return 'offline'; }
  }
};
