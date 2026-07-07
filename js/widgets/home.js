// js/widgets/home.js — DOM · HOME ASSISTANT widget + its voice tools.
// Read-only dashboard: lights on/total, temperature list, sensor count. The user
// never manipulates the widget — all control goes through voice (control_home).
//
// Owns:
//   - homeDef()               frozen widget def (registered under 'home')
//   - export async function init()  registers the widget + 3 tools on the router
//
// Honesty laws:
//   - !ha.available()  -> centered dim mono empty state ('...NIEPODŁĄCZONY' + reason)
//   - real reads only  -> never fakes data; errors degrade to an honest message
//   - color (accent '#ffd166') lives ONLY inside .widget-body, via --widget-accent.
//
// Contract honored:
//   - toolRouter.registerWidget('home', homeDef)
//   - show_home {}     -> adds the widget (honest even when HA is down) -> {ok:true}
//   - home_status {}   -> real summary, or {ok:false,error:'... — <reason>'}
//   - control_home {entity_id, service, value?} -> calls HA, {ok:true,...} | {ok:false,error}

import { defineWidget } from './widget-base.js';
import { bus } from '../core/event-bus.js';
import { layout } from '../core/layout-engine.js';
import { toolRouter } from '../core/tool-router.js';
import { ha } from '../connectors/home-assistant.js';

