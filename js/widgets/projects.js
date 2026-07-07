// js/widgets/projects.js — PROJEKTY widget (bridge-backed cards, size 'lg').
// Owns: projectsDef() factory + async init(). Routing lives in clock.js.
//
// On mount it asks the bridge for the project index and renders a responsive
// card grid. If the bridge is offline (throws {offline:true}) it degrades
// HONESTLY — no fake cards — and auto-retries when 'bridge:status' goes online.
//
// Contract honored:
//   - export async function init()
//   - export function projectsDef()
//   - render(bodyEl, ctx) returns a cleanup fn (drops the bridge:status sub).

import { defineWidget } from './widget-base.js';
import { bus } from '../core/event-bus.js';
import { bridgeClient } from '../bridge-client.js';

function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Status -> a compact modifier class (kept neutral/gray; no invented colors).
function statusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('active') || s.includes('aktyw') || s.includes('prog')) return 'is-active';
  if (s.includes('done') || s.includes('gotow') || s.includes('ship')) return 'is-done';
  if (s.includes('idea') || s.includes('plan')) return 'is-idea';
  return '';
}

function renderLoading(bodyEl) {
  bodyEl.innerHTML =
    '<div class="prj prj-load"><div class="prj-load-txt">pytam most o projekty&hellip;</div></div>';
}

function renderOffline(bodyEl) {
  bodyEl.innerHTML =
    '<div class="prj prj-offline">' +
      '<div class="prj-off-title">NIEDOSTĘPNE BEZ MOSTU</div>' +
      '<div class="prj-off-cmd">Odpal: <code>cd v1/bridge &amp;&amp; npm start</code></div>' +
      '<div class="prj-off-edek">Bez mostu nie widzę Twoich projektów, człowieku.</div>' +
    '</div>';
}

function renderCards(bodyEl, projects) {
  if (!Array.isArray(projects) || projects.length === 0) {
    bodyEl.innerHTML =
      '<div class="prj prj-empty">' +
        '<div class="prj-empty-title">PUSTO</div>' +
        '<div class="prj-empty-sub">Most działa, ale nie znalazł żadnego projektu.</div>' +
      '</div>';
    return;
  }

  const cards = projects.map((p) => {
    const stack = Array.isArray(p.stack) ? p.stack : [];
    const chips = stack.map((s) =>
      `<span class="prj-chip">${escapeHTML(s)}</span>`).join('');
    const badge = p.status
      ? `<span class="prj-badge ${statusClass(p.status)}">${escapeHTML(p.status)}</span>`
      : '';
    return '<article class="prj-card">' +
        '<div class="prj-card-top">' +
          `<h3 class="prj-name">${escapeHTML(p.name)}</h3>` +
          badge +
        '</div>' +
        `<p class="prj-desc">${escapeHTML(p.description)}</p>` +
        (chips ? `<div class="prj-chips">${chips}</div>` : '') +
      '</article>';
  }).join('');

  bodyEl.innerHTML = `<div class="prj"><div class="prj-grid">${cards}</div></div>`;
}

export function projectsDef() {
  return defineWidget({
    id: 'projects',
    title: 'PROJEKTY',
    color: null, // cards are chrome-neutral; no accent island here
    size: 'lg',
    render(bodyEl) {
      let alive = true;
      let unsubBridge = null;

      async function load() {
        if (!alive) return;
        renderLoading(bodyEl);
        try {
          const projects = await bridgeClient.getProjects();
          if (!alive) return;
          renderCards(bodyEl, projects);
        } catch (_err) {
          if (!alive) return;
          renderOffline(bodyEl);
          // Auto-retry the moment the bridge reports back online.
          if (!unsubBridge) {
            unsubBridge = bus.on('bridge:status', (payload) => {
              if (payload && payload.online) {
                if (unsubBridge) { unsubBridge(); unsubBridge = null; }
                load();
              }
            });
          }
        }
      }

      load();

      return () => {
        alive = false;
        if (unsubBridge) unsubBridge();
      };
    }
  });
}

// Routing lives in clock.js; nothing to wire here.
export async function init() {
  // Idempotent no-op.
}
