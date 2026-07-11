// js/core/state-manager.js — scaffold-owned, FINAL. Do not edit.
// Owns the single UI state machine + a shallow key/value store with subscriptions.
// The ONLY place allowed to write document.body.dataset.ui and emit 'state:change'.

import { bus } from './event-bus.js';

// ---- UI state machine -------------------------------------------------------
// States: 'auth' | 'startup' | 'idle' | 'talking' | 'showing'
// Transitions:
//   auth    -> startup only  (login / register / session-restore ok)
//   startup -> idle only     (reveal choreography done)
//   idle <-> talking <-> showing  (freely interchangeable)
//   nothing ever returns to auth or startup (logout = custom-auth.logout() -> reload)
// Same-state or invalid transitions are ignored with a console.warn.
const UI_STATES = ['auth', 'startup', 'idle', 'talking', 'showing'];
const LIVE_STATES = ['idle', 'talking', 'showing'];

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function isValidTransition(from, to) {
  if (!UI_STATES.includes(to)) return false;
  if (from === to) return false;
  if (from === 'auth') return to === 'startup';          // auth escapes only into startup
  if (from === 'startup') return to === 'idle';          // startup reveals only into idle
  // from is a live state now — idle/talking/showing are freely interchangeable,
  // and this branch structurally forbids any return to 'auth'/'startup' (they are
  // not in LIVE_STATES), so nothing ever re-enters the gate or the reveal.
  return LIVE_STATES.includes(from) && LIVE_STATES.includes(to);
}

// ---- Shallow store defaults -------------------------------------------------
const STORE_DEFAULTS = {
  theme: 'mono',                                  // 'mono' | 'blueprint'
  mode: { input: 'voice', output: 'voice' },      // conversation mode matrix
  muted: false,
  wakeEnabled: true,                              // v4 #5: 'hej gzowo' listening ON by default
  dashboardMode: false,                           // v4 #18: wake session ends after one exchange
  widgetConfirm: true,                            // v4-g: confirm dialog before installing a built widget
  skillMode: null,                                // v4 #21: active text-skill mode {name,instructions}|null
  wakeAvailable: false,                           // wake stack actually reachable
  wakeModelStatus: 'idle',                        // 'idle' | 'loading' | 'ready' | 'unavailable'
  user: null,                                     // {username} after auth
  authResolved: false,
  bridgeOnline: false,
  voiceStatus: 'off',
  settingsOpen: false,
  skills: []                                      // enabled skill ids
};

let _ui = 'auth';
const store = { ...STORE_DEFAULTS };
/** @type {Map<string, Set<Function>>} */
const subscribers = new Map();

export const state = {
  /** @returns {'auth'|'startup'|'idle'|'talking'|'showing'} */
  get ui() {
    return _ui;
  },

  /**
   * Transition the UI state machine. Validates, updates body dataset, emits.
   * The ONLY writer of document.body.dataset.ui and emitter of 'state:change'.
   * @param {'auth'|'startup'|'idle'|'talking'|'showing'} next
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
