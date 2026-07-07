// js/voice/modes.js — voice-owned. Owns the 4-mode matrix {input,output} x
// {voice,text}: republishes state.mode as 'mode:change'. Also provides the
// Whisper push-to-talk fallback when Gemini Live is down but the bridge is up.
//
// GLOBAL RULES: logic only; English comments, PL toasts (Edek tone); honest
// failure paths; keep this focused and small.

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';
import { bridgeClient } from '../bridge-client.js';

let voiceDown = false;       // last voice:session status was 'error' or 'off'
let recorder = null;         // active MediaRecorder for PTT
let recStream = null;        // its MediaStream
let recChunks = [];          // captured blobs
let recStopTimer = 0;        // 5s hard cap
let recording = false;

const PTT_MAX_MS = 5000;     // push-to-talk hard cap

/**
 * Idempotent init. Wires mode broadcasting + Whisper fallback. Never throws.
 */
export async function init() {
  try {
    // Broadcast the current mode once so late subscribers are in sync,
    // then on every change.
    const mode = state.get('mode') || { input: 'voice', output: 'voice' };
    bus.emit('mode:change', { input: mode.input, output: mode.output });

    state.subscribe('mode', (next) => {
      if (!next) return;
      bus.emit('mode:change', { input: next.input, output: next.output });
    });

    // Track voice-stack health for the fallback decision.
    bus.on('voice:session', (p) => {
      voiceDown = !!p && (p.status === 'error' || p.status === 'off');
    });

    // Push-to-talk path: only intercept a toggle when the live voice brain is
    // down AND we're in a voice-input mode. Otherwise gemini-live owns toggle.
    bus.on('voice:toggle', onToggle);
  } catch (err) {
    console.error('[modes] init failed', err);
  }
}

/**
 * Whisper push-to-talk fallback. First toggle starts a 5s (max) recording;
 * a second toggle stops early. On stop we STT via bridge and route the text
 * as a normal chat turn (which gemini-live sends as a text turn if any session
 * is possible). Honest toasts on every failure path.
 */
async function onToggle() {
  const mode = state.get('mode') || {};
  const inputIsVoice = mode.input === 'voice';

  // Only act as a fallback when the live brain is down and we're voice-input.
  if (!voiceDown || !inputIsVoice) return;

  // Second toggle -> stop early.
  if (recording) {
    stopRecording();
    return;
  }

  // Bridge offline -> nothing to fall back to. Be honest.
  if (!bridgeClient.online()) {
    bus.emit('toast', {
      text: 'Głos padł i mostu nie ma — nie mam czym dyktować. Odpal most albo wpisz z palca.',
      kind: 'warn'
    });
    return;
  }

  try {
    recStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
  } catch (err) {
    console.error('[modes] getUserMedia failed', err);
    bus.emit('toast', { text: 'Nie dostałem się do mikrofonu — sprawdź uprawnienia.', kind: 'warn' });
    return;
  }

  recChunks = [];
  try {
    recorder = new MediaRecorder(recStream);
  } catch (err) {
    console.error('[modes] MediaRecorder unsupported', err);
    cleanupStream();
    bus.emit('toast', { text: 'Ta przeglądarka nie umie nagrywać — spróbuj w Chrome/Brave.', kind: 'warn' });
    return;
  }

  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = onRecordingStop;
  recorder.start();
  recording = true;
  bus.emit('toast', { text: 'Whisper słucha — mów, mam max 5 sekund.', kind: 'info' });

  // Hard cap so a stuck recording still resolves.
  recStopTimer = setTimeout(stopRecording, PTT_MAX_MS);
}

function stopRecording() {
  if (recStopTimer) { clearTimeout(recStopTimer); recStopTimer = 0; }
  if (recorder && recording) {
    try { recorder.stop(); } catch (_e) { /* ignore */ }
  }
  recording = false;
}

async function onRecordingStop() {
  const type = (recorder && recorder.mimeType) || 'audio/webm';
  const blob = new Blob(recChunks, { type });
  recChunks = [];
  cleanupStream();

  if (!blob.size) {
    bus.emit('toast', { text: 'Nic nie nagrałem — spróbuj jeszcze raz.', kind: 'warn' });
    return;
  }

  let text = '';
  try {
    const res = await bridgeClient.stt(blob);
    text = (res && res.text) ? res.text.trim() : '';
  } catch (err) {
    console.error('[modes] whisper stt failed', err);
    bus.emit('toast', { text: 'Whisper się wysypał — most nie oddał tekstu.', kind: 'warn' });
    return;
  }

  if (!text) {
    bus.emit('toast', { text: 'Whisper nic nie usłyszał — cisza albo szum.', kind: 'warn' });
    return;
  }

  // Route as a normal text turn. gemini-live will send it if any session is
  // possible; if the brain is fully offline, it stays honestly silent, so we
  // guard with a status check for a truthful message.
  if (state.get('voiceStatus') === 'off') {
    bus.emit('toast', { text: 'Whisper przetworzył, ale mózg offline — sprawdź klucz.', kind: 'warn' });
    return;
  }
  bus.emit('chat:send', { text });
}

function cleanupStream() {
  try { recStream && recStream.getTracks().forEach((t) => t.stop()); } catch (_e) { /* ignore */ }
  recStream = null;
  recorder = null;
}
