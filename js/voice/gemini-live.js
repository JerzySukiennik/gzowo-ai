// js/voice/gemini-live.js — voice-owned. Manages ONE Gemini Live (native audio)
// session end-to-end: token chain, connect, streaming audio in/out, transcripts,
// tool calls, session resumption + goAway reconnect, mute, silence policy, and
// the public control surface (voice:toggle / voice:wake / chat:send / mode:change).
//
// GLOBAL RULES honored here: logic only (no DOM/color); English comments, PL toasts
// in a friendly, concise v2 tone (no rhymes/catchphrases); secrets only via
// CONFIG/bridge; every failure path = honest toast, never fake; one AudioWorklet,
// reused buffers in hot paths (no per-frame allocs).
//
// v2 deltas (this file): tools now go through the shared tool-router with REAL
// functionResponses (bug 9 fix); connect() awaits no network for facts/token
// beyond a single cached-or-fresh token resolve (latency); a startup greeting is
// spoken through the Live session; the GoogleGenAI client is rebuilt per connect
// whenever it was minted from a single-use ephemeral token.

import { GoogleGenAI, Modality } from '@google/genai';
import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';
import { bridgeClient } from '../bridge-client.js';
import { memory } from '../memory/firebase.js';
import { toolRouter } from '../core/tool-router.js';
import { PERSONA } from './persona.js';

const CONFIG = window.GZOWO_CONFIG;

// ---- Model chain ------------------------------------------------------------
// Primary is tried first; if it NEVER opens (bad/pulled model -> WS close 1008
// before onopen), we downgrade ONCE to the fallback. This only fires on the bridge
// / direct-key path (their tokens aren't model-locked); a Worker token is locked to
// the primary, so there the fallback attempt just fails honestly to the drop toast.
const PRIMARY_MODEL = (CONFIG.gemini && CONFIG.gemini.model) || 'gemini-2.5-flash-native-audio-latest';
const FALLBACK_MODEL = (CONFIG.gemini && CONFIG.gemini.modelFallback) || '';

// ---- Module singletons ------------------------------------------------------
let ai = null;                 // GoogleGenAI instance
let aiIsDirectKey = false;     // true only when `ai` was built from a durable direct
                               // key (safe to reuse). Ephemeral-token clients are
                               // single-use (uses:1) and rebuilt every connect.
let session = null;            // active Live session
let sessionEpoch = 0;          // bumped per connect; callbacks ignore stale epochs
let connecting = false;        // guard against concurrent connects
let resumptionHandle = null;   // last session resumption handle (RAM only)
let retriedOnce = false;       // one auto-retry budget per unexpected drop
let goAwayTimer = null;        // scheduled transparent reconnect timer
let pendingGreet = null;       // one-shot username to greet on the next open
let sessionOpened = false;     // did the CURRENT connect reach onopen? (fallback gate)
let modelFellBack = false;     // already downgraded primary->fallback this attempt?
let activeModel = null;        // last model that successfully opened (sticky per page load)
let lastModel = null;          // model used by the in-flight / most recent connect

// ---- Token prefetch cache ---------------------------------------------------
// Bridge/worker mint SINGLE-USE ephemeral tokens with a ~2-minute new-session
// window. We warm one on 'auth:ready' (and after every teardown) so the startup
// greeting session skips a full token round-trip. Reuse only if still fresh.
let tokenCache = null;         // { auth:{token}|{apiKey}, mintedAt:number } | null
const TOKEN_TTL_MS = 100000;   // reuse a cached token only if minted < 100s ago

// ---- Audio IN (mic -> PCM16 -> Gemini) --------------------------------------
let inCtx = null;              // AudioContext @16k
let micStream = null;          // MediaStream from getUserMedia
let micSource = null;          // MediaStreamAudioSourceNode
let workletNode = null;        // AudioWorkletNode capturing Float32 chunks
let workletUrl = null;         // Blob URL for the inline worklet

// ---- Audio OUT (Gemini PCM -> speakers) -------------------------------------
let outCtx = null;             // AudioContext @24k
let outGain = null;            // master gain (mute)
let analyser = null;           // AnalyserNode for out amplitude
let analyserData = null;       // reused Float32Array for analyser reads
let nextStartTime = 0;         // gapless scheduling bookkeeping (outCtx time)
let scheduledSources = new Set(); // live BufferSourceNodes (for interrupt flush)
let outRafId = 0;              // rAF handle for the out-amplitude loop

