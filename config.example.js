// config.example.js — SZABLON konfiguracji Gzowo.
// Skopiuj ten plik do config.js (`cp config.example.js config.js`) i wklej realne
// klucze. config.js jest w .gitignore — NIGDY nie trafia do repo. Jeśli config.js
// nie istnieje, apka wczytuje ten plik z placeholderami (część funkcji zdegradowana,
// ale apka i tak wstaje — logowanie leci wtedy w TRYBIE LOKALNYM, bez chmury).
//
// v2: brak Firebase Auth i brak trybu demo. Logowanie to własny auth na Firestore
// (users/{username} z solą + hashem) — patrz js/auth/custom-auth.js.

export const CONFIG = {
  // --- Firebase (pamięć cross-device + własny auth na Firestore) ---
  // Konsola Firebase -> Ustawienia projektu -> Twoje aplikacje (web) -> SDK config.
  // Włącz Firestore (Auth NIE jest potrzebny — hasła trzymamy sami w users/{username}).
  firebase: {
    apiKey: 'PASTE_FIREBASE_API_KEY',                 // klucz web z SDK config
    authDomain: 'PASTE.firebaseapp.com',              // <projectId>.firebaseapp.com
    projectId: 'PASTE_PROJECT_ID',                    // ID projektu Firebase
    storageBucket: '',                                // opcjonalne (na razie puste)
    messagingSenderId: '',                            // opcjonalne
    appId: 'PASTE_APP_ID'                             // App ID web
  },

  // --- Gemini (mózg + głos, Live native audio) ---
  // Klucz z Google AI Studio (aistudio.google.com -> Get API key) trzymasz w
  // bridge/.env oraz w sekrecie Workera. Tutaj apiKeyDirect ZOSTAW puste.
  gemini: {
    model: 'gemini-3.1-flash-live-preview',           // primary (native-audio, free tier)
    modelFallback: 'gemini-2.5-flash-native-audio-latest', // fallback, gdy primary nie wstanie
    voiceName: 'Schedar',                             // timbre wybrany przez Jurka
    apiKeyDirect: ''                                  // ⚠️ ZAWSZE puste — klucz mintuje most/Worker
  },

  // --- Wake word "Hej Gzowo" przez Vosk (darmowe, offline, bez konta) ---
  // Model PL (~53MB) serwuje lokalny most (models/vosk-pl.tar.gz). Bez mostu
  // (deploy) jest nieosiągalny -> uczciwe WAKE OFF.
  vosk: {
    modelUrl: '/models/vosk-pl.tar.gz',
    keywords: ['hej gzowo', 'ok gzowo', 'gzowo']
  },

  // --- Most (Node na Macu: projekty, whisper STT, proxy HA, fetch, ukryte klucze) ---
  // Na telefonie w domu podmień na lokalne IP Maca (np. http://192.168.1.20:8787).
  bridge: { url: 'http://localhost:8787' },

  // --- Cloudflare Worker (mintuje ephemeral tokeny dla zdeployowanej strony) ---
  // Wklej URL z `wrangler deploy`, żeby włączyć głos na GitHub Pages. Puste = tylko lokalnie.
  worker: { url: '' },

  // --- Pogoda (Open-Meteo, darmowe, bez klucza) — domyślnie Warszawa ---
  weather: { lat: 52.2297, lon: 21.0122, city: 'Warszawa' }
};
