// config.js — Gzowo runtime config (loaded into window.GZOWO_CONFIG).
// ⚠️ PUBLIC-SAFE ONLY — this file IS committed to the public repo.
// Firebase web keys are public by design (secured by Firestore rules + Auth
// authorized-domains), so they are fine here. The Gemini API key is a REAL
// secret and must NEVER live in this file — it stays only in bridge/.env
// (local) and the Cloudflare Worker secret (deployed). Keep apiKeyDirect = ''.

export const CONFIG = {
  // --- Firebase (auth + cross-device memory) — public-safe web config ---
  firebase: {
    apiKey: 'AIzaSyCqlWNyOUqHgIxQ4Wb7jNWIcNDuLrzKqwU',
    authDomain: 'gzowo-ai.firebaseapp.com',
    projectId: 'gzowo-ai',
    storageBucket: 'gzowo-ai.firebasestorage.app',
    messagingSenderId: '717017060506',
    appId: '1:717017060506:web:775c59f063d43567b1fb23'
  },

  // --- Login convenience: type just "jurek", app appends this domain -> jurek@gzowo.ai ---
  // Your Firebase user must be created with the SAME email (e.g. jurek@gzowo.ai).
  auth: { emailDomain: 'gzowo.ai' },

  // --- Login REMOVED: boot straight into the interface; memory stays local ---
  skipLogin: true,
  forceDemo: true,

  // --- Gemini (brain + voice, Live native audio) ---
  gemini: {
    model: 'gemini-2.5-flash-native-audio-latest',
    voiceName: 'Schedar',                 // timbre chosen by Jurek
    apiKeyDirect: ''                      // ⚠️ ALWAYS empty — key is in bridge/.env + Worker, NEVER here
  },

  // --- Porcupine (wake word "Hej Gzowo") — paste AccessKey when ready ---
  porcupine: {
    accessKey: '',                        // Picovoice Console AccessKey (empty = WAKE OFF, honest)
    keywords: [
      { label: 'Hej Gzowo', publicPath: 'assets/wake/hej-gzowo.ppn' }
    ]
  },

  // --- Bridge (local Node on Mac: projects, whisper, token minting) ---
  // On your phone at home, swap for the Mac's LAN IP (e.g. http://192.168.1.20:8787).
  bridge: { url: 'http://localhost:8787' },

  // --- Cloudflare Worker (mints ephemeral tokens for the deployed site) ---
  // Paste the URL from `wrangler deploy` to enable voice on GitHub Pages.
  worker: { url: '' },

  // --- Weather (Open-Meteo, free, no key) — default Warszawa ---
  weather: { lat: 52.2297, lon: 21.0122, city: 'Warszawa' }
};
