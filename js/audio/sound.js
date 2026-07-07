// js/audio/sound.js — Gzowo sound system.
// Real CC0 assets fetched+decoded first; tasteful WebAudio procedural fallbacks
// second. Single AudioContext created lazily on the first user gesture (autoplay
// policy). All audio routes through a master GainNode gated by state.muted.
//
// Public surface:
//   export async function init()  — warm-up, wire 'sound:play', mute + ui gating
//   export const sound = { play(name) }
//
// Sound names: boot, grant, deny, wake, blip-in, blip-out, trash, timer-done, hum.

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';

// ---------------------------------------------------------------------------
// CC0 sources — REAL fetched assets first, two candidates each (Mixkit CDN,
// direct-file CC0 sci-fi / interface bleeps). If every candidate fails the
// fetch, that name degrades to its procedural synth fallback below. Honest:
// nothing silently pretends — a failed fetch just means synth, which still plays.
// ---------------------------------------------------------------------------
const SOURCES = {
  boot: [
    'https://assets.mixkit.co/active_storage/sfx/2568/2568.wav',
    'https://assets.mixkit.co/active_storage/sfx/1489/1489.wav'
  ],
  grant: [
    'https://assets.mixkit.co/active_storage/sfx/2870/2870.wav',
    'https://assets.mixkit.co/active_storage/sfx/1114/1114.wav'
  ],
  deny: [
    'https://assets.mixkit.co/active_storage/sfx/2955/2955.wav',
    'https://assets.mixkit.co/active_storage/sfx/951/951.wav'
  ],
  wake: [
    'https://assets.mixkit.co/active_storage/sfx/2571/2571.wav',
    'https://assets.mixkit.co/active_storage/sfx/2358/2358.wav'
  ],
  'blip-in': [
    'https://assets.mixkit.co/active_storage/sfx/1112/1112.wav',
    'https://assets.mixkit.co/active_storage/sfx/2573/2573.wav'
  ],
  'blip-out': [
    'https://assets.mixkit.co/active_storage/sfx/1113/1113.wav',
    'https://assets.mixkit.co/active_storage/sfx/2574/2574.wav'
  ],
  trash: [
    'https://assets.mixkit.co/active_storage/sfx/2569/2569.wav',
    'https://assets.mixkit.co/active_storage/sfx/1101/1101.wav'
  ],
  'timer-done': [
    'https://assets.mixkit.co/active_storage/sfx/1005/1005.wav',
    'https://assets.mixkit.co/active_storage/sfx/2869/2869.wav'
  ]
  // NOTE: 'hum' has no fetched source on purpose — it is a continuous procedural
  // drone (looping a fetched clip would click at the loop seam). Always synth.
};

const MASTER_GAIN = 0.6;    // conservative ceiling for everything
const FETCH_TIMEOUT = 4000; // ms per candidate

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
/** @type {AudioContext|null} */
let ctx = null;
/** @type {GainNode|null} */
let master = null;
/** @type {Map<string, AudioBuffer>} decoded real assets, keyed by name */
const buffers = new Map();
let warmed = false;         // warm-up (fetch pass) already fired
let gestureArmed = false;   // first-gesture listener already consumed

// Hum (continuous drone) live handle so we can start/stop it cleanly.
/** @type {{stop:()=>void}|null} */
let humHandle = null;

// ---------------------------------------------------------------------------
// AudioContext lifecycle — lazy, gesture-gated (browser autoplay policy).
// ---------------------------------------------------------------------------
function ensureContext() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = state.get('muted') ? 0 : MASTER_GAIN;
    master.connect(ctx.destination);
  } catch (e) {
    console.warn('[sound] AudioContext unavailable', e);
    ctx = null;
    master = null;
  }
  return ctx;
}

// Resume a suspended context (Safari/Chrome suspend until a gesture).
function resume() {
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}

function applyMute() {
  if (!master || !ctx) return;
  const target = state.get('muted') ? 0 : MASTER_GAIN;
  const now = ctx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setTargetAtTime(target, now, 0.02);
  // Muting must also silence the continuous hum immediately.
  if (state.get('muted')) stopHum();
  else maybeStartHum(state.ui);
}

// ---------------------------------------------------------------------------
// Warm-up: fetch + decode every candidate. Never blocks init; fire-and-forget.
// ---------------------------------------------------------------------------
function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal, mode: 'cors' })
    .finally(() => clearTimeout(t));
}

async function loadOne(name, urls) {
  if (!ctx) return;
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, FETCH_TIMEOUT);
      if (!res.ok) continue;
      const arr = await res.arrayBuffer();
      // decodeAudioData is promise-based in modern browsers; wrap defensively
      // so the older callback signature also resolves.
      const buf = await new Promise((resolve, reject) => {
        try {
          const p = ctx.decodeAudioData(arr.slice(0), resolve, reject);
          if (p && typeof p.then === 'function') p.then(resolve, reject);
        } catch (err) {
          reject(err);
        }
      });
      if (buf) {
        buffers.set(name, buf);
        return; // first success wins
      }
    } catch {
      // try next candidate; on total failure -> procedural fallback at play()
    }
  }
}

