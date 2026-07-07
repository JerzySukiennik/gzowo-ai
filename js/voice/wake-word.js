// js/voice/wake-word.js — voice-owned. On-device wake word ("Hej Gzowo") via
// Vosk (fully local WASM keyword-spotting). Audio NEVER leaves the device.
//
// Why Vosk and not Porcupine: Picovoice discontinued its free tier on 2026-06-30,
// so Porcupine is now paid/commercial. Vosk is free, offline, no account. We run
// it in keyword-spotting mode (grammar limited to the wake phrases + [unk]) which
// is fast and accurate for a distinctive word like "Gzowo".
//
// The Polish model (~53MB) is served locally by the bridge (CONFIG.vosk.modelUrl);
// on the deployed site without a bridge the model isn't reachable -> honest WAKE OFF.
//
// Mic coordination: the wake listener holds the mic only while IDLE. When a Gemini
// voice session opens (state -> talking) we RELEASE the mic so GŁOS→GŁOS gets it
// cleanly (no contention, no self-trigger on Gzowo's own voice); we re-acquire it
// when we fall back to idle.
//
// GLOBAL RULES: logic only; English comments; secrets via CONFIG; honest failure
// (no toast spam — HUD shows WAKE OFF); graceful degradation everywhere.

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';

const CONFIG = window.GZOWO_CONFIG;
const VOSK_ESM = 'https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/+esm';

let model = null;          // loaded Vosk model (expensive; kept for the session)
let grammar = null;        // JSON grammar string (keywords + [unk])
let keywords = [];         // lowercased wake phrases
let recognizer = null;     // current KaldiRecognizer (tied to a sample rate)
let audioCtx = null;       // AudioContext feeding the recognizer
let micStream = null;      // mic MediaStream (only while listening)
let sourceNode = null;
let procNode = null;

let listening = false;     // mic acquired + feeding the recognizer?
let busy = false;          // guard against overlapping start/stop
let lastWake = 0;          // debounce repeated detections

const WAKE_DEBOUNCE_MS = 2500;

/**
 * Idempotent init. Loads the Vosk model if reachable; otherwise honest WAKE OFF.
 * Never throws.
 */
export async function init() {
  // Capability flag the HUD gates its WAKE toggle on. Off until a model is live.
  state.set('wakeAvailable', false);
  try {
    const vk = (CONFIG && CONFIG.vosk) || {};
    const modelUrl = vk.modelUrl || '/models/vosk-pl.tar.gz';
    keywords = (Array.isArray(vk.keywords) && vk.keywords.length ? vk.keywords : ['hej gzowo', 'ok gzowo', 'gzowo'])
      .map((k) => String(k).toLowerCase());

    // Honest off: model file not reachable (no bridge / not deployed with it).
    let reachable = false;
    try { const r = await fetch(modelUrl, { method: 'HEAD' }); reachable = r.ok; } catch (_e) { reachable = false; }
    if (!reachable) {
      console.warn('[wake-word] Vosk model not reachable at ' + modelUrl + ' — WAKE OFF (odpal most, żeby mieć "Hej Gzowo").');
      return;
    }

    const { createModel } = await import(VOSK_ESM);
    model = await createModel(modelUrl);
    grammar = JSON.stringify([...keywords, '[unk]']);

    // Model is live: expose the capability. Listening stays OFF until the user
    // flips the HUD WAKE toggle (so we never grab the mic behind their back).
    state.set('wakeAvailable', true);
    if (state.get('wakeEnabled') === true) await startListening();

    // Privacy toggle: enable -> acquire mic + listen; disable -> release mic.
    state.subscribe('wakeEnabled', async (enabled) => {
      try { if (enabled) await startListening(); else await stopListening(); }
      catch (err) { console.error('[wake-word] toggle failed', err); }
    });

    // Release the mic while a voice session is live; re-acquire back at idle.
    bus.on('state:change', async ({ to }) => {
      try {
        if (to === 'talking') await stopListening();
        else if (to === 'idle' && state.get('wakeEnabled') === true) await startListening();
      } catch (err) { console.error('[wake-word] state coordination failed', err); }
    });
  } catch (err) {
    console.warn('[wake-word] Vosk init failed — WAKE OFF', err);
    state.set('wakeAvailable', false);
  }
}

/** Acquire the mic and start feeding the recognizer. Idempotent + guarded. */
async function startListening() {
  if (!model || listening || busy) return;
  busy = true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch (_e) { /* ignore */ } }

    recognizer = new model.KaldiRecognizer(audioCtx.sampleRate, grammar);
    recognizer.on('result', (msg) => {
      const text = (msg && msg.result && msg.result.text ? msg.result.text : '').toLowerCase();
      if (matches(text)) fireWake();
    });
    recognizer.on('partialresult', (msg) => {
      const text = (msg && msg.result && msg.result.partial ? msg.result.partial : '').toLowerCase();
      if (matches(text)) fireWake();
    });

    sourceNode = audioCtx.createMediaStreamSource(micStream);
    // ScriptProcessor is deprecated but universally supported and dead-simple for
    // a wake listener; the recognizer resamples from the context rate internally.
    procNode = audioCtx.createScriptProcessor(4096, 1, 1);
    procNode.onaudioprocess = (e) => {
      if (!recognizer) return;
      try { recognizer.acceptWaveform(e.inputBuffer); } catch (_e) { /* transient */ }
    };
    sourceNode.connect(procNode);
    procNode.connect(audioCtx.destination); // must be in the graph to pull audio
    listening = true;
  } catch (err) {
    console.warn('[wake-word] startListening failed (mic?)', err);
    await teardown();
  } finally {
    busy = false;
  }
}

/** Release the mic + tear down the audio graph (recognizer is recreated on next start). */
async function stopListening() {
  if (busy && !listening) return;
  await teardown();
}

async function teardown() {
  listening = false;
  try { if (procNode) procNode.onaudioprocess = null; } catch (_e) { /* ignore */ }
  try { procNode && procNode.disconnect(); } catch (_e) { /* ignore */ }
  try { sourceNode && sourceNode.disconnect(); } catch (_e) { /* ignore */ }
  try { micStream && micStream.getTracks().forEach((t) => t.stop()); } catch (_e) { /* ignore */ }
  try { if (recognizer && recognizer.remove) recognizer.remove(); } catch (_e) { /* ignore */ }
  try { audioCtx && audioCtx.close(); } catch (_e) { /* ignore */ }
  procNode = null; sourceNode = null; micStream = null; recognizer = null; audioCtx = null;
}

/** True if the recognized text contains any wake phrase (or the bare name). */
function matches(text) {
  if (!text) return false;
  if (text.includes('gzowo')) return true; // distinctive enough on its own
  return keywords.some((k) => text.includes(k));
}

/** Emit the wake event (debounced), letting gemini-live open the session. */
function fireWake() {
  const now = Date.now();
  if (now - lastWake < WAKE_DEBOUNCE_MS) return;
  lastWake = now;
  bus.emit('sound:play', { name: 'wake' });
  bus.emit('voice:wake', {});
}
