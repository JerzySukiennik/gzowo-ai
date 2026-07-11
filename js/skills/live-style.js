// js/skills/live-style.js — live UI customization (Jurek v4-g).
// Lets Gzowo restyle or move ANY on-screen element in the CURRENT session:
// „zmień tło na granatowe", „przesuń czat wyżej", „powiększ awatar". Changes are
// SESSION-ONLY inline styles — a page refresh resets everything (Gzowo warns about
// that). reset_customizations undoes them on demand.
//
// Safety: only CSS is applied (never HTML/JS); a light sanitizer drops obviously
// dangerous constructs. Targets resolve from friendly PL names OR a raw selector.

import { bus } from '../core/event-bus.js';
import { toolRouter } from '../core/tool-router.js';

// Friendly PL name -> CSS selector for the app's chrome + layers (index.html ids).
const TARGETS = {
  awatar: '#avatar-canvas', kula: '#avatar-canvas', orb: '#avatar-canvas',
  glowa: '#avatar-canvas', asystent: '#avatar-canvas',
  czat: '#chat-bubble', chat: '#chat-bubble', dymek: '#chat-bubble', rozmowa: '#chat-bubble',
  tlo: '#grid-bg', background: '#grid-bg', siatka: '#grid-bg', grid: '#grid-bg',
  sceneria: '#theme-scene', scena: '#theme-scene',
  wyspa: '#islands', wyspy: '#islands', pasek: '#islands', przyciski: '#islands',
  menu: '#islands', dock: '#islands', nawigacja: '#islands', sterowanie: '#islands',
  widgety: '#widget-layer', panel: '#widget-layer',
  kosz: '#trash-corner', toasty: '#toast-layer',
  ekran: 'body', strona: 'body', body: 'body', wszystko: 'body', aplikacja: 'body'
};
// Common widget names -> their live node.
const WIDGET_IDS = {
  pogoda: 'weather', weather: 'weather', zegar: 'clock', clock: 'clock',
  minutnik: 'timer', timer: 'timer', projekty: 'projects', projects: 'projects',
  dom: 'home', home: 'home', drukarka: 'bambu', bambu: 'bambu',
  notatki: 'notes', notes: 'notes', strona: 'web', web: 'web', zaba: 'zaba', frog: 'zaba'
};

function norm(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[ąćęłńóśźż]/g, (c) => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }[c] || c));
}

