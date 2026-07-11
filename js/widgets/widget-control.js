// js/widgets/widget-control.js — assistant control over on-screen widgets (v3 #12).
// Lets Gzowo restyle / resize / rearrange / emphasize the widgets it has shown,
// on voice command ("podkreśl pogodę", "zrób zegar mniejszy", "przełóż go w lewo",
// "zrób zegar czerwony"). All manipulation goes through the layout engine's
// assistant-only API — the USER still never touches widgets directly.
//
// Name resolution is fuzzy + PL-aware so Jurek never has to say the internal id.

import { toolRouter } from '../core/tool-router.js';
import { layout } from '../core/layout-engine.js';
import { setWeatherVariant, WEATHER_VARIANTS } from './weather.js';

// Spoken name (PL) -> widget id. Order-independent substring match.
const ALIASES = [
  ['weather', ['pogod', 'weather', 'temperatur']],
  ['clock', ['zegar', 'godzin', 'clock', 'czas', 'data']],
  ['timer', ['timer', 'stoper', 'minutnik', 'odlicz']],
  ['projects', ['projekt', 'projects']],
  ['web', ['stron', 'web', 'przegląd', 'youtube', 'film', 'embed']],
  ['home', ['dom', 'home', 'światł', 'swiatl', 'assistant']],
  ['bambu', ['bambu', 'druk', 'x1c', 'printer', 'drukark']],
  ['zaba', ['żab', 'zab', 'frog']]
];

const NAMED_COLORS = {
  czerwony: '#ff5a5a', czerwona: '#ff5a5a', red: '#ff5a5a',
  zielony: '#57d977', zielona: '#57d977', green: '#57d977',
  niebieski: '#5aa9ff', niebieska: '#5aa9ff', blue: '#5aa9ff',
  żółty: '#ffd166', zolty: '#ffd166', yellow: '#ffd166',
  pomarańczowy: '#ff9f43', pomaranczowy: '#ff9f43', orange: '#ff9f43',
  fioletowy: '#b18cff', purple: '#b18cff', fiolet: '#b18cff',
  różowy: '#ff8ad1', rozowy: '#ff8ad1', pink: '#ff8ad1',
  biały: '#ffffff', bialy: '#ffffff', white: '#ffffff'
};

const SIZE_WORDS = {
  malutki: 0.55, maleńki: 0.55, mały: 0.7, maly: 0.7, mniejszy: 0.7, sm: 0.7,
  średni: 1, sredni: 1, normalny: 1, md: 1,
  duży: 1.5, duzy: 1.5, większy: 1.5, wiekszy: 1.5, wielki: 1.75, ogromny: 2, lg: 1.5, xl: 2
};

/** Resolve a spoken name to a live widget id, or null. (Exported: hide_widget
 *  in widget-tools uses the same PL fuzzy matching.) */
export function resolveId(name) {
  const q = String(name || '').toLowerCase().trim();
  if (!q) return null;
  const liveIds = new Set((layout.getWidgets() || []).map((w) => w.id));
  // Direct id hit first.
  if (liveIds.has(q)) return q;
  for (const [id, keys] of ALIASES) {
    if (!liveIds.has(id)) continue;
    if (keys.some((k) => q.includes(k))) return id;
  }
  // If exactly one widget is on screen, "ten/to/go" resolves to it.
  if (liveIds.size === 1 && /\b(ten|to|go|tego|jego|widget)\b/.test(q)) {
    return [...liveIds][0];
  }
  return null;
}

function notFound(name) {
  const live = (layout.getWidgets() || []).map((w) => w.id);
  return {
    ok: false,
    error: 'Nie widzę na ekranie widgetu „' + name + '". Aktualnie widoczne: ' +
      (live.length ? live.join(', ') : 'żadne') + '. Najpierw go pokaż.'
  };
}

