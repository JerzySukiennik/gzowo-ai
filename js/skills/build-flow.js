// js/skills/build-flow.js — „Zbudujmy coś" (Jurek, v4 #21).
// One guided entry point + three build types:
//   1. SKILL      — a saved TEXT instruction, activated ON DEMAND as a "mode"
//                   („włącz tryb kucharza") — injected into the live session and
//                   into every new session while active. No code, instant.
//   2. CONNECTOR  — a user-defined REST API (name + base URL + optional auth
//                   header). Creates a dynamic query_<name> tool that fetches
//                   through the bridge /proxy (which forwards the auth header).
//   3. WIDGET     — the existing sandbox JS builder (skill-forge.js), optionally
//                   styled to match a chosen theme.
// build_something itself is a GUIDE: it returns the interview script and the
// model runs the conversation (rodzaj → co → theme dla widgetu → follow-upy).
// Everything persists per-account in localStorage. Honest failures everywhere.

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';
import { toolRouter } from '../core/tool-router.js';
import { THEMES } from '../widgets/widget-tools.js';

const CONFIG = window.GZOWO_CONFIG || {};
function bridgeBase() { return ((CONFIG.bridge && CONFIG.bridge.url) || '').replace(/\/$/, ''); }

// ---- Per-account persistence ------------------------------------------------
function ns(kind) {
  const u = state.get('user');
  return 'gz.' + kind + '.' + (u && u.username ? u.username : '__anon');
}
function load(kind) { try { return JSON.parse(localStorage.getItem(ns(kind)) || '[]'); } catch { return []; } }
function save(kind, list) { try { localStorage.setItem(ns(kind), JSON.stringify(list)); } catch (_e) { /* private mode */ } }

function slug(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[ąćęłńóśźż]/g, (c) => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }[c] || c))
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
}