// Resolve a target string to an array of elements (capped). Order of resolution:
// friendly chrome name -> widget name -> raw CSS selector.
function resolve(target) {
  const raw = String(target || '').trim();
  const key = norm(raw);
  if (TARGETS[key]) { const el = document.querySelector(TARGETS[key]); return el ? [el] : []; }
  if (WIDGET_IDS[key]) { const el = document.querySelector('.widget[data-id="' + WIDGET_IDS[key] + '"]'); return el ? [el] : []; }
  // Raw selector fallback (only if it looks like one — avoids matching plain words).
  if (/[#.\[\]>]|^[a-z]+$/i.test(raw)) {
    try { return [...document.querySelectorAll(raw)].slice(0, 30); } catch (_e) { /* invalid selector */ }
  }
  return [];
}

// Parse a CSS declaration string ("color: red; font-size: 20px") into pairs.
// Drops obviously unsafe bits; only property:value survive.
function parseCss(css) {
  const out = [];
  const bad = /(javascript:|expression\(|<\/?\w|@import|behavior\s*:)/i;
  if (typeof css === 'object' && css) {
    for (const [k, v] of Object.entries(css)) if (!bad.test(String(v))) out.push([String(k).trim(), String(v).trim()]);
    return out;
  }
  for (const decl of String(css || '').split(';')) {
    const i = decl.indexOf(':');
    if (i === -1) continue;
    const prop = decl.slice(0, i).trim();
    const val = decl.slice(i + 1).trim();
    if (!prop || !val || bad.test(decl)) continue;
    out.push([prop, val]);
  }
  return out;
}

// Session registry of touched (el, prop) -> original inline value, for reset.
const touched = [];   // [{ el, prop, prev }]
let count = 0;

function applyStyles(els, pairs) {
  let applied = 0;
  for (const el of els) {
    for (const [prop, val] of pairs) {
      try {
        touched.push({ el, prop, prev: el.style.getPropertyValue(prop) });
        el.style.setProperty(prop, val);
        applied++;
      } catch (_e) { /* skip bad prop */ }
    }
  }
  count += applied;
  return applied;
}

export async function init() {
  toolRouter.registerTool(
    {
      name: 'customize_element',
      description: 'Zmienia STYL dowolnego elementu na ekranie w TEJ sesji (znika po odświeżeniu — ' +
        'uprzedź o tym Jurka). target: przyjazna nazwa (awatar, czat, tło, wyspy/przyciski, widgety, ' +
        'ekran) albo nazwa widgetu (pogoda, zegar, drukarka…) albo selektor CSS. css: deklaracje CSS, ' +
        'np. „background: #0a1a3a" albo „transform: scale(1.2); opacity: .8". Do przesuwania użyj ' +
        'move_element albo css z transform:translate. Po zmianie krótko potwierdź i przypomnij, że ' +
        'reset nastąpi po odświeżeniu strony.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Co zmienić (nazwa PL / nazwa widgetu / selektor CSS).' },
          css: { type: 'string', description: 'Deklaracje CSS, np. „color: #fff; font-size: 20px".' }
        },
        required: ['target', 'css']
      }
    },
    async ({ target, css }) => {
      const els = resolve(target);
      if (!els.length) return { ok: false, error: 'nie znalazłem elementu „' + String(target || '').trim() + '" (spróbuj: awatar, czat, tło, wyspy, widgety, ekran, nazwa widgetu albo selektor CSS)' };
      const pairs = parseCss(css);
      if (!pairs.length) return { ok: false, error: 'podaj poprawne CSS, np. „background: #123"' };
      const applied = applyStyles(els, pairs);
      return {
        ok: applied > 0,
        target,
        elements: els.length,
        applied,
        note: 'Zmiana działa tylko w tej sesji — po odświeżeniu strony wróci do domyślnego.'
      };
    }
  );

  toolRouter.registerTool(
    {
      name: 'move_element',
      description: 'Przesuwa element na ekranie w TEJ sesji (resetuje się po odświeżeniu). target jak w ' +
        'customize_element; dx/dy w pikselach (dodatnie = prawo/dół). Nakłada transform:translate. ' +
        'Do WIDGETÓW lepiej użyj arrange_widget/moveWidget — to jest do elementów UI (czat, wyspy, awatar).',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Co przesunąć (nazwa PL / selektor).' },
          dx: { type: 'number', description: 'Przesunięcie w poziomie (px).' },
          dy: { type: 'number', description: 'Przesunięcie w pionie (px).' }
        },
        required: ['target']
      }
    },
    async ({ target, dx, dy }) => {
      const els = resolve(target);
      if (!els.length) return { ok: false, error: 'nie znalazłem elementu „' + String(target || '').trim() + '"' };
      const x = Number(dx) || 0; const y = Number(dy) || 0;
      const applied = applyStyles(els, [['transform', `translate(${x}px, ${y}px)`]]);
      return { ok: applied > 0, target, dx: x, dy: y, note: 'Przesunięcie tylko w tej sesji — refresh je cofnie.' };
    }
  );

  toolRouter.registerTool(
    {
      name: 'reset_customizations',
      description: 'Cofa WSZYSTKIE zmiany stylu/pozycji zrobione w tej sesji przez customize_element/move_element (wraca do domyślnego wyglądu).',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    async () => {
      let n = 0;
      // Restore in reverse so the earliest original value wins per (el, prop).
      for (let i = touched.length - 1; i >= 0; i--) {
        const { el, prop, prev } = touched[i];
        try {
          if (prev) el.style.setProperty(prop, prev);
          else el.style.removeProperty(prop);
          n++;
        } catch (_e) { /* element gone */ }
      }
      touched.length = 0;
      count = 0;
      bus.emit('toast', { text: '↩️ Cofnięto zmiany wyglądu (' + n + ').', kind: 'info' });
      return { ok: true, reverted: n };
    }
  );
}