// ---- Transcript accumulation ------------------------------------------------
let userBuf = '';              // accumulates input transcription until turnComplete
let modelBuf = '';             // accumulates output transcription until turnComplete

// ---- Silence policy ---------------------------------------------------------
let lastAudioAt = 0;           // timestamp of last user OR model audio activity
let silenceTimer = 0;          // setInterval handle
const SILENCE_MS = 45000;      // 45s of no audio while talking -> close to idle

// ---- Unsubscribers ----------------------------------------------------------
let unsubMuted = null;

/**
 * Idempotent module init. Wires the public control surface. Never throws.
 */
export async function init() {
  try {
    bus.on('voice:toggle', onToggle);
    bus.on('voice:wake', onWake);
    bus.on('chat:send', onChatSend);
    bus.on('mode:change', onModeChange);
    bus.on('startup:greet', onStartupGreet);
    // Reflect mute changes onto the output gain in real time.
    unsubMuted = state.subscribe('muted', applyMute);

    // Register the local session-lifecycle tool with the shared router so the
    // model ends the conversation through the SAME dispatch path as every other
    // tool (real functionResponse), keeping the graceful-end behavior of v1.
    toolRouter.registerTool(
      {
        name: 'end_conversation',
        description: 'Zakończ rozmowę głosową (wywołaj po krótkim pożegnaniu).',
        parameters: { type: 'object', properties: {} }
      },
      async () => { scheduleGracefulEnd(); return { ok: true }; }
    );

    // Latency: warm a Gemini token the moment the user is authed, so the startup
    // greeting session (which fires seconds later) usually skips the token round-
    // trip. Per contract 'auth:ready' always lands after 'boot:done'; also cover a
    // late/hot-reload subscribe by checking whether a user is already present.
    bus.on('auth:ready', () => { prefetchToken(); });
    if (state.get('user')) prefetchToken();
  } catch (err) {
    console.error('[gemini-live] init failed', err);
  }
}

// ============================================================================
//  TOKEN CHAIN + CONNECT
// ============================================================================

/**
 * Warm a Gemini token in the background and cache it. Silent on failure — the
 * next connect() simply fetches fresh. Never throws.
 */
async function prefetchToken() {
  try {
    const auth = await bridgeClient.getToken();
    if (auth && (auth.token || auth.apiKey)) {
      tokenCache = { auth, mintedAt: Date.now() };
    }
  } catch (_e) {
    /* silent — connect() falls back to a fresh fetch */
  }
}

/**
 * Resolve credentials for the session about to open: reuse the prefetched token
 * if it is still fresh (within the ephemeral single-session window), otherwise
 * fetch a new one. Always clears the cache after handing a token out — ephemeral
 * tokens are uses:1 and must never be replayed. Never throws.
 * @returns {Promise<{token:string}|{apiKey:string}|null>}
 */
async function resolveAuth() {
  if (tokenCache && (Date.now() - tokenCache.mintedAt) < TOKEN_TTL_MS) {
    const auth = tokenCache.auth;
    tokenCache = null; // single-use: consume it
    return auth;
  }
  tokenCache = null;   // stale (or empty) — drop and fetch fresh
  try {
    return await bridgeClient.getToken();
  } catch (_e) {
    return null; // bridge/worker unreachable — caller degrades to direct key / off
  }
}

/**
 * Resolve credentials and build the GoogleGenAI client. Reuses `ai` ONLY when it
 * was built from a durable direct key; ephemeral-token clients (uses:1) are
 * rebuilt every connect. Never throws.
 * @returns {Promise<boolean>} true if a client is ready, false if honestly off.
 */
async function ensureClient() {
  // Durable direct-key client is safe to keep across sessions.
  if (ai && aiIsDirectKey) return true;

  const auth = await resolveAuth();

  // Preferred: ephemeral token minted by bridge/worker (key never in browser).
  // Single-use -> build a FRESH client every connect; never mark it reusable.
  if (auth && auth.token) {
    ai = new GoogleGenAI({ apiKey: auth.token, httpOptions: { apiVersion: 'v1alpha' } });
    aiIsDirectKey = false;
    return true;
  }

  // Dev fallback: raw apiKey from bridge response OR CONFIG.gemini.apiKeyDirect.
  const directKey =
    (auth && auth.apiKey) ||
    (CONFIG && CONFIG.gemini && CONFIG.gemini.apiKeyDirect) ||
    '';
  if (directKey) {
    bus.emit('toast', {
      text: 'Działam na kluczu deweloperskim — na produkcji użyj Workera.',
      kind: 'warn'
    });
    ai = new GoogleGenAI({ apiKey: directKey, httpOptions: { apiVersion: 'v1alpha' } });
    aiIsDirectKey = true;
    return true;
  }

  // Honest off — no key anywhere. Do not fake a session.
  ai = null;
  aiIsDirectKey = false;
  setStatus('off');
  bus.emit('toast', {
    text: 'Głos niedostępny — brak klucza. Uruchom most albo uzupełnij config.js.',
    kind: 'warn'
  });
  return false;
}

