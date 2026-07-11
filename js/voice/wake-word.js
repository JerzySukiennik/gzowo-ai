// js/voice/wake-word.js — voice-owned. On-device wake word ("Hej Gzowo") via
// Vosk (fully local WASM keyword-spotting). Audio NEVER leaves the device.
//
// Why Vosk and not Porcupine: Picovoice discontinued its free tier on 2026-06-30,
// so Porcupine is now paid/commercial. Vosk is free, offline, no account. We run
// it in keyword-spotting mode (grammar limited to the wake phrases + [unk]) which
// is fast and accurate for a distinctive word like "Gzowo".
//
// The Polish model (~53MB) is served locally by the bridge (CONFIG.vosk.modelUrl);
// on the deployed site without a bridge the model isn't reachable -> honestly
// unavailable. The URL is served BY THE BRIDGE and must not change.
//
// Mic coordination: the wake listener holds the mic only while IDLE. When a Gemini
// voice session opens (state -> talking) we RELEASE the mic so GŁOS→GŁOS gets it
// cleanly (no contention, no self-trigger on Gzowo's own voice); we re-acquire it
// when we fall back to idle. We never grab the mic in auth/startup/showing.
//
// v2 (bug 11): this module is a SILENT good citizen — it NEVER emits 'toast'
// (console.warn only). It maintains state.wakeModelStatus ('idle'|'loading'|
// 'ready'|'unavailable') + state.wakeAvailable, which the Settings panel mirrors
// as a live status line ("model się ładuje…" / "gotowy" / "niedostępny").
//
// GLOBAL RULES: logic only; English comments; secrets via CONFIG; honest failure
// (no toast spam); graceful degradation everywhere.

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
 * Idempotent init. Loads the Vosk model in the background; publishes status via
 * state.wakeModelStatus / wakeAvailable. Never throws, never toasts.
 */
export async function init() {
  // Capability flag the Settings toggle gates on. Off until a model is live.
  state.set('wakeAvailable', false);
  state.set('wakeModelStatus', 'idle');
  // Load the ~53MB model in the BACKGROUND. NEVER await it here: main.js awaits
  // init() during boot, and createModel() can take many seconds (or hang on a bad
  // network), which would otherwise freeze the whole app behind a blank screen.
  loadWake();
}

/** True when we may actively hold the mic: idle AND showing (widgets on screen
 *  still deserve "Hej Gzowo" — 2026-07-10 fix: wake "bardzo rzadko działa" was
 *  partly because showing never listened at all). Never in auth/startup
 *  (pre-app) or talking (the Live session owns the mic). */
function canListen() {
  return state.ui === 'idle' || state.ui === 'showing';
}

