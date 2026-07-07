# Gzowo AI — v2

Osobisty asystent-kokpit w stylu Jarvisa. Wołasz **„Hej Gzowo"**, awatar (żywy
biały loop na czarnym, Canvas 2D) budzi się i gadasz z nim **głosem po polsku
w czasie rzeczywistym** (Gemini Live native audio, głos „Schedar"). Interfejs
czarno-biały, hi-tech, z siatką. Sterowanie jest **głosem** — na dole tylko dwie
szklane wyspy (GŁOS + TRYBY), a ustawienia otwierasz wyłącznie mową.

Czysty ES-modules w przeglądarce, **zero build stepu**. Wszystko z CDN.

> **v2 vs v1 (co zniknęło):** stary „kinowy" boot w stylu Iron Mana, górny pasek
> HUD, dock i ręczne kontrolki widgetów, persona „Edka", tryb demo, kula three.js
> i wake word na Porcupine. Zamiast tego: **własny auth na Firestore**, krótki
> startup z powitaniem głosowym, awatar 2D, wake word na **Vosk** i asystent, który
> steruje wszystkim przez narzędzia (widgety chowa/pokazuje sam — użytkownik ich
> nie dotyka).

---

## Uruchomienie lokalne (dokładne kroki)

Most (Node) serwuje **całą apkę** na jednym porcie i jednocześnie mintuje tokeny
Gemini, czyta projekty, robi whisper STT i proxuje Home Assistant. Front i API są
na tym samym originie (`localhost:8787`) — **zero problemów z CORS**. To zalecana droga.

```bash
# stoisz w katalogu v1/

# --- 1. Config frontu ---------------------------------------------------------
# config.js JEST już w repo (trzyma tylko wartości public-safe: web-config Firebase
# + pusty slot na klucz Gemini). Sekretów tu nie ma, więc zwykle nic nie robisz.
# Chcesz własny projekt Firebase? Podmień pola firebase.* w config.js
# (albo skopiuj config.example.js -> config.js i wpisz swoje).

# --- 2. Klucz mostu (JEDYNY realny sekret) -----------------------------------
cd bridge
cp .env.example .env
#   otwórz bridge/.env i wpisz GEMINI_API_KEY (patrz tabela "Gdzie wkleić co").
npm install                # jednorazowo — instaluje @google/genai

# --- 3. Start mostu -----------------------------------------------------------
npm start
#   most wstaje na http://localhost:8787 i serwuje z niego całą apkę
```

Otwórz w przeglądarce:

```
http://localhost:8787
```

> **NIE** otwieraj przez `file://` — mikrofon (`getUserMedia`), Vosk i moduły ES
> nie działają z pliku. Musi być `http://localhost`.

Most po starcie wypisze też adres LAN (np. `http://10.0.0.5:8787`) — wpisz go na
**telefonie w tej samej sieci Wi-Fi**, żeby telefon miał pełną moc (głos + projekty).
Jeśli używasz LAN-owego adresu, dopisz go do `ALLOWED_ORIGINS` w `bridge/.env`
(np. `ALLOWED_ORIGINS=http://localhost:8787,http://10.0.0.5:8787`).

### Wariant bez mostu (tylko podgląd UI / tryb lokalny)

Jeśli chcesz tylko zobaczyć interfejs bez Node'a, odpal dowolny statyczny serwer
z katalogu `v1/` — apka poleci w **trybie lokalnym** (konta w localStorage, bez
głosu Gemini, bez projektów, bez wake worda):

```bash
# w katalogu v1/
python3 -m http.server 8000     # potem otwórz http://localhost:8000
```

W tym wariancie most nie stoi, więc głos/projekty/HA/wake będą uczciwie
„niedostępne". (Nie mieszaj portów: jak stawiasz most na 8787, otwieraj apkę
z 8787 — nie z 8000.)

---

## Pierwsze uruchomienie (co zobaczysz)

1. **Bramka logowania** (pełny ekran, zanim pojawi się UI). Wpisujesz nazwę → **Enter
   przenosi focus na hasło**. Nowej nazwy jeszcze nie ma → „NOWE KONTO" z polami
   **hasło + powtórz hasło** (min. **4 znaki**). Nazwa istnieje → logowanie.
