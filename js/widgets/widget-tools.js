// js/widgets/widget-tools.js — the ASSISTANT-ONLY widget control surface.
//
// v2: this replaces the router that used to hide inside clock.js. The user never
// touches widgets (no dock, no clicks); everything happens through tools the
// model calls. Each tool is registered on the shared tool-router and returns its
// REAL result, which gemini-live sends back verbatim as the functionResponse —
// so the model can never claim a success the handler didn't confirm (the v2
// point-9 hide bug). hide_widgets is the fix in the flesh: it clears EVERY
// widget (pinned too), drops the UI state out of 'showing', and reports the
// honest {ok, hidden} count.
//
// This module:
//   - boots the four v1 widget modules (weather/clock/timer/projects),
//   - registers their def factories as widgets on the tool-router,
//   - registers every assistant tool (declarations in PL, handlers do real work),
//   - restores pinned widgets per UI state once memory is ready.
//
// Contract: export async function init() — idempotent, never throws.

import { toolRouter } from '../core/tool-router.js';
import { layout } from '../core/layout-engine.js';
import { state } from '../core/state-manager.js';
import { bus } from '../core/event-bus.js';
import { memory } from '../memory/firebase.js';

import { weatherDef, init as weatherInit } from './weather.js';
import { clockDef, init as clockInit } from './clock.js';
import { timerDef, timerControl, init as timerInit } from './timer.js';
import { projectsDef, init as projectsInit } from './projects.js';

const PIN_STATES = ['idle', 'talking', 'showing'];
const EMPTY_PARAMS = { type: 'object', properties: {}, required: [] };

let inited = false;

// ---------------------------------------------------------------------------
// Widget add helpers (assistant-only; ported from v1 clock.js router)
// ---------------------------------------------------------------------------

// Add a widget by name via its registered factory. Returns the widget id (which
// equals its name) or null. Uses the tool-router registry so connector widgets
// (home/bambu/…) that self-register are covered too. The def is FROZEN — never
// mutate it; pinning is applied only through layout.pin(id, states) afterwards.
function addByName(name) {
  const factory = toolRouter.getWidgetFactory(name);
  if (!factory) {
    console.warn('[widget-tools] unknown widget:', name);
    return null;
  }
  let def;
  try {
    def = factory();
  } catch (e) {
    console.error('[widget-tools] widget factory threw:', name, e);
    return null;
  }
  if (!def || !def.id) return null;
  return layout.addWidget(def) || def.id;
}

// Add a widget meant to be pinned, without leaving the UI stuck in 'showing'.
// layout.addWidget() defensively flips idle/talking -> showing for any non-pinned
// add (pins are applied only after the entry exists). So we snapshot the UI, add,
// pin for the target state, then restore the snapshot if the add forced a switch.
// Pinned widgets survive the showing->prev transition (the engine keeps them and
// glides them into the compact ring), so the net effect is "pinned widget appears
// in its state WITHOUT forcing showing".
function addAndPin(name, uiState) {
  const prevUI = state.ui;
  const id = addByName(name);
  if (!id) return null;
  try { layout.pin(id, [uiState]); } catch (_e) { /* engine may be a stub */ }
  if (state.ui === 'showing' && prevUI !== 'showing'
      && prevUI !== 'auth' && prevUI !== 'startup') {
    state.setUI(prevUI, 'pin-restore');
  }
  return id;
}

function safePinned(uiState) {
  try { return memory.getPinned(uiState) || []; } catch (_e) { return []; }
}

// The UI states a widget is currently pinned for (per the live layout), or null
// if it isn't registered — used to guard duplicate restores.
function pinnedStatesOf(name) {
  try {
    const w = layout.getWidgets().find((x) => x.id === name);
    return w ? w.pinned : null;
  } catch (_e) {
    return null;
  }
}

function widgetList() {
  return toolRouter.listWidgets().join(', ');
}

