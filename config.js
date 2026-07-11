// config.js — Gzowo runtime config (loaded into window.GZOWO_CONFIG).
// ⚠️ PUBLIC-SAFE ONLY — this file IS committed to the public repo.
// Firebase web keys are public by design (secured by Firestore rules), so they are
// fine here. The Gemini API key is a REAL secret and must NEVER live in this file —
// it stays only in bridge/.env (local) and the Cloudflare Worker secret (deployed).
// Keep apiKeyDirect = ''.
//
// v2: no Firebase Auth, no demo mode. Login is a custom Firestore-backed auth
// (users/{username} with salt+hash) — see js/auth/custom-auth.js.

export const CONFIG = {
  // --- Firebase (cross-device memory + custom Firestore auth) — public-safe web config ---
  firebase: {
    apiKey: 'AIzaSyCqlWNyOUqHgIxQ4Wb7jNWIcNDuLrzKqwU',
    authDomain: 'gzowo-ai.firebaseapp.com',
    projectId: 'gzowo-ai',
    storageBucket: 'gzowo-ai.firebasestorage.app',
    messagingSenderId: '717017060506',
    appId: '1:717017060506:web:775c59f063d43567b1fb23'
  },

  // --- Gemini (brain + voice, Live native audio) ---
  // model = primary, modelFallback = tried once if the primary never opens (e.g. a
  // preview model gets pulled). gemini-live.js does the client-side downgrade; keep
  // the Worker's liveConnectConstraints.model in sync with `model`.
  gemini: {
    model: 'gemini-3.1-flash-live-preview',        // primary (newer native-audio, free tier)
    modelFallback: 'gemini-2.5-flash-native-audio-latest', // fallback if primary won't open
    // Voice tuning (Jurek 2026-07-09: lisp + UA accent → forced pl-PL). If Schedar
    // still sounds off, try: 'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Zephyr'.
    voiceName: 'Schedar',                 // timbre chosen by Jurek
    languageCode: 'pl-PL',                // force Polish TTS locale
    apiKeyDirect: ''                      // ⚠️ ALWAYS empty — key is in bridge/.env + Worker, NEVER here
  },

  // --- Wake word "Hej Gzowo" via Vosk (free, offline, no account) ---
  // The ~53MB Polish model is served locally by the bridge (models/vosk-pl.tar.gz);
  // with no bridge (deployed) it's unreachable -> honest WAKE OFF.
  vosk: {
    modelUrl: '/models/vosk-pl.tar.gz',
    keywords: ['hej gzowo', 'ok gzowo', 'gzowo']
  },

  // --- Bridge (local Node on Mac: projects, whisper, HA proxy, fetch, token minting) ---
  // On your phone at home, swap for the Mac's LAN IP (e.g. http://192.168.1.20:8787).
  bridge: { url: 'http://localhost:8787' },

  // --- Cloudflare Worker (mints ephemeral tokens for the deployed site) ---
  // Live (deployed 2026-07-09) — enables voice on GitHub Pages (no bridge).
  worker: { url: 'https://gzowo-worker.gzowo.workers.dev' },

  // --- Weather (Open-Meteo, free, no key) — DEFAULT Gzowo (działka rodzinna,
  //     gmina Pokrzywnica, pow. pułtuski). The assistant can switch to any city
  //     at runtime via show_weather{city} (Open-Meteo geocoding, no key). ---
  weather: { lat: 52.6154, lon: 21.0888, city: 'Gzowo' },

  // --- Rocket launch site (launch_weather go/no-go). From Jurek's plus code
  //     H3R9+4F Dzbanice (06-114) — locality point, fine for regional weather.
  //     Swap lat/lon for the exact pad if needed. ---
  launchSite: { lat: 52.6056, lon: 21.0768, name: 'Dzbanice' }
};
