// js/widgets/marketplace.js — SKILLE · MARKETPLACE widget (marketplace-owned).
//
// The face of the skills system: a card grid the ASSISTANT shows on request
// ("pokaż marketplace / skille"). Each card is a REAL built-in skill with a
// "POBIERZ I UŻYWAJ" button that genuinely enables the capability (persisted
// cross-device as the 'skills' pref). No fake downloads — "download" = enable.
//
// SANCTIONED EXCEPTION to "user doesn't touch widgets": the spec explicitly ships
// a "Download & use" button, so this ONE interaction lives inside the widget body
// (not widget management — no hiding/pinning/closing by the user).
//
// GLOBAL RULES honored: chrome stays B&W (color only inside .widget-body, via the
// def.color accent exposed as --widget-accent); PL copy friendly + concise;
// English code; init() never throws.

import { toolRouter } from '../core/tool-router.js';
import { state } from '../core/state-manager.js';
import { layout } from '../core/layout-engine.js';
import { defineWidget, el } from './widget-base.js';
import { skills } from '../skills/skills.js';

// Marketplace accent (violet). Lives ONLY inside the body via --widget-accent.
const MKT_ACCENT = '#9b8cff';

// Scoped styles — every selector is prefixed .mkt- and rooted at .mkt so nothing
// leaks out of the body.
const MKT_CSS = `
.mkt { font-family: var(--font-mono); color: var(--fg); height: 100%; display: flex; flex-direction: column; gap: var(--space-4); }
.mkt-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: var(--space-3); align-content: start; overflow-y: auto; flex: 1; padding-right: 2px; }
.mkt-card { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-4); border: 1px solid var(--line-strong); border-radius: var(--glass-radius-sm); background: rgba(255,255,255,0.02); transition: border-color var(--t-fast) var(--ease-out); }
.mkt-card.is-on { border-color: var(--widget-accent); }
.mkt-name { font-size: var(--text-md); text-transform: uppercase; letter-spacing: var(--tracking); color: var(--widget-accent); }
.mkt-desc { font-size: var(--text-sm); line-height: 1.4; color: var(--fg-dim); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: calc(1.4em * 2); }
.mkt-status { font-size: var(--text-xs); letter-spacing: var(--tracking-wide); color: var(--fg-faint); }
.mkt-card.is-on .mkt-status { color: var(--widget-accent); }
.mkt-btn { margin-top: auto; font-family: var(--font-mono); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); text-transform: uppercase; padding: var(--space-2) var(--space-3); background: transparent; color: var(--fg); border: 1px solid var(--fg); border-radius: var(--glass-radius-sm); cursor: pointer; transition: background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out); }
.mkt-btn:hover { background: var(--fg); color: var(--bg); }
.mkt-btn.is-remove { color: var(--fg-dim); border-color: var(--line-bright); }
.mkt-btn.is-remove:hover { background: var(--line-bright); color: var(--fg); }
.mkt-hint { font-size: var(--text-xs); color: var(--fg-faint); letter-spacing: var(--tracking); }
`;

function styleEl(css) {
  const s = document.createElement('style');
  s.textContent = css;
  return s;
}

/** A quick spring pulse to acknowledge an enable (transform-only, 60fps-safe). */
function pulse(node) {
  try {
    node.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.04)' }, { transform: 'scale(1)' }],
      { duration: 220, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }
    );
  } catch (_e) {
    /* WAAPI unavailable — silently skip the flourish */
  }
}

/** Build one skill card. */
function buildCard(s, onEnable) {
  const card = el('div', 'mkt-card' + (s.enabled ? ' is-on' : ''));
  card.append(
    el('div', 'mkt-name', s.name),
    el('div', 'mkt-desc', s.desc),
    el('div', 'mkt-status', s.enabled ? 'POBRANY ✓' : '—')
  );

  const btn = el('button', 'mkt-btn');
  btn.type = 'button';
  if (s.enabled) {
    btn.classList.add('is-remove');
    btn.textContent = 'USUŃ';
    btn.addEventListener('click', () => skills.disable(s.id));
  } else {
    btn.textContent = 'POBIERZ I UŻYWAJ';
    btn.addEventListener('click', () => onEnable(s.id));
  }
  card.append(btn);
  return card;
}

/** The marketplace widget definition. Rebuilt fresh each show. */
export function marketplaceDef() {
  return defineWidget({
    id: 'marketplace',
    title: 'SKILLE · MARKETPLACE',
    color: MKT_ACCENT,
    size: 'lg',
    render(bodyEl) {
      let alive = true;
      // Id of a card just enabled by a click — its freshly-rendered card pulses.
      let pulsePendingId = null;

      bodyEl.append(styleEl(MKT_CSS));
      const wrap = el('div', 'mkt');
      const grid = el('div', 'mkt-grid');
      const hint = el('div', 'mkt-hint', 'Możesz też powiedzieć: „pobierz skill kostka”.');
      wrap.append(grid, hint);
      bodyEl.append(wrap);

      function onEnable(id) {
        // Set the pulse target BEFORE enabling: state.set fires the subscriber
        // synchronously, which re-renders the grid; the new card then pulses.
        pulsePendingId = id;
        skills.enable(id);
      }

      function renderCards() {
        if (!alive) return;
        grid.replaceChildren();
        for (const s of skills.list()) {
          const card = buildCard(s, onEnable);
          grid.append(card);
          if (pulsePendingId === s.id) pulse(card);
        }
        pulsePendingId = null;
      }

      renderCards();
      // Re-render whenever the enabled set changes (button clicks here, or a
      // voice install/uninstall elsewhere).
      const unsub = state.subscribe('skills', renderCards);

      return () => {
        alive = false;
        if (typeof unsub === 'function') unsub();
      };
    }
  });
}

// ============================================================================
// init() — register the widget factory + the show_marketplace tool. NEVER throws.
// ============================================================================
export async function init() {
  try {
    toolRouter.registerWidget('marketplace', marketplaceDef);
    toolRouter.registerTool(
      {
        name: 'show_marketplace',
        description: 'Pokaż marketplace skilli (dostępne umiejętności do pobrania).',
        parameters: { type: 'object', properties: {} }
      },
      async () => {
        layout.addWidget(marketplaceDef());
        return { ok: true, skills: skills.list().map((s) => ({ id: s.id, enabled: s.enabled })) };
      }
    );
  } catch (e) {
    console.error('[marketplace] init failed', e);
  }
}