2. **Startup** — awatar się odsłania, a asystent **wita Cię głosem**:
   „Witaj, [nazwa]. Jak mogę ci dzisiaj pomóc?".
3. Kolejny raz na tym urządzeniu → **sesja jest wznawiana** (bez ekranu logowania),
   lecisz od razu do startupu.

---

## Gdzie wkleić co (każdy klucz / placeholder)

Jedyny realny sekret to **`bridge/.env`** (`.gitignore` go pilnuje). **`config.js`
JEST commitowany** — trzyma tylko wartości public-safe (web-config Firebase jest
publiczny z założenia, chroni go `firestore.rules`; slot na klucz Gemini zostaje pusty).

| Klucz / wartość | Plik → pole | Skąd wziąć | Placeholder |
|---|---|---|---|
| **Gemini API key** (mózg + głos) | `bridge/.env` → `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com) → *Get API key* | `PASTE_GEMINI_API_KEY` |
| **Gemini key (dev, opcjonalny)** | `config.js` → `gemini.apiKeyDirect` | ten sam klucz | `''` — zostaw puste; wpisz TYLKO do testów bez mostu na localhoście |
| **Firebase apiKey/authDomain/projectId/appId** | `config.js` → `firebase.*` | [Firebase Console](https://console.firebase.google.com) → ⚙ Ustawienia → *Twoje aplikacje* (web) → *SDK config* | `PASTE_...` (w `config.example.js`) |
| **Wake word „Hej Gzowo"** | `models/vosk-pl.tar.gz` (serwowany przez most) | model Vosk PL (~53 MB), leży w `models/` | brak pliku / brak mostu = WAKE OFF (uczciwie) |
| **Worker URL** (tryb „sieć", opcjonalny) | `config.js` → `worker.url` | z outputu `wrangler deploy` | `''` |
| **PROJECTS_DIR** (co most indeksuje) | `bridge/.env` → `PROJECTS_DIR` | ścieżka do Twoich projektów | `/Users/jurek/Downloads/Claude/Projects` |
| **whisper.cpp** (fallback STT, opcjonalny) | `bridge/.env` → `WHISPER_BIN` + `WHISPER_MODEL` | `brew install whisper-cpp` + model ggml | oba puste = STT OFF (uczciwie) |
| **Home Assistant** (odczyt + sterowanie) | `bridge/.env` → `HA_URL` + `HA_TOKEN` | HA → profil → *Long-lived access tokens* → *Create Token* | oba puste = HA OFF (uczciwie) |
| **Bambu w HA** | `bridge/.env` → `HA_BAMBU_PREFIX` | prefiks encji drukarki w HA (np. `x1c`) | puste = brak widgetu drukarki |
| **Pogoda** | — | Open-Meteo, darmowe, **bez klucza** | domyślnie Warszawa; zmień `weather.lat/lon/city` w `config.js` |

**Model Gemini:** `gemini-2.5-flash-native-audio-latest` (speech-to-speech, wyjście
**tylko AUDIO** — tryby tekstowe nie odtwarzają dźwięku, tylko pokazują transkrypt).
Klucz żyje w `bridge/.env` (most mintuje z niego krótkożyciowe tokeny — **klucz nie
wychodzi do przeglądarki**). `gemini.apiKeyDirect` w `config.js` to droga awaryjna
„goły klucz" tylko do testów na localhoście — do sieci zostaw puste i użyj Workera.

**Firebase w v2:** potrzebujesz **tylko Firestore Database** — sekcja *Authentication*
nie jest używana (tożsamość trzymamy sami, patrz niżej). Wklej reguły z pliku
**`firestore.rules`** w: *Firebase Console → Firestore Database → Rules → wklej całość
→ Publish*. Bez poprawnego configu / reguł apka uczciwie zejdzie do **trybu lokalnego**
(konta i pamięć w localStorage, plakietka „TRYB LOKALNY — BEZ CHMURY").

---

## Pełna moc vs tryb lokalny (uczciwe degradowanie)

Gzowo nigdy nie udaje. Jak czegoś nie ma — mówi wprost „niedostępne".

| Funkcja | Z mostem (Mac / telefon w domu) | Bez mostu (sieć / poza domem) |
|---|---|---|
| Rozmowa głosem (Gemini Live) | ✅ | ✅ (token przez Worker) |
| Tryby tekst/głos (4 kombinacje) | ✅ | ✅ |
| Wake word „Hej Gzowo" (Vosk) | ✅ (model z mostu) | ❌ „niedostępne" (model nieosiągalny) |
| Konto + pamięć (Firestore) | ✅ | ✅ |
| Pogoda / zegar / timer / skille | ✅ | ✅ |
| **Wiedza o projektach** | ✅ (most czyta `PROJECTS_DIR`) | ❌ „niedostępne bez mostu" |
| **Home Assistant / Bambu X1C** | ✅ (jeśli `HA_*` w `.env`) | ❌ „podłącz HA" |
| **Web-embed / fetch strony** | ✅ | częściowo (embed tak; fetch przez Worker) |
| **Whisper STT (fallback)** | ✅ (jeśli whisper.cpp) | ❌ „niedostępne" |

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

## Sterowanie (v2 — głosem, nie klawiszami)

- **Mów** — cała reszta idzie głosem: „pokaż pogodę", „schowaj to", „otwórz
  ustawienia", „pobierz skill kostka", „odlicz do 2026-09-01"...
- **„Hej Gzowo"** — obudzenie (jeśli wake word aktywny w Ustawieniach + most stoi).
- **Wyspa GŁOS** (dół, po lewej) — start/stop sesji głosowej.
- **Wyspa TRYBY** (dół, po prawej) — WEJŚCIE/WYJŚCIE: głos ↔ tekst (4 kombinacje).
- **Spacja** — jedyny skrót klawiszowy: start/stop sesji głosowej.
- **Ustawienia** (motyw, dźwięk, nasłuch, konto/wyloguj) otwierasz **tylko głosem**
  („otwórz ustawienia") — nie ma na nie żadnego przycisku.
- Widgetów **nie dotykasz** — asystent sam je pokazuje, przypina i wyrzuca do kosza.

---

## Coś nie działa?

- **Mikrofon nie łapie** → przeglądarka blokuje `getUserMedia`. Wejdź po
  `http://localhost:8787` (nie `file://`) i sprawdź uprawnienia mikrofonu (kłódka
  w pasku adresu).