function warmUp() {
  if (warmed || !ctx) return;
  warmed = true;
  const jobs = Object.entries(SOURCES).map(([name, urls]) => loadOne(name, urls));
  // Never await in the caller — boot must not hang on the network.
  Promise.allSettled(jobs).then(() => {
    console.info(`[sound] warm-up done: ${buffers.size}/${Object.keys(SOURCES).length} real assets (procedural fallback for the rest)`);
  });
}

// ---------------------------------------------------------------------------
// Playback: buffered real asset if available, else procedural synth.
// ---------------------------------------------------------------------------
function playBuffer(name) {
  if (!ctx || !master) return false;
  const buf = buffers.get(name);
  if (!buf) return false;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = 0.9;
  src.connect(g).connect(master);
  src.start();
  return true;
}

function play(name) {
  if (state.get('muted')) return;
  // Autoplay policy: do NOT create/resume the AudioContext before the first user
  // gesture. On a fresh first visit the intro typewriter fires 'blip-in' cues
  // before the login submit (the first real gesture); creating + resume()-ing the
  // context here would log Chrome's "AudioContext was not allowed to start"
  // warning. Pre-gesture sound requests silently no-op; the gesture unlock (init)
  // arms audio a beat later and every subsequent cue plays normally.
  if (!gestureArmed) return;
  if (!ensureContext()) return;
  resume();
  // Continuous drone is handled by its own start/stop, not one-shot playback.
  if (name === 'hum') { maybeStartHum(state.ui); return; }
  if (playBuffer(name)) return;
  proceduralPlay(name);
}

// ---------------------------------------------------------------------------
// Procedural WebAudio fallbacks — tasteful, conservative gains, dry machine-like
// interface bleeps (no music), matching the B&W hi-tech vibe.
// ---------------------------------------------------------------------------
function env(gain, t0, attack, hold, release, peak) {
  const p = Math.max(peak, 0.0002);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(p, t0 + attack);
  gain.gain.setValueAtTime(p, t0 + attack + hold);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
}