async function loadWake() {
  try {
    const vk = (CONFIG && CONFIG.vosk) || {};
    // Model URL stays served by the bridge — do NOT change it.
    const modelUrl = vk.modelUrl || '/models/vosk-pl.tar.gz';
    keywords = (Array.isArray(vk.keywords) && vk.keywords.length ? vk.keywords : ['hej gzowo', 'ok gzowo', 'gzowo'])
      .map((k) => String(k).toLowerCase());

    // Honest unavailable: model file not reachable (no bridge / not deployed).
    let reachable = false;
    try { const r = await fetch(modelUrl, { method: 'HEAD' }); reachable = r.ok; } catch (_e) { reachable = false; }
    if (!reachable) {
      console.warn('[wake-word] Vosk model not reachable at ' + modelUrl + ' — wake unavailable (run the bridge to enable "Hej Gzowo").');
      state.set('wakeAvailable', false);
      state.set('wakeModelStatus', 'unavailable');
      return;
    }

    // Model file is reachable; begin the multi-second WASM model load.
    state.set('wakeModelStatus', 'loading');
    const { createModel } = await import(VOSK_ESM);
    model = await createModel(modelUrl);
    // NO grammar (2026-07-09 fix): "gzowo" is OUT-OF-VOCABULARY for the Vosk PL
    // model, and a grammar restricted to OOV phrases can never emit them — the
    // recognizer stayed silent forever ("Hej Gzowo" dead despite status ready).
    // Free-form recognition transcribes *something* close, and matches() does the
    // fuzzy phonetic match. Costs more CPU, but only runs while idle.
    grammar = null;

    // Model is live: expose the capability. Listening stays OFF until the user
    // enables wake in Settings (so we never grab the mic behind their back).
    state.set('wakeAvailable', true);
    state.set('wakeModelStatus', 'ready');
    if (state.get('wakeEnabled') === true && canListen()) await startListening();

    // Privacy toggle: enable -> acquire mic + listen (only from idle); disable ->
    // release mic.
    state.subscribe('wakeEnabled', async (enabled) => {
      try { if (enabled && canListen()) await startListening(); else await stopListening(); }
      catch (err) { console.warn('[wake-word] toggle failed', err); }
    });

    // Release the mic while a voice session is live; re-acquire back in any
    // listen-capable state (idle OR showing). auth/startup never (canListen gates).
    bus.on('state:change', async ({ to }) => {
      try {
        if (to === 'talking') await stopListening();
        else if ((to === 'idle' || to === 'showing') && state.get('wakeEnabled') === true) await startListening();
      } catch (err) { console.warn('[wake-word] state coordination failed', err); }
    });
  } catch (err) {
    console.warn('[wake-word] Vosk init failed — wake unavailable', err);
    state.set('wakeAvailable', false);
    state.set('wakeModelStatus', 'unavailable');
  }
}