// ---- Colour math (custom-theme synthesis) ----------------------------------
function parseHex(h) {
  let s = String(h || '').trim().replace(/^#/, '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
}
function toHex(c) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return '#' + h(c.r) + h(c.g) + h(c.b);
}
function mix(a, b, t) { return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }; }
function rgba(c, a) { return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${a})`; }
function luminance(c) { return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255; }

const FONT_STACKS = {
  sans: "'Inter','Helvetica Neue',Arial,system-ui,sans-serif",
  serif: "'Iowan Old Style','Palatino Linotype',Georgia,serif",
  mono: "var(--font-mono)",
  system: "-apple-system,'Segoe UI',system-ui,sans-serif",
  display: "'Bebas Neue','Oswald','Arial Narrow',sans-serif"
};

// Build a full [data-theme] token block from a small palette. Every UI token is
// DERIVED from bg/fg/accent so a 3-colour input yields a coherent theme.
function synthThemeCss(dataTheme, p) {
  const bg = parseHex(p.bg) || { r: 10, g: 10, b: 12 };
  const fg = parseHex(p.fg) || { r: 245, g: 245, b: 245 };
  const accent = parseHex(p.accent) || fg;
  const light = luminance(bg) > 0.5;             // light theme?
  const raised = mix(bg, light ? { r: 255, g: 255, b: 255 } : fg, light ? 0.55 : 0.06);
  const glassy = p.style !== 'flat';
  const font = FONT_STACKS[p.font] || FONT_STACKS.sans;
  const lines = (a) => rgba(mix(bg, fg, 0.5), a);
  return `[data-theme="${dataTheme}"]{
  --bg:${toHex(bg)}; --bg-raised:${toHex(raised)}; --fg:${toHex(fg)};
  --fg-dim:${toHex(mix(fg, bg, 0.38))}; --fg-faint:${toHex(mix(fg, bg, 0.62))};
  --line:${lines(0.14)}; --line-strong:${lines(0.24)}; --line-bright:${lines(0.42)};
  --grid-line:${rgba(fg, light ? 0.05 : 0.05)}; --grid-size:56px;
  --scrim:${rgba(bg, 0.82)};
  --glass-bg:${glassy ? rgba(fg, light ? 0.05 : 0.07) : toHex(raised)};
  --glass-bg-active:${rgba(fg, light ? 0.10 : 0.14)};
  --glass-border:${rgba(fg, 0.18)}; --glass-border-bright:${rgba(fg, 0.34)};
  --glass-blur:${glassy ? '22px' : '0px'};
  --glass-shadow:0 12px 42px ${rgba(bg, 0.6)};
  --glass-radius:${p.style === 'sharp' ? '2px' : '22px'};
  --glass-radius-sm:${p.style === 'sharp' ? '2px' : '14px'};
  --widget-radius:${p.style === 'sharp' ? '0px' : '12px'};
  --font-text:${font};
  --uiux-accent:${toHex(accent)};
  --glow-soft:0 0 24px ${rgba(accent, 0.22)};
}
[data-theme="${dataTheme}"] .widget-body{ --wx-accent:${toHex(accent)}; --tmr-accent:${toHex(accent)}; }
[data-theme="${dataTheme}"] .widget.has-accent, [data-theme="${dataTheme}"] .island.is-live{ }
[data-theme="${dataTheme}"] .auth-submit,[data-theme="${dataTheme}"] .chat-submit:hover,[data-theme="${dataTheme}"] .seg-opt.is-active{ }
`;
}

// One <style> element holds ALL custom themes; rebuilt on any change.
function rebuildThemeStyle(themes) {
  let styleEl = document.getElementById('gz-custom-themes');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'gz-custom-themes';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = themes.map((t) => synthThemeCss('custom-' + t.name, t.palette)).join('\n');
}

// ============================================================================
// 1. TEXT SKILLS — saved instructions, activated as ON-DEMAND modes.
// ============================================================================
function activeMode() { return state.get('skillMode') || null; }

function injectModeNote(text) {
  // Reuses the announce path: gemini-live forwards it into the live session.
  bus.emit('assistant:announce', { text });
}

export async function init() {
  // ---- build_something: the interview guide --------------------------------
  toolRouter.registerTool(
    {
      name: 'build_something',
      description: 'Gdy Jurek mówi „zbudujmy coś" (albo chce coś stworzyć, a nie wiadomo co) ' +
        '— wywołaj to narzędzie i poprowadź rozmowę według zwróconego przewodnika.',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    async () => ({
      ok: true,
      guide: 'Przeprowadź Jurka przez budowanie, pytając PO KOLEI (krótko, jedno pytanie naraz): ' +
        '1) RODZAJ — „Co budujemy? Skill (zapisana instrukcja/tryb), Connector (zewnętrzne API), ' +
        'Widget (mini-program na ekranie), Motyw (wygląd aplikacji), Scena (zestaw świateł jednym ' +
        'poleceniem) czy Rutyna (coś dzieje się samo o danej porze, np. poranny briefing)?" ' +
        '2) CO — poproś o konkretny opis, dopytaj o szczegóły, których brakuje. ' +
        '3) TYLKO dla widgetu: „Do którego motywu dopasować wygląd?" — motywy: ' + THEMES.join(', ') + '. ' +
        'Na końcu wywołaj właściwe narzędzie: skill → create_text_skill{name, instructions}; ' +
        'connector → create_connector{name, base_url, auth_header?}; ' +
        'widget → create_custom_widget{description, name?, theme?}; ' +
        'motyw → create_theme{name, bg, fg, accent, font?, style?} — kolory hex dobierasz SAM pod opis; ' +
        'scena → create_scene{name, steps} (kroki świateł); ' +
        'rutyna → create_automation{name, time/event, tool, args} — poranny briefing = tool:"morning_brief" ' +
        '(zapytaj o godzinę, np. 07:00, i czy dołożyć coś w polu extra). ' +
        'Po utworzeniu krótko powiedz, jak tego używać.'
    })
  );

  // ---- create_text_skill ----------------------------------------------------
  toolRouter.registerTool(
    {
      name: 'create_text_skill',
      description: 'Zapisuje SKILL TEKSTOWY: nazwany zestaw instrukcji, który Jurek włącza na ' +
        'życzenie („włącz tryb X" → enable_skill_mode). Instructions pisz w 2. osobie, po polsku ' +
        '(np. „Odpowiadasz wyłącznie rymami"). Działa od razu, bez budowania w tle.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Krótka nazwa skilla/trybu, np. "kucharz".' },
          instructions: { type: 'string', description: 'Pełna instrukcja zachowania w tym trybie.' }
        },
        required: ['name', 'instructions']
      }
    },
    async ({ name, instructions }) => {
      const n = slug(name);
      const ins = String(instructions || '').trim();
      if (!n || !ins) return { ok: false, error: 'podaj nazwę i instrukcję' };
      const list = load('textskills').filter((s) => s.name !== n);
      list.push({ name: n, instructions: ins, created: Date.now() });
      save('textskills', list);
      bus.emit('toast', { text: '📚 Skill „' + n + '" zapisany — włączysz go mówiąc „włącz tryb ' + n + '".', kind: 'info' });
      return { ok: true, saved: n, hint: 'Powiedz Jurkowi: skill gotowy, aktywuje się przez „włącz tryb ' + n + '".' };
    }
  );

  toolRouter.registerTool(
    {
      name: 'enable_skill_mode',
      description: 'Włącza zapisany skill tekstowy jako AKTYWNY TRYB rozmowy („włącz tryb X"). ' +
        'Od tej chwili stosujesz jego instrukcje, aż Jurek powie „wyłącz tryb".',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nazwa skilla z list_text_skills.' } },
        required: ['name']
      }
    },
    async ({ name }) => {
      const q = slug(name);
      const s = load('textskills').find((x) => x.name === q) ||
        load('textskills').find((x) => x.name.includes(q));
      if (!s) {
        const names = load('textskills').map((x) => x.name);
        return { ok: false, error: 'Nie mam skilla „' + name + '". Zapisane: ' + (names.length ? names.join(', ') : 'żadne') + '.' };
      }
      state.set('skillMode', { name: s.name, instructions: s.instructions });
      injectModeNote('Włączam tryb „' + s.name + '". Od teraz obowiązują Cię te instrukcje: ' + s.instructions);
      return { ok: true, mode: s.name, instructions: s.instructions };
    }
  );

  toolRouter.registerTool(
    {
      name: 'disable_skill_mode',
      description: 'Wyłącza aktywny tryb (skill tekstowy) — wracasz do normalnego zachowania.',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    async () => {
      const cur = activeMode();
      if (!cur) return { ok: false, error: 'żaden tryb nie jest włączony' };
      state.set('skillMode', null);
      injectModeNote('Tryb „' + cur.name + '" wyłączony — wracasz do normalnego zachowania Gzowo AI.');
      return { ok: true, disabled: cur.name };
    }
  );

  toolRouter.registerTool(
    {
      name: 'list_text_skills',
      description: 'Wylistuj zapisane skille tekstowe (tryby) + który jest aktywny.',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    async () => ({
      ok: true,
      skills: load('textskills').map((s) => s.name),
      active: (activeMode() || {}).name || null
    })
  );

  toolRouter.registerTool(
    {
      name: 'delete_text_skill',
      description: 'Usuwa zapisany skill tekstowy po nazwie.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nazwa skilla.' } },
        required: ['name']
      }
    },
    async ({ name }) => {
      const q = slug(name);
      const before = load('textskills');
      const after = before.filter((s) => s.name !== q);
      if (after.length === before.length) return { ok: false, error: 'nie znalazłem skilla „' + name + '"' };
      save('textskills', after);
      if ((activeMode() || {}).name === q) state.set('skillMode', null);
      return { ok: true, deleted: q };
    }
  );

  // ============================================================================
  // 2. CONNECTORS — user-defined REST APIs, queried through the bridge proxy.
  // ============================================================================
  function registerConnectorTool(c) {
    toolRouter.registerTool(
      {
        name: 'query_' + c.name,
        description: 'Connector „' + c.name + '": pobiera dane z ' + c.base_url +
          (c.note ? ' (' + c.note + ')' : '') +
          '. Podaj path (doklejany do bazy, np. "/users/1" albo "?q=..."). Zwraca surową odpowiedź (JSON/tekst).',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Ścieżka/query doklejane do base_url (może być puste).' } },
          required: []
        }
      },
      async ({ path }) => {
        const base = bridgeBase();
        if (!base) return { ok: false, error: 'most offline — connectory działają przez most' };
        const target = c.base_url.replace(/\/$/, '') + (path ? (String(path)[0] === '/' || String(path)[0] === '?' ? path : '/' + path) : '');
        let url = base + '/proxy?url=' + encodeURIComponent(target);
        if (c.auth_header) url += '&h=' + encodeURIComponent(c.auth_header);
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
          const text = await res.text();
          if (!res.ok || text.includes('gz-proxy-error')) {
            return { ok: false, error: 'API nie odpowiada (' + res.status + ')' };
          }
          let data = null;
          try { data = JSON.parse(text); } catch (_e) { /* not JSON — return text */ }
          return { ok: true, data: data != null ? data : text.slice(0, 6000) };
        } catch (_e) {
          return { ok: false, error: 'nie udało się połączyć z API' };
        }
      }
    );
  }

  toolRouter.registerTool(
    {
      name: 'create_connector',
      description: 'Tworzy CONNECTOR do zewnętrznego API: nazwa + base_url (http/https) + ' +
        'opcjonalny nagłówek autoryzacji ("Authorization: Bearer XXX" — poproś Jurka o klucz, ' +
        'jeśli API go wymaga). Powstaje narzędzie query_<nazwa> do pobierania danych. Działa ' +
        'tylko przy włączonym moście.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Krótka nazwa, np. "pogoda_imgw".' },
          base_url: { type: 'string', description: 'Bazowy adres API, np. https://api.example.com/v1' },
          auth_header: { type: 'string', description: 'Opcjonalnie: "Nazwa: wartość", np. "Authorization: Bearer abc".' },
          note: { type: 'string', description: 'Opcjonalna notka co to API robi.' }
        },
        required: ['name', 'base_url']
      }
    },
    async ({ name, base_url, auth_header, note }) => {
      const n = slug(name);
      let u;
      try { u = new URL(String(base_url)); } catch { u = null; }
      if (!n) return { ok: false, error: 'podaj nazwę connectora' };
      if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
        return { ok: false, error: 'base_url musi być pełnym adresem http(s)' };
      }
      const c = { name: n, base_url: u.toString(), auth_header: auth_header || '', note: note || '', created: Date.now() };
      const list = load('connectors').filter((x) => x.name !== n);
      list.push(c);
      save('connectors', list);
      registerConnectorTool(c);
      bus.emit('toast', { text: '🔌 Connector „' + n + '" gotowy (query_' + n + ').', kind: 'info' });
      return {
        ok: true,
        created: n,
        tool: 'query_' + n,
        note: 'Narzędzie query_' + n + ' będzie widoczne dla modelu od NASTĘPNEJ sesji głosowej; w tej rozmowie powiedz Jurkowi, że connector gotowy.'
      };
    }
  );

  toolRouter.registerTool(
    {
      name: 'list_connectors',
      description: 'Wylistuj connectory zbudowane przez Jurka (nazwa + adres API).',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    async () => ({
      ok: true,
      connectors: load('connectors').map((c) => ({ name: c.name, base_url: c.base_url, note: c.note }))
    })
  );

  toolRouter.registerTool(
    {
      name: 'delete_connector',
      description: 'Usuwa connector po nazwie.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nazwa connectora.' } },
        required: ['name']
      }
    },
    async ({ name }) => {
      const q = slug(name);
      const before = load('connectors');
      const after = before.filter((c) => c.name !== q);
      if (after.length === before.length) return { ok: false, error: 'nie znalazłem connectora „' + name + '"' };
      save('connectors', after);
      return { ok: true, deleted: q, note: 'narzędzie query_' + q + ' zniknie od następnej sesji' };
    }
  );

  // Re-register saved connectors' dynamic tools on every boot.
  for (const c of load('connectors')) {
    try { registerConnectorTool(c); } catch (e) { console.warn('[build-flow] connector tool failed', c.name, e); }
  }

  // ============================================================================
  // 4. THEMES — the assistant authors a whole colour theme (v4-b #1).
  // ============================================================================
  function refreshThemes() {
    const themes = load('themes');
    rebuildThemeStyle(themes);
    // Make custom names selectable by set_theme (THEMES is the same array ref).
    for (const t of themes) {
      const id = 'custom-' + t.name;
      if (!THEMES.includes(id)) THEMES.push(id);
    }
    return themes;
  }
  refreshThemes();   // inject saved custom themes at boot

  toolRouter.registerTool(
    {
      name: 'create_theme',
      description: 'Tworzy WŁASNY MOTYW aplikacji z palety, którą SAM dobierasz do opisu Jurka ' +
        '(np. „zachód słońca", „cyberpunk"). Podaj name + 3 kolory hex: bg (tło), fg (tekst), ' +
        'accent (akcent). Opcjonalnie font (sans/serif/mono/system/display) i style ' +
        '(glass/flat/sharp). Motyw od razu się włącza. Resztę tokenów wyliczę z tych kolorów.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nazwa motywu, np. "zachod".' },
          bg: { type: 'string', description: 'Kolor tła #hex.' },
          fg: { type: 'string', description: 'Kolor tekstu #hex.' },
          accent: { type: 'string', description: 'Kolor akcentu #hex.' },
          font: { type: 'string', description: 'sans | serif | mono | system | display (opcjonalnie).' },
          style: { type: 'string', description: 'glass | flat | sharp (opcjonalnie).' }
        },
        required: ['name', 'bg', 'fg', 'accent']
      }
    },
    async ({ name, bg, fg, accent, font, style }) => {
      const n = slug(name);
      if (!n) return { ok: false, error: 'podaj nazwę motywu' };
      if (!parseHex(bg) || !parseHex(fg) || !parseHex(accent)) {
        return { ok: false, error: 'kolory muszą być w formacie #RRGGBB' };
      }
      const palette = { bg, fg, accent, font: font || 'sans', style: style || 'glass' };
      const list = load('themes').filter((t) => t.name !== n);
      list.push({ name: n, palette, created: Date.now() });
      save('themes', list);
      refreshThemes();
      state.set('theme', 'custom-' + n);   // apply immediately
      bus.emit('toast', { text: '🎨 Motyw „' + n + '" gotowy i włączony.', kind: 'info' });
      return { ok: true, theme: 'custom-' + n, hint: 'Motyw włączony. Wróć do innego przez set_theme (np. mono).' };
    }
  );

  toolRouter.registerTool(
    {
      name: 'list_themes',
      description: 'Wylistuj motywy: wbudowane + własne zbudowane przez Jurka.',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    async () => ({
      ok: true,
      builtin: THEMES.filter((t) => !t.startsWith('custom-')),
      custom: load('themes').map((t) => t.name)
    })
  );

  toolRouter.registerTool(
    {
      name: 'delete_theme',
      description: 'Usuwa własny motyw po nazwie (wbudowanych nie da się usunąć).',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nazwa własnego motywu.' } },
        required: ['name']
      }
    },
    async ({ name }) => {
      const n = slug(name);
      const before = load('themes');
      const after = before.filter((t) => t.name !== n);
      if (after.length === before.length) return { ok: false, error: 'nie mam własnego motywu „' + name + '"' };
      save('themes', after);
      rebuildThemeStyle(after);
      const idx = THEMES.indexOf('custom-' + n);
      if (idx !== -1) THEMES.splice(idx, 1);
      if (state.get('theme') === 'custom-' + n) state.set('theme', 'mono');
      return { ok: true, deleted: n };
    }
  );
}
