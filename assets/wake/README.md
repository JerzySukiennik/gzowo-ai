# assets/wake — model wake-worda "Hej Gzowo"

Tu leży plik `.ppn` z modelem słowa-klucza dla Porcupine. Trzeba go raz wytrenować.

## Jak zrobić `hej-gzowo.ppn`

1. Wejdź na [Picovoice Console](https://console.picovoice.ai) i zaloguj się (darmowe konto).
2. Zakładka **Porcupine** → **Create Wake Word**.
3. Wpisz frazę: `Hej Gzowo` (możesz dodać drugi wariant, np. `Ok Gzowo`).
4. Wybierz język **Polish (PL)** i platformę **Web (WASM)**.
5. **Train** → poczekaj, aż wygeneruje model → **Download**.
6. Rozpakuj i wrzuć plik `.ppn` tutaj pod nazwą **`hej-gzowo.ppn`**
   (musi zgadzać się ze ścieżką w `config.js` → `porcupine.keywords[].publicPath`).

## AccessKey

Z tej samej konsoli skopiuj swój **AccessKey** i wklej go do `config.js`
w polu `porcupine.accessKey`. Bez niego Porcupine nie ruszy.

> Model `.ppn` jest lekki i działa **lokalnie** (WASM) — dźwięk nie wychodzi
> z kompa, dopóki nie padnie "Hej Gzowo".