/** Acquire the mic and start feeding the recognizer. Idempotent + guarded. */
async function startListening() {
  if (!model || listening || busy) return;
  busy = true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      // autoGainControl EXPLICITLY on: quiet/far-field "Hej Gzowo" was often too
      // soft for the recognizer (part of the "rarely wakes" report, 2026-07-10).
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch (_e) { /* ignore */ } }

    // Free-form recognizer (no grammar — see loadWake). Finals are logged so a
    // live "why didn't it wake" session can just watch the console.
    recognizer = grammar
      ? new model.KaldiRecognizer(audioCtx.sampleRate, grammar)
      : new model.KaldiRecognizer(audioCtx.sampleRate);
    recognizer.on('result', (msg) => {
      const text = (msg && msg.result && msg.result.text ? msg.result.text : '').toLowerCase();
      if (text) {
        console.info('[wake-word] heard:', JSON.stringify(text));
        // Surfaced in Settings as „ostatnio usłyszałem: …" so Jurek can debug the
        // wake WITHOUT opening the console (v4 #19).
        state.set('wakeLastHeard', text.slice(0, 60));
      }
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
      // Piggyback clap detection on the same mic buffer (v4-b #3) — no 2nd mic.
      try { detectClap(e.inputBuffer.getChannelData(0)); } catch (_e) { /* transient */ }
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

/** Fuzzy phonetic wake matcher (2026-07-10 rewrite — "bardzo rzadko działa").
 *  "gzowo" is OOV for the PL model, so the transcript lands on an unpredictable
 *  neighbour ("zowo", "dzowo", "gzowa", "z owo", "sowo"…). A fixed substring
 *  list can't cover that — instead we score real edit distance:
 *    • any word within distance ≤1 of "gzowo" wakes on its own,
 *    • after a trigger word ("hej"/"ok"/"okej"/"hey") distance ≤2 suffices,
 *    • adjacent word PAIRS are also merged ("z owo" → "zowo") before scoring,
 *  with a blacklist of common Polish words that sit 2 edits away ("słowo",
 *  "zdrowo", "gotowo", "nowo") so casual speech doesn't false-wake. */
const WAKE_TARGET = 'gzowo';
// Vosk (PL, no grammar) can't spell the OOV name — "Hej Gzowo" comes back as
// "hej", "ej", "hej sowo"; "Ok Gzowo" as "okej". So we ALSO accept a short,
// deliberate call that is just a trigger word (v4 #4). The mic only runs while
// idle/showing, so a bare "hej"/"okej" waking is acceptable and finally reliable.
const WAKE_TARGET_MAX_WORDS = 3;
const WAKE_TRIGGERS = new Set(['hej', 'hey', 'ej', 'ok', 'oki', 'oke', 'okej', 'okey', 'okay', 'gej']);
const WAKE_BLACKLIST = new Set(['słowo', 'slowo', 'zdrowo', 'gotowo', 'nowo', 'mrowo', 'surowo']);

function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function wordWakes(word) {
  if (!word || WAKE_BLACKLIST.has(word)) return false;
  if (word.includes('gzow') || word.includes('zowo')) return true;
  return editDistance(word, WAKE_TARGET) <= 2;
}

function matches(text) {
  if (!text) return false;
  if (keywords.some((k) => text.includes(k))) return true;   // exact phrases first
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > WAKE_TARGET_MAX_WORDS) return false; // only a short, deliberate call
  // (a) a "gzowo"-ish token anywhere (incl. Vosk splitting it in two: "z owo").
  for (let i = 0; i < words.length; i++) {
    if (wordWakes(words[i])) return true;
    if (i + 1 < words.length && wordWakes(words[i] + words[i + 1])) return true;
  }
  // (b) the name vanished but a trigger word survived ("hej", "okej") — wake.
  if (words.some((w) => WAKE_TRIGGERS.has(w))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Clap detection (v4-b #3, hardened 2026-07-10 — was firing on speech, hiding
// widgets whenever Jurek talked). A CLAP is an IMPULSE: a loud peak with a very
// high crest factor (peak ≫ RMS) preceded by near-silence. SPEECH is sustained
// energy (low crest, no pre-silence), so it's rejected. Two qualifying impulses
// 120–650ms apart = a double-clap → bus 'clap:double'.
// ---------------------------------------------------------------------------
const CLAP_PEAK = 0.35;         // impulse must be LOUD
const CLAP_CREST = 6.5;         // peak / rms — claps ~10-20, speech ~2-4
const CLAP_PRE_SILENCE = 0.05;  // the buffer BEFORE the impulse must be quiet
const CLAP_REFRACTORY_MS = 110;
const CLAP_MIN_GAP = 120, CLAP_MAX_GAP = 650;
let clapPrevRms = 0;            // rms of the previous buffer (pre-silence test)
let clapLastOnset = 0;
let clapPrevOnset = 0;

function detectClap(buf) {
  let peak = 0, sq = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; sq += buf[i] * buf[i]; }
  const rms = Math.sqrt(sq / buf.length);
  const crest = rms > 1e-4 ? peak / rms : 0;
  const preSilent = clapPrevRms < CLAP_PRE_SILENCE;
  const now = performance.now();
  clapPrevRms = rms;   // update AFTER reading, so it reflects the buffer BEFORE the next
  if (now - clapLastOnset < CLAP_REFRACTORY_MS) return;
  if (peak >= CLAP_PEAK && crest >= CLAP_CREST && preSilent) {
    clapPrevOnset = clapLastOnset;
    clapLastOnset = now;
    const gap = clapLastOnset - clapPrevOnset;
    if (gap >= CLAP_MIN_GAP && gap <= CLAP_MAX_GAP) {
      clapPrevOnset = clapLastOnset = 0;        // consume the pair
      bus.emit('sound:play', { name: 'blip-in' });
      bus.emit('clap:double', {});
    }
  }
}

/** Emit the wake event (debounced), letting gemini-live open the session. */
function fireWake() {
  const now = Date.now();
  if (now - lastWake < WAKE_DEBOUNCE_MS) return;
  lastWake = now;
  bus.emit('sound:play', { name: 'wake' });
  bus.emit('voice:wake', {});
}