- **Głos milczy, `/token` daje 503** → brak `GEMINI_API_KEY` w `bridge/.env`.
  Wpisz klucz i zrestartuj most (`Ctrl+C`, `npm start`).
- **Wake word milczy** → most musi stać (serwuje `models/vosk-pl.tar.gz`) i w
  Ustawieniach → NASŁUCH musi być WŁĄCZONY. Bez mostu status jest „niedostępny".
- **Brave: wake word / głos milczy** → wyłącz **Shields** dla tej strony.
- **„TRYB LOKALNY" na bramce logowania** → config Firebase to placeholdery albo
  Firestore niedostępny. Konta i pamięć lecą wtedy na localStorage — apka działa.
- **Projekty „niedostępne bez mostu"** → most nie stoi albo otwierasz apkę z innego
  portu niż most. Odpal `cd bridge && npm start` i wejdź na `:8787`.
- **Home Assistant „niepodłączony"** → uzupełnij `HA_URL` + `HA_TOKEN` w `bridge/.env`
  i zrestartuj most (drukarka Bambu wymaga dodatkowo `HA_BAMBU_PREFIX`).

---

## Struktura

```
v1/
  index.html            wejście: importmap (@google/genai), <link> do CSS, montaż warstw
  config.js             config frontu (public-safe, COMMITOWANY) — Firebase web + puste sloty
  config.example.js     szablon (PASTE_...) do własnego projektu Firebase
  firestore.rules       reguły Firestore (wklej w konsoli -> Publish)
  css/
    design-tokens.css   ŚWIĘTOŚĆ B&W — jedyne źródło kolorów/fontów/timingów/z-index
    base.css            reset + warstwy chrome + jedyny przepis .glass
    layout.css          rama widgetu (frame/head/body — tylko tytuł, bez kontrolek)
    islands.css         dwie szklane wyspy (GŁOS + TRYBY) + panel trybów
    chat-bubble.css     dymek czatu przy awatarze
    trash.css           kosz (cel animacji wyrzucania)
    settings.css        panel ustawień (wejście tylko głosem)
    auth.css            bramka rejestracji/logowania
    widgets.css         wnętrza widgetów v1 (zegar/timer/pogoda/projekty)
    themes.css          blueprint extras
  js/
    core/               event-bus, state-manager, layout-engine, tool-router
    auth/               custom-auth (PBKDF2 na Firestore) + auth-screen
    startup/            startup (powitanie głosem, zamiast intro Iron Mana)
    avatar/             avatar (Canvas 2D — żywy loop -> fala przy mówieniu)
    voice/              persona, gemini-live (sesja Live), wake-word (Vosk), modes
    widgets/            widget-base, widget-tools (sterowanie asystenta), weather,
                        clock, timer, projects, home, bambu, marketplace, web-embed
    connectors/         home-assistant (warstwa domenowa nad mostem)
    skills/             skills (4 wbudowane) + marketplace (shim ładowania)
    ui/                 islands, chat, settings, trash, toasts
    audio/              sound (CC0 + fallback proceduralny)
    memory/             firebase (TYLKO Firestore + mirror localStorage)
    bridge-client.js    klient mostu/workera (health poll + token chain)
    main.js             boot orchestrator (FINAL — kolejność init, crash-proof)
  bridge/               most Node (serwuje apkę + /token /projects /stt /ha/* /fetch)
  worker/               Cloudflare Worker (tokeny + /fetch dla trybu „sieć")
  models/               vosk-pl.tar.gz (model wake worda, serwowany przez most)
```