/**
 * Open (or reopen) the single Live session. Optionally resume via handle.
 * @param {{handle?: string, greet?: string}} [opts]
 */
async function connect(opts = {}) {
  if (session || connecting) return;
  connecting = true;
  // One-shot greeting for THIS open only (consumed in handleOpen). Reconnects and
  // reopens pass no greet, so the greeting never repeats.
  pendingGreet = opts.greet || null;
  // Model for this attempt: explicit fallback override > last-good model > primary.
  // A normal (non-fallback) connect resets the downgrade budget so a fresh session
  // always retries the primary first.
  const model = opts.model || activeModel || PRIMARY_MODEL;
  lastModel = model;
  sessionOpened = false;
  // Only a fresh, user-initiated connect (not a fallback/reconnect, marked
  // opts.internal) refills the one-shot downgrade budget.
  if (!opts.internal) modelFellBack = false;
  // New epoch: any callback from a previously-torn-down session is now stale
  // and will be ignored, which kills the deliberate-close vs auto-retry race.
  const epoch = ++sessionEpoch;
  setStatus('connecting');

  // Latency: this is the ONLY awaited network call before ai.live.connect (and it
  // usually resolves from the prefetch cache without a round-trip).
  const ready = await ensureClient();
  if (!ready) {
    connecting = false;
    return; // ensureClient already reported honest off-state
  }

  // Build the system instruction from the persona + the SYNC facts cache — never
  // await the network here (that would delay time-to-first-audio). If the memory
  // module hasn't shipped the sync API yet, degrade to no facts.
  let facts = [];
  try {
    facts = (typeof memory.getFactsCached === 'function' ? memory.getFactsCached() : []) || [];
  } catch (_e) {
    facts = [];
  }
  const factBlock = facts.length
    ? '\n\nFAKTY O JURKU:\n' + facts.map((f) => '- ' + f).join('\n')
    : '';

  const config = {
    // Live (bidiGenerateContent) models ONLY support AUDIO output — requesting
    // TEXT closes the socket with 1007. So we always generate audio; text-output
    // modes simply don't PLAY it and surface the outputTranscription as the reply.
    responseModalities: [Modality.AUDIO],
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: CONFIG.gemini.voiceName } }
    },
    systemInstruction: PERSONA + factBlock,
    // Tools come from the shared router (built fresh per call), so every module's
    // init()-registered tool is visible to the model at connect time.
    tools: toolRouter.getDeclarations(),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: opts.handle ? { handle: opts.handle } : {},
    contextWindowCompression: { slidingWindow: {} }
  };

  try {
    session = await ai.live.connect({
      model,
      config,
      callbacks: {
        onopen: () => { if (epoch === sessionEpoch) handleOpen(); },
        onmessage: (m) => { if (epoch === sessionEpoch) handleMessage(m); },
        onerror: (e) => { if (epoch === sessionEpoch) handleError(e); },
        onclose: (e) => { if (epoch === sessionEpoch) handleClose(e); }
      }
    });
  } catch (err) {
    console.error('[gemini-live] connect failed', err);
    connecting = false;
    session = null;
    // A synchronous connect throw on the primary -> try the fallback model once.
    if (tryModelFallback('connect-throw')) return;
    setStatus('error', String(err && err.message ? err.message : err));
    bus.emit('toast', { text: 'Nie udało się połączyć z modelem — sprawdź klucz i sieć.', kind: 'warn' });
    return;
  }

  connecting = false;
}

/**
 * If the primary model NEVER opened and we haven't downgraded yet, reconnect once
 * on the fallback model. Returns true if a fallback connect was kicked off (caller
 * should stop its own error handling), false otherwise.
 * @param {string} reason  for logging only
 * @returns {boolean}
 */
