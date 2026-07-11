// js/main.js — foundation-owned, v2 boot orchestrator.
// Loads config, wires the theme sync, then dynamically imports every module and
// awaits their init() in the contract order. Two hard guarantees:
//   1. A missing/broken module NEVER aborts boot — each import is .catch'd to null
//      and each init() runs inside a try/catch. The black grid + auth gate always
//      appear (body starts data-ui="auth").
//   2. custom-auth defers its 'auth:ready' emit until AFTER 'boot:done', so late
//      subscribers never miss it.
//
// main.js lives in js/, so config paths climb one level: ../config.js.

import { bus } from './core/event-bus.js';
import { state } from './core/state-manager.js';

// window.GZOWO_DEBUG = false; // set true in console to enable layout assertions

// ---- 1. Config -------------------------------------------------------------
// User copies config.example.js -> config.js (gitignored, real keys). If it's
// missing we fall back to the placeholder example (subsystems degrade honestly;
// custom-auth drops to LOCAL mode). Config loading never aborts boot.
let configMod = null;
try {
  configMod = await import('../config.js');
} catch (_e) {
  console.warn('[gzowo] config.js missing — using placeholders from config.example.js');
  try {
    configMod = await import('../config.example.js');
  } catch (e2) {
    console.error('[gzowo] config.example.js failed too — running with empty config', e2);
  }
}
window.GZOWO_CONFIG = (configMod && configMod.CONFIG) || {};

// ---- 2. Theme sync ---------------------------------------------------------
// state.theme -> body[data-theme]; CSS hooks off the attribute, JS never does.
state.subscribe('theme', (theme) => {
  document.body.dataset.theme = theme;
});
document.body.dataset.theme = state.get('theme');

// ---- 3. Crash-proof module loader ------------------------------------------
// Every feature module is imported through this: a broken/missing module logs
// and yields null, and the app keeps booting.
async function load(path) {
  try {
    return await import(path);
  } catch (e) {
    console.error('[gzowo] module failed:', path, e);
    return null;
  }
}

// Load every module up front (parallel). Nulls are tolerated everywhere below.
const [
  bridgeMod, soundMod, memoryMod, glassMod, sceneMod, toastsMod, layoutMod, avatarMod,
  islandsMod, chatMod, trashMod, settingsMod, customAuthMod, startupMod,
  personaMod, geminiMod, wakeMod, modesMod, widgetToolsMod, homeMod,
  bambuMod, skillsMod, marketplaceMod, webEmbedMod, brainToolsMod, zabaMod, widgetCtrlMod, gravityMod, skillForgeMod, buildFlowMod, automationsMod,
  notifyMod, scenesMod, memoryToolsMod, appleNotesMod, printerWatchMod, briefMod, launchMod, liveStyleMod
] = await Promise.all([
  load('./bridge-client.js'),
  load('./audio/sound.js'),
  load('./memory/firebase.js'),
  load('./ui/glass.js'),
  load('./ui/theme-scene.js'),
  load('./ui/toasts.js'),
  load('./core/layout-engine.js'),
  load('./avatar/avatar.js'),
  load('./ui/islands.js'),
  load('./ui/chat.js'),
  load('./ui/trash.js'),
  load('./ui/settings.js'),
  load('./auth/custom-auth.js'),
  load('./startup/startup.js'),
  load('./voice/persona.js'),        // data-only (PERSONA), no init()
  load('./voice/gemini-live.js'),
  load('./voice/wake-word.js'),
  load('./voice/modes.js'),
  load('./widgets/widget-tools.js'),
  load('./widgets/home.js'),
  load('./widgets/bambu.js'),
  load('./skills/skills.js'),
  load('./skills/marketplace.js'),
  load('./widgets/web-embed.js'),
  load('./voice/brain-tools.js'),
  load('./widgets/zaba.js'),
  load('./widgets/widget-control.js'),
  load('./core/gravity.js'),
  load('./skills/skill-forge.js'),
  load('./skills/build-flow.js'),
  load('./skills/automations.js'),
  load('./core/notify.js'),
  load('./skills/scenes.js'),
  load('./skills/memory-tools.js'),
  load('./skills/apple-notes.js'),
  load('./skills/printer-watch.js'),
  load('./skills/brief.js'),
  load('./skills/launch.js'),
  load('./skills/live-style.js')
]);
void personaMod; // referenced only for its side-effect-free data exports

// ---- 4. Ordered init -------------------------------------------------------
// Each init is isolated: one module throwing must never abort boot.
async function safeInit(name, fn) {
  try {
    await fn();
  } catch (e) {
    console.error('[gzowo] init failed:', name, e);
  }
}

// Order per contract §13: bridge-client, sound, memory, toasts, layout, avatar,
// islands, chat, trash, settings, custom-auth (renders the auth gate / restores
// the session), startup, gemini-live, wake-word, modes, widget-tools, home,
// bambu, skills, marketplace, web-embed. persona is data-only (no init).
await safeInit('bridge-client', () => bridgeMod?.bridgeClient?.init?.());
await safeInit('sound',         () => soundMod?.init?.());
await safeInit('memory',        () => memoryMod?.init?.());
await safeInit('glass',         () => glassMod?.init?.());   // before UI builders — the observer then catches everything
await safeInit('theme-scene',   () => sceneMod?.init?.());
await safeInit('toasts',        () => toastsMod?.init?.());
await safeInit('layout',        () => layoutMod?.layout?.init?.());
await safeInit('avatar',        () => avatarMod?.init?.());
await safeInit('islands',       () => islandsMod?.init?.());
await safeInit('chat',          () => chatMod?.init?.());
await safeInit('trash',         () => trashMod?.init?.());
await safeInit('settings',      () => settingsMod?.init?.());
await safeInit('custom-auth',   () => customAuthMod?.init?.());
await safeInit('startup',       () => startupMod?.init?.());
await safeInit('gemini-live',   () => geminiMod?.init?.());
await safeInit('wake-word',     () => wakeMod?.init?.());
await safeInit('modes',         () => modesMod?.init?.());
await safeInit('widget-tools',  () => widgetToolsMod?.init?.());
await safeInit('home',          () => homeMod?.init?.());
await safeInit('bambu',         () => bambuMod?.init?.());
await safeInit('skills',        () => skillsMod?.init?.());
await safeInit('marketplace',   () => marketplaceMod?.init?.());
await safeInit('web-embed',     () => webEmbedMod?.init?.());
await safeInit('brain-tools',   () => brainToolsMod?.init?.());
await safeInit('zaba',          () => zabaMod?.init?.());
await safeInit('widget-control',() => widgetCtrlMod?.init?.());
await safeInit('gravity',       () => gravityMod?.init?.());
await safeInit('skill-forge',   () => skillForgeMod?.init?.());
await safeInit('build-flow',    () => buildFlowMod?.init?.());
await safeInit('automations',   () => automationsMod?.init?.());
await safeInit('notify',        () => notifyMod?.init?.());
await safeInit('scenes',        () => scenesMod?.init?.());
await safeInit('memory-tools',  () => memoryToolsMod?.init?.());
await safeInit('apple-notes',   () => appleNotesMod?.init?.());
await safeInit('printer-watch', () => printerWatchMod?.init?.());
await safeInit('brief',         () => briefMod?.init?.());
await safeInit('launch',        () => launchMod?.init?.());
await safeInit('live-style',    () => liveStyleMod?.init?.());

// ---- 5. Boot done ----------------------------------------------------------
// custom-auth listens for this to release its deferred 'auth:ready'.
bus.emit('boot:done', {});
console.info('[gzowo] boot complete');