const ACCENT = '#ffd166';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Round to at most one decimal, trimming a trailing '.0'.
function fmtNum(v) {
  const n = Math.round(Number(v) * 10) / 10;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// Turn a thrown bridge/HA error into an honest, short PL message.
function friendlyErr(err) {
  if (err && err.offline) return 'most jest offline';
  if (err && typeof err.error === 'string' && err.error) return err.error;
  if (err && err.status) return 'błąd ' + err.status;
  if (err && err.message) return String(err.message);
  return 'nieznany błąd';
}

// ---------------------------------------------------------------------------
// Scoped widget styles — injected INTO .widget-body (color allowed here only).
// ---------------------------------------------------------------------------
const HAW_CSS = `
.haw {
  width: 100%; height: 100%;
  display: flex; box-sizing: border-box;
  font-family: var(--font-mono);
  color: var(--fg);
}
.haw *, .haw *::before, .haw *::after { box-sizing: border-box; }

/* Empty / disconnected / error — centered dim mono */
.haw-empty {
  margin: auto; text-align: center;
  padding: var(--space-5);
  display: flex; flex-direction: column; gap: var(--space-2);
}
.haw-empty-title {
  font-size: var(--text-sm);
  letter-spacing: var(--tracking-wide);
  text-transform: uppercase;
  color: var(--fg-dim);
}
.haw-empty-reason {
  font-size: var(--text-sm);
  line-height: 1.55;
  color: var(--fg-faint);
}

/* Connected dashboard */
.haw-dash {
  width: 100%; height: 100%;
  display: flex; flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-1);
  min-height: 0;
}
.haw-lights {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--line);
}
.haw-lights-label {
  font-size: var(--text-xs);
  letter-spacing: var(--tracking-wide);
  color: var(--fg-dim);
}
.haw-lights-count {
  display: flex; align-items: baseline; gap: var(--space-2);
  line-height: 1;
  font-size: var(--text-2xl);
  color: var(--widget-accent, ${ACCENT});
}
.haw-lights-count b { font-weight: 600; }
.haw-lights-total { font-size: var(--text-lg); color: var(--fg-dim); }
.haw-lights-sub {
  font-size: var(--text-xs);
  letter-spacing: var(--tracking);
  color: var(--fg-faint);
}

.haw-section {
  display: flex; flex-direction: column; gap: var(--space-2);
  flex: 1; min-height: 0;
}
.haw-section-title {
  font-size: var(--text-xs);
  letter-spacing: var(--tracking-wide);
  color: var(--fg-dim);
}
.haw-temps {
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-direction: column;
  overflow-y: auto; min-height: 0;
}
.haw-temp {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--line);
  font-size: var(--text-md);
}
.haw-temp-name {
  color: var(--fg-dim);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding-right: var(--space-3);
}
.haw-temp-val {
  color: var(--fg);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.haw-unit { color: var(--fg-faint); font-size: var(--text-sm); margin-left: 2px; }
.haw-temp-none { color: var(--fg-faint); justify-content: center; border-bottom: 0; }
.haw-foot {
  font-size: var(--text-xs);
  letter-spacing: var(--tracking);
  color: var(--fg-faint);
}
`;

// ---------------------------------------------------------------------------
// Widget definition
// ---------------------------------------------------------------------------
export function homeDef() {
  return defineWidget({
    id: 'home',
    title: 'DOM · HOME ASSISTANT',
    color: ACCENT,
    size: 'lg',
    render(bodyEl) {
      let alive = true;
      let refreshTimer = null;
      const unsubs = [];

      // Inject scoped styles once (safe: body is freshly cleared on each render).
      const styleEl = document.createElement('style');
      styleEl.textContent = HAW_CSS;
      bodyEl.appendChild(styleEl);

      const root = document.createElement('div');
      root.className = 'haw';
      bodyEl.appendChild(root);

      function renderDisconnected() {
        root.innerHTML =
          '<div class="haw-empty">' +
            '<div class="haw-empty-title">HOME ASSISTANT NIEPODŁĄCZONY</div>' +
            `<div class="haw-empty-reason">${escapeHTML(ha.reason())}</div>` +
          '</div>';
      }

      function renderLoading() {
        root.innerHTML =
          '<div class="haw-empty">' +
            '<div class="haw-empty-reason">czytam stan domu…</div>' +
          '</div>';
      }

      function renderError(msg) {
        root.innerHTML =
          '<div class="haw-empty">' +
            '<div class="haw-empty-title">BŁĄD ODCZYTU</div>' +
            `<div class="haw-empty-reason">${escapeHTML(msg)}</div>` +
          '</div>';
      }

      function renderDashboard(summary) {
        const lights = summary.lights || { on: 0, total: 0 };
        const temps = Array.isArray(summary.temperatures) ? summary.temperatures : [];
        const sensors = Number(summary.sensors || 0);

        const tempRows = temps.length
          ? temps.map((t) =>
              '<li class="haw-temp">' +
                `<span class="haw-temp-name">${escapeHTML(t.name)}</span>` +
                '<span class="haw-temp-val">' +
                  `${escapeHTML(fmtNum(t.value))}` +
                  `<span class="haw-unit">${escapeHTML(t.unit || '')}</span>` +
                '</span>' +
              '</li>').join('')
          : '<li class="haw-temp haw-temp-none">brak czujników temperatury</li>';

        root.innerHTML =
          '<div class="haw-dash">' +
            '<div class="haw-lights">' +
              '<div class="haw-lights-label">ŚWIATŁA</div>' +
              '<div class="haw-lights-count">' +
                `<b>${lights.on}</b><span class="haw-lights-total">/ ${lights.total}</span>` +
              '</div>' +
              '<div class="haw-lights-sub">włączone</div>' +
            '</div>' +
            '<div class="haw-section">' +
              '<div class="haw-section-title">TEMPERATURY</div>' +
              `<ul class="haw-temps">${tempRows}</ul>` +
            '</div>' +
            `<div class="haw-foot">${sensors} czujników</div>` +
          '</div>';
      }

      async function load(showLoading) {
        if (!alive) return;
        if (!ha.available()) { renderDisconnected(); return; }
        if (showLoading) renderLoading();
        try {
          const summary = await ha.summary();
          if (!alive) return;
          renderDashboard(summary);
        } catch (err) {
          if (!alive) return;
          renderError(friendlyErr(err));
        }
      }

      // Re-evaluate connection whenever the bridge reports in (connect/disconnect).
      unsubs.push(bus.on('bridge:status', () => { if (alive) load(true); }));

      load(true);
      // Live refresh while mounted — silent (no loading flash) once we have data.
      refreshTimer = setInterval(() => {
        if (alive && ha.available()) load(false);
      }, 15000);

      // Cleanup: kill the interval + drop bus subs (no ticking after removal).
      return () => {
        alive = false;
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
        for (const u of unsubs) { try { u(); } catch (_e) { /* ignore */ } }
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Tool declarations + handlers (Gemini functionDeclarations, PL descriptions)
// ---------------------------------------------------------------------------
const showHomeDecl = {
  name: 'show_home',
  description: 'Pokazuje na ekranie widget DOM z panelem Home Assistant (tylko do odczytu: ' +
    'światła, temperatury, liczba czujników). Użyj, gdy Jurek chce zobaczyć stan domu.',
  parameters: { type: 'object', properties: {}, required: [] }
};

async function showHomeHandler() {
  layout.addWidget(homeDef());
  if (!ha.available()) {
    return { ok: true, note: 'Widget dodany, ale Home Assistant niepodłączony — ' + ha.reason() };
  }
  return { ok: true };
}

const homeStatusDecl = {
  name: 'home_status',
  description: 'Zwraca REALNY, aktualny stan Home Assistant (liczba włączonych świateł, ' +
    'temperatury z czujników, liczniki). Użyj, gdy Jurek pyta o stan domu, i mów wyłącznie to, ' +
    'co jest w odpowiedzi — nie zmyślaj danych. Gdy HA jest niepodłączone, powiedz to wprost.',
  parameters: { type: 'object', properties: {}, required: [] }
};

async function homeStatusHandler() {
  if (!ha.available()) {
    return { ok: false, error: 'Home Assistant niepodłączony — ' + ha.reason() };
  }
  try {
    const summary = await ha.summary();
    return { ok: true, summary };
  } catch (err) {
    return { ok: false, error: 'Nie udało się odczytać stanu: ' + friendlyErr(err) };
  }
}

const controlHomeDecl = {
  name: 'control_home',
  description: 'Steruje encją Home Assistant (np. światłem). Podaj entity_id (np. ' +
    '"light.salon"), service (turn_on / turn_off / toggle) i opcjonalnie value 0–100 dla ' +
    'jasności (mapuje się na brightness_pct). ZAWSZE potwierdź z Jurkiem, zanim wykonasz akcję ' +
    'nieodwracalną lub potencjalnie niebezpieczną (otwarcie zamka/bramy, wyłączenie ogrzewania, ' +
    'uruchomienie urządzenia grzewczego/silnika). Odpowiedź mówi prawdę — nie twierdź, że się ' +
    'udało, jeśli ok nie jest true.',
  parameters: {
    type: 'object',
    properties: {
      entity_id: { type: 'string', description: 'Encja HA, np. "light.salon".' },
      service: { type: 'string', description: 'Usługa HA: turn_on, turn_off, toggle itp.' },
      value: { type: 'number', description: 'Opcjonalnie 0–100: jasność (brightness_pct).' }
    },
    required: ['entity_id', 'service']
  }
};

async function controlHomeHandler(args = {}) {
  const entityId = args.entity_id;
  const service = args.service;
  const value = args.value;

  if (typeof entityId !== 'string' || !entityId) {
    return { ok: false, error: 'Brak entity_id.' };
  }
  if (typeof service !== 'string' || !service) {
    return { ok: false, error: 'Brak nazwy usługi (service).' };
  }
  if (!ha.available()) {
    return { ok: false, error: 'Home Assistant niepodłączony — ' + ha.reason() };
  }

  // Domain is the entity_id prefix ('light.salon' -> 'light').
  const domain = entityId.includes('.') ? entityId.slice(0, entityId.indexOf('.')) : entityId;
  const data = { entity_id: entityId };
  if (value != null) data.brightness_pct = value;

  try {
    await ha.callService(domain, service, data);
    return { ok: true, entity_id: entityId, service };
  } catch (err) {
    return { ok: false, error: friendlyErr(err) };
  }
}

// ---------------------------------------------------------------------------
// init — register the widget + tools on the shared router (idempotent).
// ---------------------------------------------------------------------------
export async function init() {
  toolRouter.registerWidget('home', homeDef);
  toolRouter.registerTool(showHomeDecl, showHomeHandler);
  toolRouter.registerTool(homeStatusDecl, homeStatusHandler);
  toolRouter.registerTool(controlHomeDecl, controlHomeHandler);
}