function tryModelFallback(reason) {
  if (sessionOpened) return false;                          // it worked — not a model problem
  if (modelFellBack) return false;                          // already downgraded once
  if (!FALLBACK_MODEL || lastModel === FALLBACK_MODEL) return false;
  modelFellBack = true;
  setStatus('connecting', 'model-fallback');
  console.warn('[gemini-live] primary model failed (' + reason + ') — falling back to ' + FALLBACK_MODEL);
  bus.emit('toast', { text: 'Model ' + PRIMARY_MODEL + ' nie wstał — przełączam na zapasowy.', kind: 'warn' });
  connect({ model: FALLBACK_MODEL, internal: true }).catch((e) => console.error('[gemini-live] fallback connect', e));
  return true;
}

// ============================================================================
//  SESSION CALLBACKS
// ============================================================================

function handleOpen() {
  retriedOnce = false;
  // This model works — remember it so reconnects/resumptions reuse it and the
  // fallback gate (sessionOpened) never fires for a mid-session drop.
  sessionOpened = true;
  activeModel = lastModel;
  setStatus('open');

  // Start audio pipelines per current mode.
  const mode = state.get('mode') || { input: 'voice', output: 'voice' };
  if (mode.output === 'voice') startAudioOut();
  if (mode.input === 'voice') startAudioIn().catch((e) => console.error('[gemini-live] mic', e));

  // Startup greeting: send exactly ONE user turn with the required phrasing. The
  // persona has a compliance rule that echoes it verbatim, so Gzowo speaks the
  // greeting through this Live session. One-shot — cleared before sending.
  if (pendingGreet) {
    const name = pendingGreet;
    pendingGreet = null;
    try {
      session.sendClientContent({
        turns: [{
          role: 'user',
          parts: [{ text: 'Przywitaj się dokładnie słowami: "Witaj, ' + name +
            '. Jak mogę ci dzisiaj pomóc?" i czekaj na odpowiedź.' }]
        }],
        turnComplete: true
      });
    } catch (err) {
      console.error('[gemini-live] greet send failed', err);
    }
  }

  // Session opening implies a conversation. Flip idle->talking now. If we opened
  // WHILE the startup reveal is still running (ui==='startup'), we can't flip yet
  // (startup->talking is invalid); defer the flip until the startup->idle
  // transition lands — the only transition out of 'startup'.
  if (state.ui === 'idle') {
    state.setUI('talking', 'voice');
  } else if (state.ui === 'startup') {
    bus.once('state:change', ({ to }) => {
      if (to === 'idle' && session) state.setUI('talking', 'voice-deferred');
    });
  }

  // Arm the silence watchdog.
  bumpAudioActivity();
  startSilenceWatch();
}

/**
 * @param {import('@google/genai').LiveServerMessage} message
 */
function handleMessage(message) {
  if (!message) return;

  // ---- goAway: server will drop us soon -> schedule transparent reconnect ----
  if (message.goAway) {
    scheduleReconnect(message.goAway.timeLeft);
  }

  // ---- sessionResumptionUpdate: stash the handle in RAM ----
  if (message.sessionResumptionUpdate) {
    const upd = message.sessionResumptionUpdate;
    if (upd.resumable && upd.newHandle) resumptionHandle = upd.newHandle;
  }

  // ---- serverContent: audio, transcripts, turn lifecycle ----
  const sc = message.serverContent;
  if (sc) {
    // Interruption: model was cut off -> flush the playback queue instantly.
    if (sc.interrupted) flushPlayback();

    // Native-audio models always reply with AUDIO parts. Any part.text here is
    // the model's internal THINKING (not the answer) — ignore it. The real reply
    // text comes via outputTranscription below. Audio is PLAYED only in
    // voice-output modes; text-output modes stay silent and show the transcript.
    const outMode = (state.get('mode') || {}).output;
    const parts = sc.modelTurn && sc.modelTurn.parts;
    if (parts && parts.length) {
      for (const part of parts) {
        const inline = part.inlineData;
        if (inline && inline.data && typeof inline.mimeType === 'string' &&
            inline.mimeType.startsWith('audio/pcm')) {
          if (outMode === 'voice') enqueuePlayback(inline.data);
        }
      }
    }

    // Transcripts accumulate; finalize on turnComplete.
    if (sc.inputTranscription && sc.inputTranscription.text) {
      userBuf += sc.inputTranscription.text;
      emitTranscript('user', userBuf, false);
    }
    if (sc.outputTranscription && sc.outputTranscription.text) {
      modelBuf += sc.outputTranscription.text;
      emitTranscript('gzowo', modelBuf, false);
    }

    if (sc.turnComplete) {
      if (userBuf) {
        emitTranscript('user', userBuf, true);
        memory.appendTranscript({ role: 'user', text: userBuf, ts: Date.now() });
        userBuf = '';
      }
      if (modelBuf) {
        emitTranscript('gzowo', modelBuf, true);
        memory.appendTranscript({ role: 'gzowo', text: modelBuf, ts: Date.now() });
        modelBuf = '';
      }
    }
  }

  // ---- toolCall: dispatch through the shared router; send REAL results back ----
  if (message.toolCall && Array.isArray(message.toolCall.functionCalls)) {
    handleToolCalls(message.toolCall.functionCalls);
  }
}

