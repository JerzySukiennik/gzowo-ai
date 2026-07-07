// js/core/event-bus.js — scaffold-owned, FINAL. Do not edit.
// The one and only message channel between modules. Synchronous fan-out.
//
// ============================ EVENT CATALOG (v1) ============================
// Names are literal strings; payload shapes are binding. Emit exactly these.
//
//   'state:change'    {from, to, reason}                   emitted ONLY by state.setUI
//   'intro:done'      {}                                   intro finished, app visible
//   'auth:ready'      {user, demo}                         user:{uid,name,email}|null, demo:bool
//   'memory:ready'    {prefs}                              prefs loaded + applied
//   'voice:wake'      {}                                   wake word detected
//   'voice:toggle'    {}                                   user asks start/stop session (hud/Space)
//   'voice:session'   {status, detail?}                    status:'connecting'|'open'|'closed'|'error'|'off'
//   'voice:amplitude' {level, source}                      level:0..1, source:'in'|'out'  (~30/s, smoothed)
//   'voice:transcript'{role, text, final}                  role:'user'|'gzowo', final:bool
//   'assistant:tool'  {name, args}                         Gemini function call -> UI
//   'chat:send'       {text}                               text typed by user
//   'mode:change'     {input, output}                      input/output: 'voice'|'text'
//   'widget:request'  {name}                               dock button asks for widget
//   'orb:slot'        {cx, cy, r}                          px; layout -> orb target
//   'layout:widgets'  {count, ids}
//   'sound:play'      {name}
//   'bridge:status'   {online, features}                   features:{projects,whisper,ha}
//   'toast'           {text, kind?}                         kind:'info'|'warn'  honest-degradation notices
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
