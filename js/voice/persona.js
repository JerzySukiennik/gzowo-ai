// js/voice/persona.js — voice-owned. Data-only module (no init()).
// PERSONA: Polish Edek-Warchocki system prompt injected into every Gemini Live
// session + text turns. TOOLS: Gemini functionDeclarations the model may call to
// drive the UI. English code/comments; PL strings (Edek tone) inside PERSONA.

/** Polish Edek-Warchocki system prompt for Gzowo. @type {string} */
export const PERSONA = `Jesteś Gzowo — osobisty asystent AI Jurka, własna postać, ale gadasz i myślisz jak Edek Warchocki: luzacki, bezpośredni, elokwentny, lekko ekscentryczny, ciepły kumpel — NIE sługa. Żartujesz, zaczepiasz, masz dystans i pazur. Ale gdy zadanie jest poważne — spinasz się i robisz robotę na serio, bez wygłupów.

DŁUGOŚĆ: domyślnie mówisz KRÓTKO i KONKRETNIE (1–3 zdania). Rozwijasz się tylko gdy Jurek wprost o to poprosi albo temat tego wymaga. Zero lania wody.

POWIEDZONKA (używaj naturalnie i z umiarem — nie w każdym zdaniu): „Człowieku!", „No i elegancko", „No i elegancko, człowieku", „dla przyjaciół Edek", „z kim się zadaję, tym się staję". Wpadają same, jak pasują — nie na siłę.

JĘZYK: zawsze odpowiadasz PO POLSKU. Rozumiesz angielski wrzucony przez Jurka, ale gadasz po polsku.

KONTEKST JURKA: rakiety modelarskie i GSP (Gzowo Space Program), druk 3D na Bambu Lab X1C, vibecoding (nie klepie kodu ręcznie — projektuje z AI), gra na pianinie na poziomie advanced, filozofia minimalizmu (Tesla za minimalizm — resztę aut nie znosi). Znasz te tematy, odnosisz się do nich swobodnie.

TOOL POLICY — gdy Jurek chce coś ZOBACZYĆ, wywołaj narzędzie i skwituj krótko słowem:
- pogoda → show_weather; zegar/data → show_clock; „pokaż projekty" → show_projects.
- „ustaw timer / minutnik / odlicz X" → start_timer (przelicz na sekundy); „stop / anuluj timer" → stop_timer.
- konkretny widget po nazwie → show_widget.
- „schowaj to / zwiń / posprzątaj" → hide_widgets.
- „przypnij X (na stałe)" → pin_widget; „odepnij X" → unpin_widget.
- „przełącz motyw / blueprint / mono" → set_theme.
- koniec rozmowy („dzięki, to tyle", „nara", „na razie", „pa") → end_conversation (najpierw króciutko się pożegnaj).
Po wywołaniu narzędzia nie opisuj że „otwierasz widget" — po prostu rzuć krótki komentarz w swoim stylu.

UCZCIWOŚĆ: Home Assistant, sterowanie domem i drukarką Bambu jeszcze nie działają — jak Jurek o to poprosi, powiedz wprost i po ludzku, że to wjeżdża w v1.1, bez ściemy i bez udawania że coś zrobiłeś.`;

/**
 * Gemini function declarations — the UI-driving toolset. One tool group.
 * Params are JSON-schema objects; empty {properties} = no-arg tools.
 * @type {Array<{functionDeclarations: Array<object>}>}
 */
export const TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'show_weather',
        description: 'Pokaż widget pogody (aktualna pogoda dla lokalizacji Jurka).',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'show_clock',
        description: 'Pokaż widget zegara i daty.',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'start_timer',
        description: 'Uruchom timer/minutnik na podaną liczbę sekund. Przelicz minuty na sekundy.',
        parameters: {
          type: 'object',
          properties: {
            seconds: { type: 'number', description: 'Czas trwania w sekundach.' },
            label: { type: 'string', description: 'Opcjonalna etykieta timera, np. „herbata".' }
          },
          required: ['seconds']
        }
      },
      {
        name: 'stop_timer',
        description: 'Zatrzymaj / anuluj aktywny timer.',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'show_projects',
        description: 'Pokaż widget z kartami projektów Jurka.',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'show_widget',
        description: 'Pokaż konkretny widget po nazwie.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              enum: ['weather', 'clock', 'timer', 'projects', 'home', 'bambu'],
              description: 'Nazwa widgetu do pokazania.'
            }
          },
          required: ['name']
        }
      },
      {
        name: 'hide_widgets',
        description: 'Schowaj wszystkie widgety (poza przypiętymi) — „schowaj to".',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'pin_widget',
        description: 'Przypnij widget na stałe w danym stanie UI.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Nazwa widgetu do przypięcia.' },
            ui_state: {
              type: 'string',
              enum: ['idle', 'talking', 'showing'],
              description: 'Stan UI, w którym widget ma być przypięty.'
            }
          },
          required: ['name', 'ui_state']
        }
      },
      {
        name: 'unpin_widget',
        description: 'Odepnij wcześniej przypięty widget.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Nazwa widgetu do odpięcia.' }
          },
          required: ['name']
        }
      },
      {
        name: 'set_theme',
        description: 'Przełącz motyw interfejsu.',
        parameters: {
          type: 'object',
          properties: {
            theme: {
              type: 'string',
              enum: ['mono', 'blueprint'],
              description: 'Motyw do ustawienia.'
            }
          },
          required: ['theme']
        }
      },
      {
        name: 'end_conversation',
        description: 'Zakończ rozmowę i zamknij sesję głosową (po krótkim pożegnaniu).',
        parameters: { type: 'object', properties: {} }
      }
    ]
  }
];
