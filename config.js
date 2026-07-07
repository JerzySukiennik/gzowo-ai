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
  gemini: {
    model: 'gemini-2.5-flash-native-audio-latest',
    voiceName: 'Schedar',                 // timbre chosen by Jurek
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
  // Paste the URL from `wrangler deploy` to enable voice on GitHub Pages.
  worker: { url: '' },

  // --- Weather (Open-Meteo, free, no key) — default Warszawa ---
  weather: { lat: 52.2297, lon: 21.0122, city: 'Warszawa' }
};
