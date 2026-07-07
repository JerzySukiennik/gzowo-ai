// js/core/state-manager.js — scaffold-owned, FINAL. Do not edit.
// Owns the single UI state machine + a shallow key/value store with subscriptions.
// The ONLY place allowed to write document.body.dataset.ui and emit 'state:change'.

import { bus } from './event-bus.js';

// ---- UI state machine -------------------------------------------------------
// States: 'intro' | 'idle' | 'talking' | 'showing'
// Transitions:
//   intro   -> idle only (boot handoff)
//   idle <-> talking <-> showing  (freely interchangeable)
// Same-state or invalid transitions are ignored with a console.warn.
const UI_STATES = ['intro', 'idle', 'talking', 'showing'];

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function isValidTransition(from, to) {
  if (!UI_STATES.includes(to)) return false;
  if (from === to) return false;
  if (from === 'intro') return to === 'idle';          // intro escapes only to idle
  if (to === 'intro') return false;                     // nothing returns to intro
  // idle / talking / showing are freely interchangeable
  return ['idle', 'talking', 'showing'].includes(from);
}

// ---- Shallow store defaults -------------------------------------------------
const STORE_DEFAULTS = {
  theme: 'mono',                                  // 'mono' | 'blueprint'
  mode: { input: 'voice', output: 'voice' },      // conversation mode matrix
  muted: false,
  wakeEnabled: false,
  user: null,
  demo: false,
  bridgeOnline: false,
  voiceStatus: 'off',
  chatOpen: false
};

let _ui = 'intro';
const store = { ...STORE_DEFAULTS };
/** @type {Map<string, Set<Function>>} */
const subscribers = new Map();

export const state = {
  /** @returns {'intro'|'idle'|'talking'|'showing'} */
  get ui() {
    return _ui;
  },

  /**
   * Transition the UI state machine. Validates, updates body dataset, emits.
   * @param {'intro'|'idle'|'talking'|'showing'} next
   * @param {string} [reason]
   */
  setUI(next, reason = '') {
    const from = _ui;
    if (!isValidTransition(from, next)) {
      console.warn('[state] ignored UI transition', from, '->', next, reason ? `(${reason})` : '');
      return;
    }
    _ui = next;
    if (typeof document !== 'undefined' && document.body) {
      document.body.dataset.ui = next;
    }
    bus.emit('state:change', { from, to: next, reason });
  },

  /**
   * Read a store value.
   * @param {string} key
   * @returns {*}
   */
  get(key) {
    return store[key];
  },

  /**
   * Write a store value. Emits to subscribers only when the value changes
   * (shallow / reference comparison).
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    const old = store[key];
    if (old === value) return;
    store[key] = value;
    const set = subscribers.get(key);
    if (set) {
      for (const fn of [...set]) {
        try {
          fn(value, old);
        } catch (err) {
          console.error('[state] subscriber failed for', key, err);
        }
      }
    }
  },

  /**
   * Subscribe to changes of a store key.
   * @param {string} key
   * @param {(newVal:*, oldVal:*) => void} fn
   * @returns {() => void} unsubscribe
   */
  subscribe(key, fn) {
    let set = subscribers.get(key);
    if (!set) {
      set = new Set();
      subscribers.set(key, set);
    }
    set.add(fn);
    return () => {
      const s = subscribers.get(key);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) subscribers.delete(key);
    };
  }
};