/**
 * Run each function call through the tool-router and reply with its REAL result
 * (bug 9 fix — no more blanket {ok:true}). dispatch() never rejects and enforces
 * its own 8s timeout, so Promise.all is safe and lets multi-call turns run in
 * parallel. The router broadcasts 'assistant:tool' itself, so we do NOT emit it.
 * @param {Array<{id:string,name:string,args?:object}>} calls
 */
async function handleToolCalls(calls) {
  const functionResponses = await Promise.all(calls.map(async (call) => {
    const result = await toolRouter.dispatch(call.name, call.args || {});
    // Log the router's real result so the model's spoken claim can be checked
    // against what actually happened (acceptance: 'schowaj to' -> real response).
    console.log('[gemini-live] tool', call.name, call.args || {}, '->', result);
    return { id: call.id, name: call.name, response: result };
  }));
  try {
    if (session) session.sendToolResponse({ functionResponses });
  } catch (err) {
    console.error('[gemini-live] sendToolResponse failed', err);
  }
}

/**
 * @param {ErrorEvent|Error} err
 */
function handleError(err) {
  console.error('[gemini-live] session error', err);
  setStatus('error', String(err && err.message ? err.message : err));
}

/**
 * Only fires for the CURRENT session (epoch-guarded) and only when we did NOT
 * close it deliberately (deliberate closes bump the epoch first -> their onclose
 * is stale and filtered out). So every call here is a genuinely unexpected drop.
 * @param {CloseEvent} [ev]
 */
function handleClose(ev) {
  teardownSession();

  // Model fallback FIRST: if we never opened (e.g. primary model closed us with
  // 1008 before onopen) and haven't downgraded yet, retry once on the fallback.
  if (tryModelFallback('close-before-open')) return;

  // Unexpected drop: one transparent retry using the resumption handle.
  if (!retriedOnce) {
    retriedOnce = true;
    setStatus('connecting', 'reconnect');
    connect({ handle: resumptionHandle || undefined, internal: true }).catch((e) =>
      console.error('[gemini-live] reconnect failed', e)
    );
    return;
  }

  // Retry budget spent — be honest.
  setStatus('closed', ev && ev.reason ? String(ev.reason) : 'dropped');
  bus.emit('toast', { text: 'Sesja się rozłączyła i nie wróciła — spróbuj ponownie.', kind: 'warn' });
}

/**
 * Deliberately close the current session so its late onclose is filtered out by
 * the epoch guard (never triggers auto-retry). Tears down all session resources.
 */
function closeSessionDeliberately() {
  sessionEpoch++;                       // stale-out this session's pending callbacks
  const s = session;
  teardownSession();                    // clears `session`, audio, timers
  try { s && s.close(); } catch (_e) { /* ignore */ }
}

// ============================================================================
//  RECONNECT (goAway) + GRACEFUL END
// ============================================================================

/**
 * Schedule a transparent reconnect just before the server's deadline.
 * @param {string|undefined} timeLeft  ISO-8601 duration string (e.g. "9.5s")
 */
function scheduleReconnect(timeLeft) {
  if (goAwayTimer) return; // already scheduled
  const ms = parseDurationMs(timeLeft);
  // Reconnect ~1.5s before the deadline, but never in the past.
  const delay = Math.max(500, ms - 1500);
  goAwayTimer = setTimeout(async () => {
    goAwayTimer = null;
    const handle = resumptionHandle || undefined;
    // Close the doomed session ourselves, then reopen resumed — transparent to UI.
    closeSessionDeliberately();
    await connect({ handle, internal: true });
  }, delay);
}

