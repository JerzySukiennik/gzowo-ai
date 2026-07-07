# Gzowo AI — v1

Osobisty asystent-kokpit w stylu Jarvisa. Wołasz „Hej Gzowo", kula-awatar się
budzi i gadasz z nią **głosem po polsku w czasie rzeczywistym** (Gemini Live,
głos „Schedar"). Interfejs czarno-biały, hi-tech, z siatką i kinowym bootem jak
z Iron Mana. Osobowość w klimacie Edka Warchockiego. **Za darmo**, działa
lokalnie na Macu z pełną mocą, a wrzucona na sieć — z uczciwym zejściem funkcji
(żadnych atrap).

Czysty ES-modules w przeglądarce, **zero build stepu**. Wszystko z CDN.

---

## Uruchomienie lokalne (dokładne kroki)

Most (Node) serwuje **całą apkę** na jednym porcie i jednocześnie mintuje tokeny,
czyta projekty i robi whisper STT. Dzięki temu front i API są na tym samym
originie (`localhost:8787`) — **zero problemów z CORS**. To jest zalecana droga.

```bash
# stoisz w katalogu v1/

# --- 1. Klucze frontu ---------------------------------------------------------
cp config.example.js config.js
#   otwórz config.js i wklej realne wartości (patrz tabela "Gdzie wkleić co").
#   Bez tego kroku apka i tak wstaje — w TRYBIE DEMO (placeholdery, localStorage).

# --- 2. Klucz mostu -----------------------------------------------------------
cd bridge
cp .env.example .env
#   otwórz bridge/.env i wpisz GEMINI_API_KEY (patrz tabela niżej).
npm install                # jednorazowo — instaluje @google/genai

# --- 3. Start mostu -----------------------------------------------------------
npm start
#   most wstaje na http://localhost:8787 i serwuje z niego całą apkę
```

Otwórz w przeglądarce:

```
http://localhost:8787
```

> **NIE** otwieraj przez `file://` — mikrofon (`getUserMedia`), Porcupine i moduły
> ES nie działają z pliku. Musi być `http://localhost`.

Most po starcie wypisze też adres LAN (np. `http://10.0.0.5:8787`) — wpisz go na
**telefonie w tej samej sieci Wi-Fi**, żeby telefon miał pełną moc (głos + projekty).
Jeśli używasz LAN-owego adresu, dopisz go do `ALLOWED_ORIGINS` w `bridge/.env`
(np. `ALLOWED_ORIGINS=http://localhost:8787,http://10.0.0.5:8787`).

### Wariant bez mostu (tylko demo / szybki podgląd UI)

Jeśli chcesz tylko zobaczyć interfejs bez Node'a, odpal dowolny statyczny serwer
z katalogu `v1/` — apka poleci w **trybie demo** (bez głosu, bez projektów):

```bash
# w katalogu v1/
python3 -m http.server 8000     # potem otwórz http://localhost:8000
```

W tym wariancie most nie stoi, więc głos/projekty będą uczciwie „niedostępne".
(Nie mieszaj: jak stawiasz most na 8787, otwieraj apkę z 8787 — nie z 8000.)

---

## Gdzie wkleić co (każdy klucz / placeholder)

Dwa pliki z sekretami, oba w `.gitignore` (nigdy nie trafiają do repo):
`config.js` (front) i `bridge/.env` (most).

| Klucz / wartość | Plik → pole | Skąd wziąć | Placeholder do podmiany |
|---|---|---|---|
| **Gemini API key** (mózg + głos) | `bridge/.env` → `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com) → *Get API key* | `PASTE_GEMINI_API_KEY` |
| **Gemini key (dev, opcjonalny)** | `config.js` → `gemini.apiKeyDirect` | ten sam klucz co wyżej | `''` — zostaw puste, jeśli używasz mostu; wpisz TYLKO do testów bez mostu na localhost |
| **Firebase apiKey** | `config.js` → `firebase.apiKey` | [Firebase Console](https://console.firebase.google.com) → ⚙ Ustawienia projektu → *Twoje aplikacje* (web) → *SDK config* | `PASTE_FIREBASE_API_KEY` |
| **Firebase authDomain** | `config.js` → `firebase.authDomain` | tamże, `<projectId>.firebaseapp.com` | `PASTE.firebaseapp.com` |
| **Firebase projectId** | `config.js` → `firebase.projectId` | tamże | `PASTE_PROJECT_ID` |
| **Firebase appId** | `config.js` → `firebase.appId` | tamże (*App ID* web) | `PASTE_APP_ID` |
| **Picovoice AccessKey** (wake word) | `config.js` → `porcupine.accessKey` | [Picovoice Console](https://console.picovoice.ai) | `''` |
| **Model wake-worda `.ppn`** | plik → `assets/wake/hej-gzowo.ppn` | wytrenuj w Picovoice Console (patrz `assets/wake/README.md`) | brak pliku = WAKE OFF (uczciwie) |
| **Worker URL** (tryb „sieć", opcjonalny) | `config.js` → `worker.url` | z outputu `wrangler deploy` (sekcja niżej) | `''` |
| **PROJECTS_DIR** (co most indeksuje) | `bridge/.env` → `PROJECTS_DIR` | ścieżka do Twoich projektów | `/Users/jurek/Downloads/Claude/Projects` |
| **whisper.cpp** (fallback STT, opcjonalny) | `bridge/.env` → `WHISPER_BIN` + `WHISPER_MODEL` | `brew install whisper-cpp` + model ggml (patrz `bridge/whisper.js`) | oba puste = STT OFF (uczciwie) |
| **Pogoda** | — | Open-Meteo, darmowe, **bez klucza** | — (domyślnie Warszawa; zmień `weather.lat/lon/city` w `config.js`) |

**Ważne o Firebase:** w konsoli włącz **Authentication → Sign-in method →
Email/Password** ORAZ **Firestore Database** — bez tego logowanie (kinowy intro)
i pamięć cross-device nie ruszą. Bez poprawnego configu Firebase apka wchodzi w
**tryb demo**: logujesz się dowolnym loginem/hasłem, a pamięć leci na localStorage.

**Uwaga o Gemini:** klucz trzymamy w `bridge/.env` (most mintuje z niego
krótkożyciowe tokeny — klucz **nie** wychodzi do przeglądarki). Pole
`gemini.apiKeyDirect` w `config.js` to droga awaryjna „goły klucz" tylko do
testów na localhoście — do sieci zostaw je puste i użyj Workera.

---

## Pełna moc vs tryb lite (uczciwe degradowanie)

Gzowo nigdy nie udaje. Jak czegoś nie ma — mówi wprost „niedostępne".

| Funkcja | Z mostem (Mac / telefon w domu) | Bez mostu (sieć / poza domem) |
|---|---|---|
| Rozmowa głosem (Gemini Live) | ✅ | ✅ (token przez Worker) |
| Tryby tekst/głos (4 kombinacje) | ✅ | ✅ |
| Wake word „Hej Gzowo" | ✅ | ✅ (lokalnie w przeglądarce) |
| Pamięć / konto (Firebase) | ✅ | ✅ |
| Pogoda / zegar / timer | ✅ | ✅ |
| **Wiedza o projektach** | ✅ (most czyta `PROJECTS_DIR`) | ❌ uczciwie „niedostępne bez mostu" |
| **Whisper STT (fallback)** | ✅ (whisper.cpp na moście) | ❌ „niedostępne" |
| **Mintowanie tokenów** | ✅ (most) | ✅ (Worker) |
| Home Assistant / Bambu / web-embed | 🕓 v1.1 (placeholdery) | 🕓 v1.1 |

---

## Deploy Workera (opcjonalnie — tryb „sieć")

Worker mintuje krótkożyciowe tokeny, żeby klucz Gemini nigdy nie trafił do
przeglądarki, gdy nie ma mostu (apka na GitHub Pages / telefon poza domem).

```bash
cd worker
npx wrangler login                        # raz
npx wrangler secret put GEMINI_API_KEY    # wklej klucz jako sekret Cloudflare
npx wrangler deploy                       # skopiuj URL z outputu
```

Potem wpisz URL workera do `config.js` → `worker.url`
(np. `https://gzowo-worker.<konto>.workers.dev`). Dla prywatnego deployu ustaw
też `ALLOWED_ORIGINS` w `worker/wrangler.toml` na dokładny origin swojej strony.

---

## Sterowanie (skróty)

- **Spacja** — start/stop sesji głosowej
- **Esc** — schowaj widgety (gdy stan `SHOWING`)
- **T** — przełącz motyw (mono ↔ blueprint)
- **C** — pokaż/schowaj panel czatu
- Wołanie **„Hej Gzowo"** — obudź (jeśli wake word skonfigurowany)

---

## Coś nie działa?

- **Mikrofon nie łapie** → przeglądarka blokuje `getUserMedia`. Wejdź po
  `http://localhost:8787` (nie `file://`) i sprawdź uprawnienia mikrofonu (kłódka
  w pasku adresu).
- **Głos milczy, `/token` daje 503** → brak `GEMINI_API_KEY` w `bridge/.env`.
  Wpisz klucz i zrestartuj most (`Ctrl+C`, `npm start`).
- **Brave: wake word / głos milczy** → wyłącz **Shields** dla tej strony.
- **„demo mode" w konsoli** → nie ma `config.js` albo klucze to placeholdery
  (`PASTE_...` / puste). Skopiuj `config.example.js` → `config.js` i wpisz realne.
- **Projekty „niedostępne bez mostu"** → most nie stoi albo otwierasz apkę z
  innego portu niż most. Odpal `cd bridge && npm start` i wejdź na `:8787`.
- **CORS / „Most padł"** przy dwóch serwerach → nie stawiaj apki na innym porcie
  niż most. Otwieraj apkę **z mostu** (`:8787`), wtedy origin się zgadza.

---

## Struktura

```
v1/
  index.html            wejście, importmap (three, @google/genai, porcupine), <link> do CSS
  config.example.js     szablon kluczy frontu (kopiujesz do config.js)
  css/
    design-tokens.css   ŚWIĘTOŚĆ B&W — jedyne źródło kolorów/fontów/timingów
    base.css            reset + warstwy chrome (z-index map)
    layout.css          rama widgetu (frame/head/body)
    hud.css             top bar, dock, chat, toasty
    themes.css          blueprint extras
    widgets.css         wnętrza widgetów (jedyne miejsce na kolor: --wx/--tmr-accent)
    intro.css           kinowy boot
  js/
    core/               event-bus (katalog zdarzeń), state-manager, layout-engine
    orb/                kula-shader (jedyny kontekst WebGL)
    voice/              persona (Edek + TOOLS), gemini-live, wake-word, modes
    widgets/            widget-base, weather, clock (+ router narzędzi!), timer, projects, placeholders
    ui/                 hud, chat
    audio/              sound (CC0 + fallback proceduralny)
    memory/             firebase (auth + pamięć, tryb demo)
    bridge-client.js    klient mostu/workera (health poll + token chain)
    main.js             boot orchestrator (FINAL — kolejność init)
  bridge/               most Node (server serwuje apkę + /token /projects /stt)
  worker/               Cloudflare Worker (tokeny + proxy CORS)
  assets/wake/          model wake-worda .ppn (wytrenuj sam)
```
</content>
