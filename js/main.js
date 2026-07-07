// js/main.js — scaffold-owned, FINAL boot orchestrator. Do not edit.
// Loads config, wires the theme sync, then imports every module and awaits
// their init() in the contract order. Each init is isolated: one module
// failing must never abort boot (black grid must always appear).
//
// main.js lives in js/, so config paths climb one level: ../config.js.

import { bus } from './core/event-bus.js';
import { state } from './core/state-manager.js';

// window.GZOWO_DEBUG = false; // set true in console to enable layout assertions

// ---- 1. Config ----
// User copies config.example.js -> config.js (gitignored, real keys). If it's
// missing we fall back to the placeholder example and run in demo mode.
window.GZOWO_CONFIG = (
  await import('../config.js').catch(() => {
    console.warn('[gzowo] config.js missing — using placeholders (demo mode)');
    return import('../config.example.js');
  })
).CONFIG;

// ---- 2. Theme sync ----
// state.theme -> body[data-theme]; CSS hooks off the attribute, JS never does.
state.subscribe('theme', (theme) => {
  document.body.dataset.theme = theme;
});
document.body.dataset.theme = state.get('theme');

// ---- 3. Module imports ----
// Dynamic import AFTER window.GZOWO_CONFIG is set, so each module body reads a
// live config. Top-level await keeps ordering deterministic.
const layoutMod   = await import('./core/layout-engine.js');
const orbMod      = await import('./orb/orb.js');
const memoryMod   = await import('./memory/firebase.js');
const introMod    = await import('./intro/intro.js');
await import('./voice/persona.js'); // data-only (PERSONA, TOOLS), no init
const geminiMod   = await import('./voice/gemini-live.js');
const wakeMod     = await import('./voice/wake-word.js');
const modesMod    = await import('./voice/modes.js');
await import('./widgets/widget-base.js'); // defineWidget helper, no init
const weatherMod  = await import('./widgets/weather.js');
const clockMod    = await import('./widgets/clock.js');
const timerMod    = await import('./widgets/timer.js');
const projectsMod = await import('./widgets/projects.js');
const placeMod    = await import('./widgets/placeholders.js');
const hudMod      = await import('./ui/hud.js');
const chatMod     = await import('./ui/chat.js');
const soundMod    = await import('./audio/sound.js');
const bridgeMod   = await import('./bridge-client.js');

// ---- 4. Ordered init ----
// Order per contract: bridge, sound, memory, hud, chat, layout, orb, intro,
// voice(gemini/wake/modes), then all five widget modules. Each is isolated.
async function safeInit(name, fn) {
  try {
    await fn();
  } catch (e) {
    console.error('[gzowo] init failed:', name, e);
  }
}

await safeInit('bridge-client', () => bridgeMod.bridgeClient.init());
await safeInit('sound',         () => soundMod.init());
await safeInit('memory',        () => memoryMod.init());
await safeInit('hud',           () => hudMod.init());
await safeInit('chat',          () => chatMod.init());
await safeInit('layout',        () => layoutMod.layout.init());
await safeInit('orb',           () => orbMod.init());
await safeInit('intro',         () => introMod.init());
await safeInit('gemini-live',   () => geminiMod.init());
await safeInit('wake-word',     () => wakeMod.init());
await safeInit('modes',         () => modesMod.init());
await safeInit('widget:weather',      () => weatherMod.init());
await safeInit('widget:clock',        () => clockMod.init());
await safeInit('widget:timer',        () => timerMod.init());
await safeInit('widget:projects',     () => projectsMod.init());
await safeInit('widget:placeholders', () => placeMod.init());

console.info('[gzowo] boot complete');
