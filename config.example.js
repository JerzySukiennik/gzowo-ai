// config.example.js — SZABLON konfiguracji Gzowo.
// Skopiuj ten plik do config.js (`cp config.example.js config.js`) i wklej realne
// klucze. config.js jest w .gitignore — NIGDY nie trafia do repo. Jak config.js
// nie istnieje, apka wczytuje ten plik i leci w trybie demo (placeholdery).
// Detekcja placeholderów: wartość zaczyna się od 'PASTE_' albo jest pusta ''.

export const CONFIG = {
  // --- Firebase (auth + pamięć cross-device) ---
  // Konsola Firebase -> Ustawienia projektu -> Twoje aplikacje (web) -> SDK config.
  // Włącz też: Authentication -> Sign-in method -> Email/Password ORAZ Firestore.
  firebase: {
    apiKey: 'PASTE_FIREBASE_API_KEY',                 // klucz web z SDK config
    authDomain: 'PASTE.firebaseapp.com',              // <projectId>.firebaseapp.com
    projectId: 'PASTE_PROJECT_ID',                    // ID projektu Firebase
    storageBucket: '',                                // opcjonalne (na razie puste)
    messagingSenderId: '',                            // opcjonalne
    appId: 'PASTE_APP_ID'                             // App ID web
  },

  // --- Login: wpisujesz samo imię, apka dokleja tę domenę (jurek -> jurek@gzowo.ai) ---
  // Użytkownika w Firebase Auth utwórz z TAKIM samym mailem (np. jurek@gzowo.ai).
  auth: { emailDomain: 'gzowo.ai' },

  // --- Gemini (mózg + głos, Live native audio) ---
  // Klucz z Google AI Studio (aistudio.google.com -> Get API key).
  gemini: {
    model: 'gemini-2.5-flash-preview-native-audio-dialog', // model speech-to-speech
    voiceName: 'Schedar',                             // timbre wybrany przez Jurka
    apiKeyDirect: ''                                  // klucz WPROST tylko do localhostu/testów.
                                                      // W sieci klucz mintuje Worker — zostaw ''.
  },

  // --- Porcupine (wake word "Hej Gzowo", on-device) ---
  // AccessKey z Picovoice Console (console.picovoice.ai). Model .ppn wytrenuj tam
  // i wrzuć do assets/wake/ (patrz assets/wake/README.md).
  porcupine: {
    accessKey: '',                                    // AccessKey z Picovoice Console
    keywords: [
      { label: 'Hej Gzowo', publicPath: 'assets/wake/hej-gzowo.ppn' }
    ]
  },

  // --- Most (Node na Macu: projekty, whisper STT, ukryte klucze) ---
  // URL lokalnego mostu. Na telefonie w domu podmień na lokalne IP Maca
  // (np. http://192.168.1.20:8787), żeby telefon też miał pełną moc.
  bridge: {
    url: 'http://localhost:8787'
  },

  // --- Cloudflare Worker (mintuje ephemeral tokeny, gdy nie ma mostu) ---
  // URL zdeployowanego workera. Puste = brak trybu "sieć" (tylko lokalnie).
  worker: {
    url: ''
  },

  // --- Pogoda (Open-Meteo, darmowe, bez klucza) ---
  // Domyślnie Warszawa. Zmień lat/lon/city pod swoją lokalizację.
  weather: {
    lat: 52.2297,
    lon: 21.0122,
    city: 'Warszawa'
  }
};
