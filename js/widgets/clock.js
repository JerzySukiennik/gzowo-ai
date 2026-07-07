// js/widgets/clock.js — ZEGAR widget (pure B&W showcase, NO color).
//
// ⚑ THIS MODULE ALSO OWNS THE SHARED TOOL / REQUEST ROUTER ⚑
// (Placed here because clock is the lightest widget.) It listens on the bus for:
//   - 'assistant:tool'  {name, args}   — Gemini function calls
//   - 'widget:request'  {name}         — dock buttons
//   - 'memory:ready'    {prefs}        — restore pinned widgets per ui state
// and maps every documented tool onto the layout engine + widget def factories.
//
// Contract honored:
//   - export async function init()  (idempotent; wires the router once)
//   - export function clockDef()
//   - render(bodyEl, ctx) returns a cleanup fn (clears the 1s interval).

import { defineWidget } from './widget-base.js';
import { layout } from '../core/layout-engine.js';
import { state } from '../core/state-manager.js';
import { bus } from '../core/event-bus.js';
import { memory } from '../memory/firebase.js';

// Sibling widget defs + the timer control handle.
import { weatherDef } from './weather.js';
import { timerDef, timerControl } from './timer.js';
import { projectsDef } from './projects.js';
import { homeDef, bambuDef } from './placeholders.js';

// ---------------------------------------------------------------------------
// CLOCK WIDGET
// ---------------------------------------------------------------------------
// Weekday on its own so we can join with ' · ' (spec wants a middle dot, not the
// locale's default comma): 'wtorek · 7 lipca 2026'.
const PL_WEEKDAY_FMT = new Intl.DateTimeFormat('pl-PL', { weekday: 'long' });
const PL_REST_FMT = new Intl.DateTimeFormat('pl-PL', {
  day: 'numeric', month: 'long', year: 'numeric'
});
function formatPlDate(d) {
  return `${PL_WEEKDAY_FMT.format(d)} · ${PL_REST_FMT.format(d)}`;
}

export function clockDef() {
  return defineWidget({
    id: 'clock',
    title: 'ZEGAR',
    color: null, // ZEGAR is the pure black-and-white showcase — no accent.
    size: 'md',
    render(bodyEl) {
      let alive = true;
      let timer = null;
      let blinkOn = true;

      bodyEl.innerHTML =
        '<div class="clk">' +
          '<div class="clk-time">' +
            '<span data-role="h">00</span>' +
            '<span class="clk-sep" data-role="s1">:</span>' +
            '<span data-role="m">00</span>' +
            '<span class="clk-sep" data-role="s2">:</span>' +
            '<span data-role="s">00</span>' +
          '</div>' +
          '<div class="clk-date" data-role="date">&nbsp;</div>' +
        '</div>';

      const hEl = bodyEl.querySelector('[data-role="h"]');
      const mEl = bodyEl.querySelector('[data-role="m"]');
      const sEl = bodyEl.querySelector('[data-role="s"]');
      const sep1 = bodyEl.querySelector('[data-role="s1"]');
      const sep2 = bodyEl.querySelector('[data-role="s2"]');
      const dateEl = bodyEl.querySelector('[data-role="date"]');

      function pad(n) { return String(n).padStart(2, '0'); }

      function paint() {
        if (!alive) return;
        const now = new Date();
        hEl.textContent = pad(now.getHours());
        mEl.textContent = pad(now.getMinutes());
        sEl.textContent = pad(now.getSeconds());
        // blink the two ':' at 1 Hz via opacity (no layout thrash)
        blinkOn = !blinkOn;
        const op = blinkOn ? '1' : '0.25';
        sep1.style.opacity = op;
        sep2.style.opacity = op;
        dateEl.textContent = formatPlDate(now);
      }

      // Align the first tick to the next second boundary, then run every 1000ms.
      paint();
      const msToNextSecond = 1000 - (Date.now() % 1000);
      let boundaryTimeout = setTimeout(() => {
        if (!alive) return;
        paint();
        timer = setInterval(paint, 1000);
      }, msToNextSecond);

      return () => {
        alive = false;
        if (boundaryTimeout) clearTimeout(boundaryTimeout);
        if (timer) clearInterval(timer);
      };
    }
  });
}

// ---------------------------------------------------------------------------
// TOOL / REQUEST ROUTER
// ---------------------------------------------------------------------------
// Registry: widget name -> def factory. Used by show_widget{name} and the dock
// 'widget:request' events. Placeholders are registered so "pokaż dom" honestly
// shows the v1.1 placeholder instead of pretending.
const REGISTRY = {
  weather: weatherDef,
  clock: clockDef,
  timer: timerDef,
  projects: projectsDef,
  home: homeDef,
  bambu: bambuDef
};

