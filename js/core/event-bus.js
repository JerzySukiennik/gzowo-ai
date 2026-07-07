// js/core/event-bus.js — scaffold-owned, FINAL. Do not edit.
// The one and only message channel between modules. Synchronous fan-out.
//
// ============================ EVENT CATALOG (v2) ============================
// Names are literal strings; payload shapes are binding. Emit exactly these.
//
//   'state:change'    {from, to, reason}                   emitted ONLY by state.setUI
//   'boot:done'       {}                                   emitted ONCE by main.js after all inits
//   'auth:ready'      {user}                               user:{username}; after auth + memory.attachUser,
//                                                          ALWAYS deferred until after 'boot:done'
//   'memory:ready'    {prefs}                              prefs loaded + applied to state
//   'startup:greet'   {username}                           startup asks the voice stack to greet
//   'voice:toggle'    {}                                   GŁOS island / Space key
//   'voice:wake'      {}                                   wake word detected
//   'voice:session'   {status, detail?}                    status:'connecting'|'open'|'closed'|'error'|'off'
//   'voice:amplitude' {level, source}                      level:0..1, source:'in'|'out'  (~30/s, smoothed)
//   'voice:transcript'{role, text, final}                  role:'user'|'gzowo', final:bool
//   'assistant:tool'  {name, args}                         broadcast AFTER toolRouter.dispatch settles
//   'chat:send'       {text}                               text typed by user (bubble input)
//   'mode:change'     {input, output}                      input/output: 'voice'|'text' (modes.js rebroadcasts)
//   'avatar:slot'     {cx, cy, r}                          px; layout -> avatar target (replaces the v1 orb-slot event)
//   'layout:widgets'  {count, ids}
//   'trash:throw'     {count}                              BEFORE fly-to-trash animations start
//   'trash:done'      {}                                   after the last victim lands
//   'sound:play'      {name}                               boot|grant|deny|wake|blip-in|blip-out|trash|timer-done|hum
//   'bridge:status'   {online, features}                   features:{projects,whisper,ha,fetch}
//   'toast'           {text, kind?}                         kind:'info'|'warn'  honest-degradation notices
//
// REMOVED vs v1: the intro-done, orb-slot and widget-request events (no dock).
// 'auth:ready' no longer carries a demo flag (v2 has no demo mode).
// ===========================================================================

/** @type {Map<string, Set<Function>>} */
const listeners = new Map();

export const bus = {
  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void} unsubscribe
   */
  on(event, handler) {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  },

  /**
   * Subscribe once; auto-unsubscribes after the first emit.
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void} unsubscribe
   */
  once(event, handler) {
    const wrapped = (payload) => {
      this.off(event, wrapped);
      handler(payload);
    };
    return this.on(event, wrapped);
  },

  /**
   * Unsubscribe a specific handler.
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    const set = listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) listeners.delete(event);
  },

  /**
   * Synchronously fan out to every handler. Each handler is isolated:
   * a throwing handler is logged and never stops the others, never rethrows.
   * @param {string} event
   * @param {*} [payload]
   */
  emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    // Snapshot so handlers that (un)subscribe during dispatch don't corrupt iteration.
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        console.error('[bus]', event, err);
      }
    }
  }
};