// ---------------------------------------------------------------------------
// Tool registration — declarations in PL, handlers return honest JSON results
// ---------------------------------------------------------------------------
function registerTools() {
  // --- show_weather / show_clock / show_projects --------------------------
  toolRouter.registerTool(
    { name: 'show_weather', description: 'Pokazuje widget pogody (aktualna pogoda i prognoza).', parameters: EMPTY_PARAMS },
    async () => (addByName('weather')
      ? { ok: true, widget: 'weather' }
      : { ok: false, error: 'nie udało się pokazać pogody' })
  );

  toolRouter.registerTool(
    { name: 'show_clock', description: 'Pokazuje widget zegara z aktualną godziną i datą.', parameters: EMPTY_PARAMS },
    async () => (addByName('clock')
      ? { ok: true, widget: 'clock' }
      : { ok: false, error: 'nie udało się pokazać zegara' })
  );

  toolRouter.registerTool(
    { name: 'show_projects', description: 'Pokazuje widget z listą projektów (dane z mostu).', parameters: EMPTY_PARAMS },
    async () => (addByName('projects')
      ? { ok: true, widget: 'projects' }
      : { ok: false, error: 'nie udało się pokazać projektów' })
  );

  // --- start_timer / stop_timer -------------------------------------------
  toolRouter.registerTool(
    {
      name: 'start_timer',
      description: 'Uruchamia minutnik na podaną liczbę sekund, opcjonalnie z etykietą.',
      parameters: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: 'Czas w sekundach (wymagane, dodatnia liczba).' },
          label: { type: 'string', description: 'Opcjonalna etykieta, np. "herbata".' }
        },
        required: ['seconds']
      }
    },
    async (args) => {
      const seconds = Number(args && args.seconds);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return { ok: false, error: 'podaj dodatnią liczbę sekund' };
      }
      addByName('timer');
      const label = (args && typeof args.label === 'string') ? args.label : undefined;
      try {
        timerControl.start(seconds, label);
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
      return { ok: true, seconds };
    }
  );

  toolRouter.registerTool(
    { name: 'stop_timer', description: 'Zatrzymuje i resetuje minutnik.', parameters: EMPTY_PARAMS },
    async () => {
      try { timerControl.stop(); } catch (_e) { /* no live timer — still ok */ }
      return { ok: true };
    }
  );

  // --- show_widget {name} — any registered widget, incl. connectors --------
  toolRouter.registerTool(
    {
      name: 'show_widget',
      description: 'Pokazuje widget po nazwie (np. weather, clock, timer, projects).',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nazwa widgetu do pokazania.' } },
        required: ['name']
      }
    },
    async (args) => {
      const name = (args && typeof args.name === 'string') ? args.name.trim() : '';
      const factory = name ? toolRouter.getWidgetFactory(name) : null;
      if (!factory) {
        return { ok: false, error: 'nie znam widgetu: ' + name + ' (dostępne: ' + widgetList() + ')' };
      }
      return addByName(name)
        ? { ok: true, widget: name }
        : { ok: false, error: 'nie udało się pokazać: ' + name };
    }
  );

  // --- hide_widgets {} — THE HIDE-BUG FIX ---------------------------------
  toolRouter.registerTool(
    { name: 'hide_widgets', description: 'Chowa wszystkie widgety z ekranu (także przypięte).', parameters: EMPTY_PARAMS },
    async () => {
      const before = layout.getWidgets().length;
      // all:true removes PINNED widgets too — the real emptying of the screen.
      const { hidden } = layout.clear({ toTrash: true, all: true });
      // Drop the UI state so the app truly leaves 'showing' (part of the fix).
      if (state.ui === 'showing') {
        const talking = state.get('voiceStatus') === 'open';
        state.setUI(talking ? 'talking' : 'idle', 'hidden-all');
      }
      if (hidden > 0) return { ok: true, hidden };
      if (before > 0) {
        console.debug('[widget-tools] hide_widgets: registered=' + before + ' but none visible');
      }
      return { ok: false, error: 'nic nie jest teraz wyświetlone' };
    }
  );

  // --- pin_widget / unpin_widget ------------------------------------------
  toolRouter.registerTool(
    {
      name: 'pin_widget',
      description: 'Przypina widget do stanu (idle, talking lub showing), żeby zostawał na ekranie.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nazwa widgetu.' },
          ui_state: { type: 'string', enum: PIN_STATES, description: 'Stan, w którym widget ma być przypięty.' }
        },
        required: ['name', 'ui_state']
      }
    },
    async (args) => {
      const name = (args && typeof args.name === 'string') ? args.name.trim() : '';
      const uiState = args && args.ui_state;
      if (!name) return { ok: false, error: 'podaj nazwę widgetu' };
      if (!PIN_STATES.includes(uiState)) {
        return { ok: false, error: 'zły stan (dostępne: ' + PIN_STATES.join(', ') + ')' };
      }
      if (!toolRouter.getWidgetFactory(name)) {
        return { ok: false, error: 'nie znam widgetu: ' + name + ' (dostępne: ' + widgetList() + ')' };
      }
      addAndPin(name, uiState);
      const current = safePinned(uiState);
      if (!current.includes(name)) {
        try { memory.setPinned(uiState, [...current, name]); } catch (_e) { /* offline mirror */ }
      }
      return { ok: true, widget: name, ui_state: uiState };
    }
  );

  toolRouter.registerTool(
    {
      name: 'unpin_widget',
      description: 'Odpina widget z danego stanu (albo ze wszystkich, jeśli stan pominięty).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nazwa widgetu.' },
          ui_state: { type: 'string', enum: PIN_STATES, description: 'Opcjonalny stan; pominięty = odepnij wszędzie.' }
        },
        required: ['name']
      }
    },
    async (args) => {
      const name = (args && typeof args.name === 'string') ? args.name.trim() : '';
      const uiState = (args && args.ui_state) || null;
      if (!name) return { ok: false, error: 'podaj nazwę widgetu' };
      if (uiState && !PIN_STATES.includes(uiState)) {
        return { ok: false, error: 'zły stan (dostępne: ' + PIN_STATES.join(', ') + ')' };
      }
      const states = uiState ? [uiState] : [...PIN_STATES];
      for (const st of states) {
        const current = safePinned(st);
        const next = current.filter((n) => n !== name);
        if (next.length !== current.length) {
          try { memory.setPinned(st, next); } catch (_e) { /* offline mirror */ }
        }
      }
      try { layout.unpin(name, uiState ? [uiState] : undefined); } catch (_e) { /* engine stub */ }
      return { ok: true, widget: name, ui_state: uiState || 'all' };
    }
  );

  // --- set_theme -----------------------------------------------------------
  toolRouter.registerTool(
    {
      name: 'set_theme',
      description: 'Zmienia motyw interfejsu: mono (domyślny, czysty) albo blueprint (gęstsza siatka).',
      parameters: {
        type: 'object',
        properties: { theme: { type: 'string', enum: ['mono', 'blueprint'], description: 'Nazwa motywu.' } },
        required: ['theme']
      }
    },
    async (args) => {
      const theme = args && args.theme;
      if (theme !== 'mono' && theme !== 'blueprint') {
        return { ok: false, error: 'nie znam motywu: ' + theme + ' (dostępne: mono, blueprint)' };
      }
      state.set('theme', theme);
      return { ok: true, theme };
    }
  );
}