export async function init() {
  toolRouter.registerTool(
    {
      name: 'emphasize_widget',
      description: 'Podkreśla widget świecącą aurą/poświatą wokół niego (albo ją zdejmuje). ' +
        'Użyj gdy Jurek mówi „podkreśl/wyróżnij [widget]" lub „przestań podkreślać".',
      parameters: {
        type: 'object',
        properties: {
          widget: { type: 'string', description: 'Nazwa widgetu, np. "pogoda", "zegar".' },
          on: { type: 'boolean', description: 'true = włącz aurę (domyślnie), false = zdejmij.' }
        },
        required: ['widget']
      }
    },
    async ({ widget, on }) => {
      const id = resolveId(widget);
      if (!id) return notFound(widget);
      layout.emphasizeWidget(id, on !== false);
      return { ok: true, widget: id, emphasized: on !== false };
    }
  );

  toolRouter.registerTool(
    {
      name: 'restyle_widget',
      description: 'Zmienia wygląd widgetu: kolor akcentu (obwódka/nagłówek) i/lub przezroczystość. ' +
        'Kolor podaj słowem (czerwony, niebieski…) albo hexem; przezroczystość 0.15–1.',
      parameters: {
        type: 'object',
        properties: {
          widget: { type: 'string', description: 'Nazwa widgetu.' },
          color: { type: 'string', description: 'Kolor akcentu: nazwa PL/EN lub #hex. "brak"/"reset" zdejmuje.' },
          opacity: { type: 'number', description: 'Przezroczystość 0.15–1 (1 = pełna krycie).' }
        },
        required: ['widget']
      }
    },
    async ({ widget, color, opacity }) => {
      const id = resolveId(widget);
      if (!id) return notFound(widget);
      const opts = {};
      if (color != null) {
        const c = String(color).toLowerCase().trim();
        if (c === 'brak' || c === 'reset' || c === 'none' || c === 'domyślny') opts.accent = null;
        else opts.accent = NAMED_COLORS[c] || (/^#?[0-9a-f]{3,8}$/.test(c) ? (c[0] === '#' ? c : '#' + c) : c);
      }
      if (opacity != null) opts.opacity = Number(opacity);
      layout.styleWidget(id, opts);
      return { ok: true, widget: id, applied: opts };
    }
  );

  toolRouter.registerTool(
    {
      name: 'resize_widget',
      description: 'Zmienia wielkość widgetu. Podaj size słowem (mały/średni/duży/większy/mniejszy) ' +
        'albo scale liczbą (0.6–1.7). Uwaga: bardzo duże wartości mieszczą się w komórce układu.',
      parameters: {
        type: 'object',
        properties: {
          widget: { type: 'string', description: 'Nazwa widgetu.' },
          size: { type: 'string', description: 'mały | średni | duży | większy | mniejszy | wielki' },
          scale: { type: 'number', description: 'Alternatywnie liczbowo, 0.6–1.7.' }
        },
        required: ['widget']
      }
    },
    async ({ widget, size, scale }) => {
      const id = resolveId(widget);
      if (!id) return notFound(widget);
      let s = null;
      if (scale != null && Number.isFinite(Number(scale))) s = Number(scale);
      else if (size != null) s = SIZE_WORDS[String(size).toLowerCase().trim()] ?? null;
      if (s == null) return { ok: false, error: 'Nie rozumiem rozmiaru — podaj mały/średni/duży/większy albo liczbę 0.5–2.' };
      s = Math.max(0.5, Math.min(2, s));   // v4-b #7: allow real growth up to 2×
      layout.scaleWidget(id, s);
      return { ok: true, widget: id, scale: s };
    }
  );

  toolRouter.registerTool(
    {
      name: 'set_widget_variant',
      description: 'Przełącza WARIANT treści widgetu. Obsługiwane: pogoda → full (wszystko) | ' +
        'wind (tylko wiatr) | temp (tylko temperatura) | forecast (tylko prognoza 3 dni). ' +
        'Np. „pokaż w pogodzie tylko wiatr" → {widget:"pogoda", variant:"wind"}.',
      parameters: {
        type: 'object',
        properties: {
          widget: { type: 'string', description: 'Nazwa widgetu (na razie: pogoda).' },
          variant: { type: 'string', description: 'full | wind | temp | forecast.' }
        },
        required: ['widget', 'variant']
      }
    },
    async ({ widget, variant }) => {
      const id = resolveId(widget);
      if (!id) return notFound(widget);
      if (id !== 'weather') {
        return { ok: false, error: 'Widget „' + id + '" nie ma wariantów — na razie tylko pogoda (' + WEATHER_VARIANTS.join('/') + ').' };
      }
      const v = String(variant || '').toLowerCase().trim();
      const map = { wiatr: 'wind', temperatura: 'temp', prognoza: 'forecast', wszystko: 'full', pelny: 'full', pełny: 'full' };
      const resolved = map[v] || v;
      if (!setWeatherVariant(resolved)) {
        return { ok: false, error: 'Nieznany wariant „' + variant + '" (są: ' + WEATHER_VARIANTS.join(', ') + ').' };
      }
      return { ok: true, widget: id, variant: resolved };
    }
  );

  toolRouter.registerTool(
    {
      name: 'arrange_widget',
      description: 'Przekłada widget w układzie: w lewo, w prawo, na początek albo na koniec. ' +
        'Reszta widgetów przepływa, żeby zrobić miejsce.',
      parameters: {
        type: 'object',
        properties: {
          widget: { type: 'string', description: 'Nazwa widgetu.' },
          where: { type: 'string', description: 'left | right | first | last (w lewo / w prawo / na początek / na koniec).' }
        },
        required: ['widget', 'where']
      }
    },
    async ({ widget, where }) => {
      const id = resolveId(widget);
      if (!id) return notFound(widget);
      const map = { lewo: 'left', prawo: 'right', początek: 'first', poczatek: 'first', koniec: 'last' };
      const w = map[String(where).toLowerCase().trim()] || String(where).toLowerCase().trim();
      if (!['left', 'right', 'first', 'last'].includes(w)) {
        return { ok: false, error: 'Kierunek: left/right/first/last.' };
      }
      layout.moveWidget(id, w);
      return { ok: true, widget: id, where: w };
    }
  );
}