/** Close the session gracefully after an end_conversation tool ack. */
function scheduleGracefulEnd() {
  // Let the model's farewell audio finish, then close down to idle/showing.
  const wait = Math.max(0, nextStartTime - (outCtx ? outCtx.currentTime : 0));
  const ms = Math.min(6000, Math.round(wait * 1000) + 400);
  setTimeout(() => {
    closeSessionDeliberately();
    setStatus('closed');
    // Contract: showing stays showing, everything else falls to idle. Guard the
    // same-state case so the state machine doesn't log a spurious ignored-transition.
    const target = state.ui === 'showing' ? 'showing' : 'idle';
    if (state.ui !== target) state.setUI(target, 'end_conversation');
  }, ms);
}

// ============================================================================
//  PUBLIC CONTROL
// ============================================================================

function onToggle() {
  if (session || connecting) {
    // Close on toggle.
    closeSessionDeliberately();
    setStatus('closed');
    if (state.ui === 'talking') state.setUI('idle', 'voice:toggle');
  } else {
    connect().catch((e) => console.error('[gemini-live] toggle connect', e));
  }
}

function onWake() {
  // Open the session; the wake sound itself is owned by wake-word.js.
  if (!session && !connecting) {
    connect().catch((e) => console.error('[gemini-live] wake connect', e));
  }
}

/**
 * Startup asks the voice stack to speak the greeting. Open a session carrying the
 * one-shot greet; handleOpen sends the exact phrasing once the pipelines are up.
 * @param {{username:string}} payload
 */
function onStartupGreet(payload) {
  const username = payload && payload.username;
  if (!session && !connecting) {
    connect({ greet: username }).catch((e) => console.error('[gemini-live] greet connect', e));
  }
}

/**
 * @param {{text:string}} payload
 */
async function onChatSend(payload) {
  const text = payload && payload.text;
  if (!text) return;
  // Ensure a session exists (text-capable regardless of output modality).
  if (!session && !connecting) {
    await connect();
  }
  if (!session) return; // honest off already reported by connect/ensureClient
  try {
    session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text }] }],
      turnComplete: true
    });
    bumpAudioActivity(); // count text turns as activity for the silence watch
  } catch (err) {
    console.error('[gemini-live] sendClientContent failed', err);
  }
}

/**
 * @param {{input:'voice'|'text', output:'voice'|'text'}} mode
 */
function onModeChange(mode) {
  if (!session || !mode) return;
  // Output modality is locked at connect time -> reopen if it flipped.
  const needAudioOut = mode.output === 'voice';
  const haveAudioOut = !!outCtx;
  if (needAudioOut !== haveAudioOut) {
    const handle = resumptionHandle || undefined;
    closeSessionDeliberately();
    connect({ handle, internal: true }).catch((e) => console.error('[gemini-live] mode reopen', e));
    return;
  }
  // Input modality can toggle live: start/stop the mic without reconnecting.
  if (mode.input === 'voice' && !inCtx) {
    startAudioIn().catch((e) => console.error('[gemini-live] mic on mode change', e));
  } else if (mode.input !== 'voice' && inCtx) {
    stopAudioIn();
  }
}

// ============================================================================
//  AUDIO IN  (mic @16k -> Float32 worklet -> PCM16 base64 -> realtime input)
// ============================================================================