// ---------------------------------------------------------------------------
// Restore pinned widgets once memory is ready (ported from v1 clock.js)
// ---------------------------------------------------------------------------
function restorePinned() {
  for (const uiState of PIN_STATES) {
    let ids = [];
    try { ids = memory.getPinned(uiState) || []; } catch (_e) { ids = []; }
    for (const name of ids) {
      // Guard duplicates: skip if already pinned for this state (e.g. a second
      // memory:ready, both restore paths firing, or the same widget across states).
      const existing = pinnedStatesOf(name);
      if (existing && existing.includes(uiState)) continue;
      addAndPin(name, uiState);
    }
  }
}

function wireMemoryRestore() {
  // Primary path (fresh login): the user authenticates AFTER boot, so attachUser
  // -> 'memory:ready' fires well after this subscription is in place.
  bus.on('memory:ready', restorePinned);

  // Restore-session safety net: for a RETURNING user, custom-auth attaches the
  // user during ITS own init() (earlier in main.js's boot order than widget-tools),
  // so 'memory:ready' already fired before this module could subscribe — the
  // listener above would miss it and pins would never come back. Detect that the
  // user is already attached (prefs cache is populated by then) and restore now.
  // restorePinned() is idempotent (pinnedStatesOf guard), so if both paths ever
  // run they never double-add.
  let attached = null;
  try { attached = (typeof memory.getUsername === 'function') ? memory.getUsername() : null; }
  catch (_e) { attached = null; }
  if (attached) restorePinned();
}

// ---------------------------------------------------------------------------
// init — boot sibling modules, register widgets + tools, wire restore.
// ---------------------------------------------------------------------------
export async function init() {
  if (inited) return;
  inited = true;

  // Boot the four v1 widget modules. Each init is idempotent; isolate failures
  // so one broken module never blocks widget/tool registration.
  const inits = [
    ['weather', weatherInit],
    ['clock', clockInit],
    ['timer', timerInit],
    ['projects', projectsInit]
  ];
  for (const [name, fn] of inits) {
    try { await fn?.(); } catch (e) { console.error('[widget-tools] init failed:', name, e); }
  }

  // Register widget factories so show_widget{name} + pins resolve them.
  toolRouter.registerWidget('weather', weatherDef);
  toolRouter.registerWidget('clock', clockDef);
  toolRouter.registerWidget('timer', timerDef);
  toolRouter.registerWidget('projects', projectsDef);

  registerTools();
  wireMemoryRestore();

  console.info('[widget-tools] ready — widgets + tools registered');
}