// Add a widget by name via its def factory. Returns the def's id (or null).
// NOTE: the def from defineWidget() is FROZEN — never mutate it. Pinning is done
// exclusively through layout.pin(id, states) AFTER the widget is added.
function addByName(name) {
  const factory = REGISTRY[name];
  if (!factory) {
    console.warn('[gzowo] unknown widget:', name);
    return null;
  }
  const def = factory();
  return layout.addWidget(def) || def.id;
}

// Add a widget intended to be pinned, without leaving the UI stuck in 'showing'.
// The engine's addWidget() defensively flips idle/talking -> showing for any
// non-pinned add (pins are applied only after the entry exists). So we: snapshot
// the UI, add, pin for the target state, then restore the snapshot if the add
// forced a switch. Pinned widgets survive the showing->prev transition (the
// engine keeps them and glides them into the compact ring), so the net effect is
// "pinned widget appears in its state WITHOUT forcing showing".
function addAndPin(name, uiState) {
  const prevUI = state.ui;
  const id = addByName(name);
  if (!id) return null;
  try { layout.pin(id, [uiState]); } catch (_e) { /* engine may be a stub */ }
  if (state.ui === 'showing' && prevUI !== 'showing' && prevUI !== 'intro') {
    state.setUI(prevUI, 'pin-restore');
  }
  return id;
}

let wired = false;

function wireRouter() {
  if (wired) return;
  wired = true;

  // --- Gemini function calls -------------------------------------------------
  bus.on('assistant:tool', ({ name, args } = {}) => {
    const a = args || {};
    switch (name) {
      case 'show_weather':
        addByName('weather');
        break;
      case 'show_clock':
        addByName('clock');
        break;
      case 'show_projects':
        addByName('projects');
        break;
      case 'show_widget':
        if (a.name) addByName(a.name);
        break;
      case 'start_timer': {
        addByName('timer');
        const seconds = Number(a.seconds);
        // start after the def is registered; timerControl proxies the model.
        timerControl.start(Number.isFinite(seconds) ? seconds : undefined, a.label);
        break;
      }
      case 'stop_timer':
        timerControl.stop();
        break;
      case 'hide_widgets':
        layout.clear({ toTrash: true });
        // After the trash choreography, return the UI to a calm state.
        if (state.ui === 'showing') {
          const talking = state.get('voiceStatus') === 'open';
          state.setUI(talking ? 'talking' : 'idle', 'hidden-all');
        }
        break;
      case 'pin_widget':
        if (a.name && a.ui_state) pinWidget(a.name, a.ui_state);
        break;
      case 'unpin_widget':
        if (a.name) unpinWidget(a.name, a.ui_state);
        break;
      case 'set_theme':
        if (a.theme) state.set('theme', a.theme);
        break;
      default:
        // end_conversation and any voice-only tools are handled elsewhere.
        break;
    }
  });

  // --- Dock buttons ----------------------------------------------------------
  bus.on('widget:request', ({ name } = {}) => {
    if (name) addByName(name);
  });

  // --- Restore pinned widgets once memory is ready ---------------------------
  // For each ui state, getPinned -> add + pin those widgets WITHOUT forcing
  // 'showing' (addAndPin restores the pre-add UI state if the engine flipped it).
  bus.on('memory:ready', () => {
    const states = ['idle', 'talking', 'showing'];
    for (const uiState of states) {
      let ids = [];
      try { ids = memory.getPinned(uiState) || []; } catch (_e) { ids = []; }
      for (const name of ids) {
        addAndPin(name, uiState);
      }
    }
  });
}

// ---- Pin / unpin helpers ----------------------------------------------------
function pinWidget(name, uiState) {
  // Ensure the widget exists, pin it for the given ui state, persist the ids.
  addAndPin(name, uiState);
  const current = safePinned(uiState);
  if (!current.includes(name)) {
    memory.setPinned(uiState, [...current, name]);
  }
}

function unpinWidget(name, uiState) {
  // If a ui state is given, unpin only there; otherwise clear from all states.
  const states = uiState ? [uiState] : ['idle', 'talking', 'showing'];
  for (const st of states) {
    const current = safePinned(st);
    const next = current.filter((n) => n !== name);
    if (next.length !== current.length) memory.setPinned(st, next);
  }
  try { layout.unpin(name); } catch (_e) { /* engine stub */ }
}

function safePinned(uiState) {
  try { return memory.getPinned(uiState) || []; } catch (_e) { return []; }
}

export async function init() {
  // Wire the shared router exactly once (idempotent — safe on re-init).
  wireRouter();
}