// Inline AudioWorklet: copies each input block and posts Float32 chunks (~2048).
// Buffers are reused per-instance; nothing allocated per render quantum beyond
// the transferred chunk when a buffer fills.
const WORKLET_SRC = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(2048);
    this._n = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._n++] = ch[i];
      if (this._n === this._buf.length) {
        // Transfer a copy so the model gets a stable snapshot.
        const out = this._buf.slice(0);
        this.port.postMessage(out, [out.buffer]);
        this._n = 0;
      }
    }
    return true;
  }
}
registerProcessor('gzowo-capture', CaptureProcessor);
`;

async function startAudioIn() {
  if (inCtx) return; // already running
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
  } catch (err) {
    // GŁOS→GŁOS must never fail silently. Tell the user exactly what to do.
    console.error('[gemini-live] mic getUserMedia failed', err);
    const name = err && err.name;
    const denied = name === 'NotAllowedError' || name === 'SecurityError';
    const busy = name === 'NotReadableError' || name === 'AbortError';
    bus.emit('toast', {
      text: denied
        ? 'Brak dostępu do mikrofonu — kliknij kłódkę w pasku adresu → Mikrofon → Zezwól i spróbuj ponownie.'
        : busy
          ? 'Mikrofon jest zajęty — zamknij inne karty lub aplikacje, które go używają, i spróbuj ponownie.'
          : 'Mikrofon niedostępny — sprawdź, czy jest podłączony i dozwolony.',
      kind: 'warn'
    });
    setStatus('error', 'mic: ' + (name || 'unknown'));
    throw err;
  }
  inCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  if (inCtx.state === 'suspended') { try { await inCtx.resume(); } catch (_e) { /* ignore */ } }

  if (!workletUrl) {
    workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
  }
  await inCtx.audioWorklet.addModule(workletUrl);

  micSource = inCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(inCtx, 'gzowo-capture');
  workletNode.port.onmessage = onMicChunk;
  micSource.connect(workletNode);
  // Worklet must be in the graph to pull; route to a muted sink (destination is
  // fine because the node produces no output — process() returns nothing).
  workletNode.connect(inCtx.destination);
}

/**
 * @param {MessageEvent<Float32Array>} ev
 */
function onMicChunk(ev) {
  const f32 = ev.data;
  if (!f32 || !f32.length) return;

  // RMS for the "in" amplitude meter (orb reacts to this).
  let sum = 0;
  for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
  const rms = Math.sqrt(sum / f32.length);
  emitAmplitude(Math.min(1, rms * 4), 'in');

  if (!session) return;
  const b64 = floatToPCM16Base64(f32);
  try {
    session.sendRealtimeInput({ audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } });
    bumpAudioActivity();
  } catch (err) {
    console.error('[gemini-live] sendRealtimeInput failed', err);
  }
}

function stopAudioIn() {
  try { workletNode && (workletNode.port.onmessage = null); } catch (_e) { /* ignore */ }
  try { workletNode && workletNode.disconnect(); } catch (_e) { /* ignore */ }
  try { micSource && micSource.disconnect(); } catch (_e) { /* ignore */ }
  try { micStream && micStream.getTracks().forEach((t) => t.stop()); } catch (_e) { /* ignore */ }
  try { inCtx && inCtx.close(); } catch (_e) { /* ignore */ }
  workletNode = null;
  micSource = null;
  micStream = null;
  inCtx = null;
}

// ============================================================================
//  AUDIO OUT  (base64 PCM16 @24k -> gapless scheduled playback + analyser meter)
// ============================================================================

function startAudioOut() {
  if (outCtx) return;
  outCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  if (outCtx.state === 'suspended') { try { outCtx.resume(); } catch (_e) { /* ignore */ } }
  outGain = outCtx.createGain();
  analyser = outCtx.createAnalyser();
  analyser.fftSize = 256;
  analyserData = new Float32Array(analyser.fftSize);
  outGain.connect(analyser);
  analyser.connect(outCtx.destination);
  applyMute(state.get('muted'));
  nextStartTime = 0;
  startOutMeter();
}

/**
 * Decode a base64 PCM16 chunk and schedule it gaplessly after the previous one.
 * @param {string} b64
 */
function enqueuePlayback(b64) {
  if (!outCtx) startAudioOut();
  const f32 = pcm16Base64ToFloat(b64);
  if (!f32.length) return;

  const buffer = outCtx.createBuffer(1, f32.length, 24000);
  buffer.copyToChannel(f32, 0);

  const src = outCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(outGain);

  const now = outCtx.currentTime;
  if (nextStartTime < now) nextStartTime = now;
  src.start(nextStartTime);
  nextStartTime += buffer.duration;

  scheduledSources.add(src);
  src.onended = () => scheduledSources.delete(src);

  bumpAudioActivity();
}

/** Cut all scheduled output immediately (server-side interruption / barge-in). */
function flushPlayback() {
  for (const src of scheduledSources) {
    try { src.onended = null; src.stop(); } catch (_e) { /* already ended */ }
  }
  scheduledSources.clear();
  nextStartTime = outCtx ? outCtx.currentTime : 0;
}

function startOutMeter() {
  if (outRafId) return;
  const loop = () => {
    if (!analyser) { outRafId = 0; return; }
    if (document.hidden) { outRafId = requestAnimationFrame(loop); return; }
    analyser.getFloatTimeDomainData(analyserData);
    let sum = 0;
    for (let i = 0; i < analyserData.length; i++) sum += analyserData[i] * analyserData[i];
    const rms = Math.sqrt(sum / analyserData.length);
    emitAmplitude(Math.min(1, rms * 3), 'out');
    outRafId = requestAnimationFrame(loop);
  };
  outRafId = requestAnimationFrame(loop);
}

function stopAudioOut() {
  if (outRafId) { cancelAnimationFrame(outRafId); outRafId = 0; }
  flushPlayback();
  try { analyser && analyser.disconnect(); } catch (_e) { /* ignore */ }
  try { outGain && outGain.disconnect(); } catch (_e) { /* ignore */ }
  try { outCtx && outCtx.close(); } catch (_e) { /* ignore */ }
  analyser = null;
  analyserData = null;
  outGain = null;
  outCtx = null;
  nextStartTime = 0;
}

/**
 * @param {boolean} muted
 */
function applyMute(muted) {
  if (outGain) outGain.gain.value = muted ? 0 : 1;
}

// ============================================================================
//  SILENCE POLICY
// ============================================================================

function bumpAudioActivity() {
  lastAudioAt = Date.now();
}

function startSilenceWatch() {
  if (silenceTimer) return;
  silenceTimer = setInterval(() => {
    if (!session) { stopSilenceWatch(); return; }
    if (state.ui !== 'talking') return; // only auto-close from a talking idle-out
    if (Date.now() - lastAudioAt >= SILENCE_MS) {
      closeSessionDeliberately();       // also clears this interval via teardown
      setStatus('closed', 'silence');
      state.setUI('idle', 'silence');
    }
  }, 5000);
}

function stopSilenceWatch() {
  if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = 0; }
}

// ============================================================================
//  TEARDOWN + HELPERS
// ============================================================================

/** Tear down all per-session resources (keeps `ai` + resumptionHandle). */
function teardownSession() {
  session = null;
  connecting = false;
  stopSilenceWatch();
  stopAudioIn();
  stopAudioOut();
  userBuf = '';
  modelBuf = '';
  if (goAwayTimer) { clearTimeout(goAwayTimer); goAwayTimer = null; }
  // Latency: warm a fresh token for the NEXT session in the background (single-use
  // ephemeral tokens can't be reused, so the last one is already spent). Fire-and-
  // forget — if there's no bridge/worker it silently no-ops.
  prefetchToken();
}

/**
 * Emit voice:session status + mirror to state.voiceStatus.
 * @param {'connecting'|'open'|'closed'|'error'|'off'} status
 * @param {string} [detail]
 */
function setStatus(status, detail) {
  state.set('voiceStatus', status);
  bus.emit('voice:session', detail ? { status, detail } : { status });
}

/**
 * @param {'user'|'gzowo'} role
 * @param {string} text
 * @param {boolean} final
 */
function emitTranscript(role, text, final) {
  bus.emit('voice:transcript', { role, text, final });
}

/**
 * @param {number} level  0..1
 * @param {'in'|'out'} source
 */
function emitAmplitude(level, source) {
  bus.emit('voice:amplitude', { level, source });
}

/**
 * Float32 [-1,1] -> PCM16 LE -> base64. Reuses no shared buffers (chunk-local).
 * @param {Float32Array} f32
 * @returns {string} base64
 */
function floatToPCM16Base64(f32) {
  const len = f32.length;
  const pcm = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    let s = f32[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return bytesToBase64(new Uint8Array(pcm.buffer));
}

/**
 * base64 PCM16 LE @24k -> Float32 [-1,1].
 * @param {string} b64
 * @returns {Float32Array}
 */
function pcm16Base64ToFloat(b64) {
  const bytes = base64ToBytes(b64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * @param {string} b64
 * @returns {Uint8Array}
 */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Parse an ISO-8601-ish duration ("9.5s", "0.750s", "12s") to milliseconds.
 * @param {string|undefined} d
 * @returns {number} ms (defaults to 8000 if unparseable)
 */
function parseDurationMs(d) {
  if (!d) return 8000;
  const m = String(d).match(/([0-9]*\.?[0-9]+)\s*s/i);
  if (m) return Math.round(parseFloat(m[1]) * 1000);
  const n = parseFloat(d);
  return Number.isFinite(n) ? Math.round(n * 1000) : 8000;
}
