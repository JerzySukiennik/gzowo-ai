// js/voice/wake-word.js — voice-owned. On-device wake word ("Hej Gzowo") via
// Porcupine (fully local WASM). Audio NEVER leaves the device until the keyword
// fires. Honest off-state when unconfigured; privacy toggle unsubscribes the mic.
//
// GLOBAL RULES: logic only; English comments; secrets via CONFIG; honest failure
// (no toast spam here — HUD shows WAKE OFF), single subscribe pipeline.

import { PorcupineWorker } from '@picovoice/porcupine-web';
import { WebVoiceProcessor } from '@picovoice/web-voice-processor';
import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';

const CONFIG = window.GZOWO_CONFIG;

let worker = null;         // PorcupineWorker instance
let subscribed = false;    // is the worker currently attached to the mic?
let unsubWake = null;      // state.subscribe('wakeEnabled') unsubscriber

/**
 * Idempotent init. Loads Porcupine if configured + keyword files reachable;
 * otherwise reports an honest OFF state (no toast spam). Never throws.
 */
export async function init() {
  // Capability flag: only ever true once a real Porcupine worker exists. The HUD
  // gates the WAKE toggle on this so the user can't flip it to a lying "WAKE ON"
  // when nothing is actually listening. Off by default (device-local, not a
  // persisted user pref).
  state.set('wakeAvailable', false);
  try {
    const pv = (CONFIG && CONFIG.porcupine) || {};
    const keywords = Array.isArray(pv.keywords) ? pv.keywords : [];

    // Honest off #1: no access key or no keywords configured.
    if (!pv.accessKey || keywords.length === 0) {
      console.warn('[wake-word] Porcupine not configured (no accessKey/keywords) — WAKE OFF');
      markUnavailable();
      return;
    }

    // Honest off #2: at least one keyword model file is missing (HEAD check).
    const allPresent = await keywordsReachable(keywords);
    if (!allPresent) {
      console.warn('[wake-word] keyword .ppn file missing on publicPath — WAKE OFF');
      markUnavailable();
      return;
    }

    worker = await PorcupineWorker.create(
      pv.accessKey,
      keywords.map((k) => ({ label: k.label, publicPath: k.publicPath })),
      detectionCallback
    );

    // Attach to the mic and mark enabled + available.
    await subscribeMic();
    state.set('wakeAvailable', true);
    state.set('wakeEnabled', true);

    // Privacy toggle: HUD flips wakeEnabled -> attach/detach the mic accordingly.
    unsubWake = state.subscribe('wakeEnabled', async (enabled) => {
      try {
        if (enabled) await subscribeMic();
        else await unsubscribeMic();
      } catch (err) {
        console.error('[wake-word] toggle failed', err);
      }
    });
  } catch (err) {
    // Any load failure -> honest off, no user-facing toast (HUD shows WAKE OFF).
    console.warn('[wake-word] init failed — WAKE OFF', err);
    markUnavailable();
  }
}

/**
 * Mark wake-word as unavailable WITHOUT clobbering the user's persisted
 * wakeEnabled preference. Capability ('wakeAvailable') is a device-local signal;
 * the HUD renders/enables the toggle off it. We deliberately do NOT force
 * wakeEnabled=false here — otherwise opening the app on a device without the .ppn
 * would silently wipe a WAKE-ON preference synced from another device.
 */
function markUnavailable() {
  state.set('wakeAvailable', false);
}

/**
 * Porcupine detection callback. Fires only on a local keyword match; only then
 * does anything leave the device (a wake event, not audio).
 * @param {{label:string, index:number}} _detection
 */
function detectionCallback(_detection) {
  bus.emit('sound:play', { name: 'wake' });
  bus.emit('voice:wake', {});
}

/** Attach the worker to the shared WebVoiceProcessor mic pipeline. */
async function subscribeMic() {
  if (!worker || subscribed) return;
  await WebVoiceProcessor.subscribe(worker);
  subscribed = true;
}

/** Detach from the mic — audio pipeline stops flowing to Porcupine (privacy). */
async function unsubscribeMic() {
  if (!worker || !subscribed) return;
  await WebVoiceProcessor.unsubscribe(worker);
  subscribed = false;
}

/**
 * HEAD-check every keyword model file so we degrade honestly if one is absent.
 * @param {Array<{publicPath:string}>} keywords
 * @returns {Promise<boolean>} true only if ALL files respond OK.
 */
async function keywordsReachable(keywords) {
  try {
    const checks = await Promise.all(
      keywords.map(async (k) => {
        if (!k || !k.publicPath) return false;
        try {
          const res = await fetch(k.publicPath, { method: 'HEAD' });
          return res.ok;
        } catch (_e) {
          return false;
        }
      })
    );
    return checks.every(Boolean);
  } catch (_e) {
    return false;
  }
}