function noiseBuffer(seconds) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function tone({ type = 'sine', from, to = from, t0, dur, peak = 0.3, filter = null }) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t0 + dur);
  const g = ctx.createGain();
  env(g, t0, Math.min(0.01, dur * 0.2), dur * 0.2, dur * 0.6, peak);
  let node = osc;
  if (filter) {
    const f = ctx.createBiquadFilter();
    Object.assign(f, filter.props || {});
    node.connect(f);
    node = f;
  }
  node.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function noiseTick({ t0, dur, freqFrom, freqTo, peak = 0.25 }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(dur + 0.05);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 6;
  bp.frequency.setValueAtTime(freqFrom, t0);
  bp.frequency.exponentialRampToValueAtTime(Math.max(freqTo, 1), t0 + dur);
  const g = ctx.createGain();
  env(g, t0, 0.005, dur * 0.2, dur * 0.7, peak);
  src.connect(bp).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

function proceduralPlay(name) {
  if (!ctx || !master) return;
  const t0 = ctx.currentTime;
  switch (name) {
    case 'boot': {
      // 1.2s rising saw sweep 60->220Hz + noise swell + lowpass opening.
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(60, t0);
      osc.frequency.exponentialRampToValueAtTime(220, t0 + 1.2);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(200, t0);
      lp.frequency.exponentialRampToValueAtTime(3200, t0 + 1.2);
      const g = ctx.createGain();
      env(g, t0, 0.25, 0.5, 0.55, 0.3);
      osc.connect(lp).connect(g).connect(master);
      osc.start(t0);
      osc.stop(t0 + 1.35);
      // noise swell under it
      const n = ctx.createBufferSource();
      n.buffer = noiseBuffer(1.3);
      const nlp = ctx.createBiquadFilter();
      nlp.type = 'lowpass';
      nlp.frequency.setValueAtTime(300, t0);
      nlp.frequency.exponentialRampToValueAtTime(2400, t0 + 1.2);
      const ng = ctx.createGain();
      env(ng, t0, 0.4, 0.3, 0.6, 0.12);
      n.connect(nlp).connect(ng).connect(master);
      n.start(t0);
      n.stop(t0 + 1.35);
      break;
    }
    case 'grant': {
      // two-note sine blip up (880 / 1320, ~90ms each).
      tone({ type: 'sine', from: 880, t0, dur: 0.09, peak: 0.3 });
      tone({ type: 'sine', from: 1320, t0: t0 + 0.1, dur: 0.09, peak: 0.3 });
      break;
    }
    case 'deny': {
      // square 180Hz double buzz.
      tone({ type: 'square', from: 180, t0, dur: 0.12, peak: 0.22 });
      tone({ type: 'square', from: 180, t0: t0 + 0.16, dur: 0.12, peak: 0.22 });
      break;
    }
    case 'wake': {
      // soft sine ping 1568Hz, 120ms, fast decay.
      tone({ type: 'sine', from: 1568, t0, dur: 0.12, peak: 0.28 });
      break;
    }
    case 'blip-in': {
      // short filtered noise tick, pitch up.
      noiseTick({ t0, dur: 0.07, freqFrom: 800, freqTo: 2600, peak: 0.22 });
      break;
    }
    case 'blip-out': {
      // short filtered noise tick, pitch down.
      noiseTick({ t0, dur: 0.07, freqFrom: 2600, freqTo: 700, peak: 0.22 });
      break;
    }
    case 'trash': {
      // descending pitch 400->80 + noise burst, ~200ms.
      tone({
        type: 'sawtooth', from: 400, to: 80, t0, dur: 0.2, peak: 0.26,
        filter: { props: { type: 'lowpass', frequency: 1800 } }
      });
      noiseTick({ t0, dur: 0.2, freqFrom: 1200, freqTo: 200, peak: 0.18 });
      break;
    }
    case 'timer-done': {
      // triple ping.
      tone({ type: 'sine', from: 1200, t0, dur: 0.11, peak: 0.3 });
      tone({ type: 'sine', from: 1200, t0: t0 + 0.18, dur: 0.11, peak: 0.3 });
      tone({ type: 'sine', from: 1600, t0: t0 + 0.36, dur: 0.14, peak: 0.32 });
      break;
    }
    default:
      // unknown name -> silent, honest (no fake sound).
      break;
  }
}

// ---------------------------------------------------------------------------
// Hum — continuous low drone (procedural only). Plays only in idle/talking,
// gain ~0.05, stops on muted / 'showing' / intro.
// ---------------------------------------------------------------------------
function startHum() {
  if (humHandle || !ctx || !master) return;
  if (state.get('muted')) return;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 55;
  const g = ctx.createGain();
  g.gain.value = 0;
  g.gain.setTargetAtTime(0.05, ctx.currentTime, 0.6); // gentle fade-in to 0.05
  // filtered noise bed at ~-30dB (0.03 linear), well under the sine.
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(2);
  n.loop = true;
  const nlp = ctx.createBiquadFilter();
  nlp.type = 'lowpass';
  nlp.frequency.value = 220;
  const ng = ctx.createGain();
  ng.gain.value = 0;
  ng.gain.setTargetAtTime(0.03, ctx.currentTime, 0.6);
  osc.connect(g).connect(master);
  n.connect(nlp).connect(ng).connect(master);
  osc.start();
  n.start();
  humHandle = {
    stop() {
      const now = ctx.currentTime;
      g.gain.setTargetAtTime(0, now, 0.25);
      ng.gain.setTargetAtTime(0, now, 0.25);
      try { osc.stop(now + 0.6); } catch { /* already stopped */ }
      try { n.stop(now + 0.6); } catch { /* already stopped */ }
    }
  };
}

function stopHum() {
  if (!humHandle) return;
  humHandle.stop();
  humHandle = null;
}

// Decide whether the hum should be running for a given UI state.
function maybeStartHum(ui) {
  if (state.get('muted')) { stopHum(); return; }
  if (ui === 'idle' || ui === 'talking') {
    if (!ctx) return; // no context yet -> next gesture-driven check starts it
    startHum();
  } else {
    stopHum();
  }
}

// ---------------------------------------------------------------------------
// init() — never throws; wires listeners, arms the first-gesture unlock.
// ---------------------------------------------------------------------------
export async function init() {
  // First user gesture unlocks + warms up the audio (autoplay policy).
  const unlock = () => {
    if (gestureArmed) return;
    gestureArmed = true;
    if (ensureContext()) {
      resume();
      warmUp();
      // If we're already in a humming state when audio unlocks, start it.
      maybeStartHum(state.ui);
    }
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  // Play requests from anywhere in the app.
  bus.on('sound:play', (p) => {
    if (!p || !p.name) return;
    play(p.name);
  });

  // Mute toggle -> master gain + hum gating.
  state.subscribe('muted', applyMute);

  // UI state drives the hum (idle/talking on; showing/intro off).
  bus.on('state:change', ({ to }) => maybeStartHum(to));

  console.info('[sound] ready (unlocks on first gesture)');
}

// Public play() surface used by modules that prefer a direct call over the bus.
export const sound = {
  /** @param {string} name */
  play(name) { play(name); }
};