---

## v2 — konta i bezpieczeństwo

W v2 nie ma **Firebase Auth** — tożsamość trzymamy sami na Firestore, żeby dało
się mieć hasło **min. 4 znaki** (Firebase Auth wymusza 6).

### Jak działa własny auth
- Konto to dokument **`users/{username}`** w Firestore:
  `{ salt, hash, iters, createdAt, lastLogin }`. **Hasło nigdy nie jest zapisywane
  ani logowane w jawnej postaci** — baza widzi tylko sól i hash.
- Hash liczy przeglądarka: **WebCrypto PBKDF2-HMAC-SHA256**, 150 000 iteracji, losowa
  16-bajtowa sól, 32-bajtowy klucz (hex). Logika w `js/auth/custom-auth.js`.
- **Pierwsze uruchomienie = rejestracja** (nazwa → hasło + powtórz, min. 4 znaki).
  Kolejny raz na tym urządzeniu → sesja wznawiana (`localStorage: gzowo.session`).
  Na innym urządzeniu → logowanie (nazwa → Enter → hasło → Enter). Offline też
  wstajesz: jeśli sieć nie odpowie przy weryfikacji sesji, ufamy lokalnej kopii.
- **Tryb lokalny (bez chmury):** config Firebase to placeholdery albo Firestore
  niedostępny → konta lądują w `localStorage` (`gzowo.localUsers`) tym samym
  mechanizmem sól+hash, a na ekranie widnieje plakietka **„TRYB LOKALNY — BEZ CHMURY"**.

### Kompromis bezpieczeństwa (uczciwie)
Rozwiązanie dla **aplikacji osobistej, nie dla produkcji**:

- Sól i hash są **czytelne publicznie** (klient musi je pobrać, żeby zweryfikować
  hasło) → **4-znakowe hasło da się złamać brute-force offline**.
- **Bez Firebase Auth reguły nie potwierdzają tożsamości** — dlatego w tej bazie
  **nie trzymamy żadnych realnych sekretów** (tylko preferencje, fakty i transkrypty).
- Twarde blokady zostają: nie da się wylistować kont (`list: false`), rejestracja
  zajętej nazwy przegrywa po stronie serwera, kont nie kasuje się z klienta
  (`delete: false`). Pełne uzasadnienie w komentarzu na górze `firestore.rules`.
