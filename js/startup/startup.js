// js/startup/startup.js — startup-owned, v2. The short post-auth ceremony that
// replaces the old Iron-Man ignition. On a successful auth it flips the UI into
// 'startup' (CSS keys off body[data-ui] to slide the islands up and reveal the
// avatar), asks the voice stack to greet the user by voice, and after --t-cine
// settles into 'idle'. Logic only — no DOM, no color. init() never throws.
//
// Greeting: the primary path is the live voice session (gemini-live speaks
// "Witaj, {username}. Jak mogę ci dzisiaj pomóc?"). A fallback guarantees the user
// is still greeted if the session can't open: speechSynthesis (pl-PL), or a toast
// if synthesis is unavailable. Exactly one greeting is ever delivered by THIS
// module — a live session that opens late after the fallback spoke is ignored.

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';

// Mirrors --t-cine (startup reveal duration). Read from the token so the two never
// drift; falls back to 1200ms if the CSS var can't be resolved.
const REVEAL_MS = readMsToken('--t-cine', 1200);
// If no live 'open' arrives within this window of the greet request, fall back.
const GREET_TIMEOUT_MS = 5000;

let _bootDone = false;   // has 'boot:done' fired? (drives the late-init safety net)
let _begun = false;      // the ceremony runs exactly once

// Track boot completion at import time so a late init() can tell whether
// 'auth:ready' has already been (or is about to be) emitted.
bus.on('boot:done', () => { _bootDone = true; });

/**
 * @returns {string} the exact greeting phrasing (kept identical to gemini-live's).
 */
function greetingText(username) {
  return 'Witaj, ' + username + '. Jak mogę ci dzisiaj pomóc?';
}

/**
 * Resolve a millisecond value from a CSS custom property like '1200ms' / '1.2s'.
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function readMsToken(name, fallback) {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!raw) return fallback;
    if (raw.endsWith('ms')) return parseFloat(raw) || fallback;
    if (raw.endsWith('s')) return (parseFloat(raw) || 0) * 1000 || fallback;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Run the startup ceremony exactly once.
 * @param {string} username
 */
function begin(username) {
  if (_begun) return;
  if (!username) return;
  _begun = true;

  // 1. Enter the reveal. CSS (body[data-ui='startup']) slides the islands up and
  //    reveals the avatar; other modules reveal their own DOM off the same attr.
  state.setUI('startup', 'auth-ok');

  // 2. Arm the greeting fallback BEFORE asking to greet, so an immediate error/off
  //    status can't slip past the guard, then ask the voice stack to speak. The
  //    prewarm runs in parallel with the reveal (latency win).
  armGreetingFallback(username);
  bus.emit('startup:greet', { username });

  // 3. Settle into idle after the reveal window.
  setTimeout(() => state.setUI('idle', 'startup-done'), REVEAL_MS);
}

/**
 * Guarantee the user is greeted even if the live voice session never opens.
 * Exactly-once: the first of {live session opens, error/off, 5s timeout} wins.
 * @param {string} username
 */
function armGreetingFallback(username) {
  let settled = false;

  const cleanup = () => {
    clearTimeout(timer);
    unsub();
  };

  const speakFallback = () => {
    if (settled) return;
    settled = true;
    cleanup();
    deliverFallback(username);
  };

  const onSession = (payload) => {
    if (settled) return;
    const status = payload && payload.status;
    if (status === 'open') {
      // The live session took the greeting — disarm the fallback for good.
      settled = true;
      cleanup();
    } else if (status === 'error' || status === 'off') {
      // The session can't carry the greeting — speak it ourselves now.
      speakFallback();
    }
    // 'connecting' / 'closed' are ignored; the 5s timer still guards a silent stall.
  };

  const unsub = bus.on('voice:session', onSession);
  const timer = setTimeout(speakFallback, GREET_TIMEOUT_MS);
}

/**
 * Speak the greeting via speechSynthesis (pl-PL), or fall back to a toast if
 * synthesis is missing/unavailable. Honest degradation — never silent.
 * @param {string} username
 */
function deliverFallback(username) {
  const text = greetingText(username);
  try {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    if (synth && typeof window.SpeechSynthesisUtterance === 'function') {
      const utter = new window.SpeechSynthesisUtterance(text);
      utter.lang = 'pl-PL';
      const voice = pickPolishVoice(synth);
      if (voice) utter.voice = voice;
      // If the utterance errors, degrade to a toast so the greeting still lands.
      utter.onerror = () => bus.emit('toast', { text, kind: 'info' });
      synth.speak(utter);
      return;
    }
  } catch (err) {
    console.warn('[startup] speechSynthesis failed', err);
  }
  bus.emit('toast', { text, kind: 'info' });
}

/**
 * Pick a Polish voice if the platform exposes one (voices may load lazily; by the
 * time the fallback fires they are usually ready). Returns null to keep the
 * default voice with the pl-PL lang hint.
 * @param {SpeechSynthesis} synth
 * @returns {SpeechSynthesisVoice|null}
 */
function pickPolishVoice(synth) {
  try {
    const voices = synth.getVoices() || [];
    return voices.find((v) => /^pl(\b|[-_])/i.test(v.lang || '')) || null;
  } catch {
    return null;
  }
}

/**
 * Idempotent init. Primary trigger is 'auth:ready' (always emitted after
 * 'boot:done', so gemini-live is already listening for 'startup:greet' by then).
 * The state check is a safety net for a late init where auth already resolved.
 */
export async function init() {
  bus.on('auth:ready', (payload) => {
    const user = payload && payload.user;
    if (user && user.username) begin(user.username);
  });

  // Late-init safety net: only act on already-published state if boot has already
  // finished (i.e. 'auth:ready' has fired and we missed it). During the normal
  // boot 'auth:ready' is still pending here, so the subscription above drives it.
  const user = state.get('user');
  if (_bootDone && user && user.username) begin(user.username);
}
