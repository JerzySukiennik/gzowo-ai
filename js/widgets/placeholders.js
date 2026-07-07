// js/widgets/placeholders.js — honest v1.1 placeholder widgets.
// Owns: homeDef() (DOM · HOME ASSISTANT) + bambuDef() (DRUKARKA · BAMBU X1C)
// and async init(). Routing lives in clock.js (registered under 'home'/'bambu'
// so "pokaż dom" honestly shows the placeholder — ZERO fake data).
//
// Each placeholder body is centered dim mono copy: "WKRÓTCE — v1.1", one Edek
// line, and — if the bridge is offline — an extra "niedostępne bez mostu" line.
// No controls, grayed styling, nothing pretends to be connected.
//
// Contract honored:
//   - export async function init()
//   - export function homeDef(), export function bambuDef()
//   - render(bodyEl, ctx) needs no cleanup (static DOM, no timers/listeners).

import { defineWidget } from './widget-base.js';
import { bridgeClient } from '../bridge-client.js';

// Build the shared placeholder body. `edek` is the personality one-liner.
function placeholderBody(bodyEl, edek) {
  let bridgeOnline = false;
  try { bridgeOnline = bridgeClient.online(); } catch (_e) { bridgeOnline = false; }

  const noBridge = bridgeOnline
    ? ''
    : '<div class="ph-line ph-nobridge">niedostępne bez mostu</div>';

  bodyEl.innerHTML =
    '<div class="ph">' +
      '<div class="ph-soon">WKRÓTCE — v1.1</div>' +
      `<div class="ph-line ph-edek">${edek}</div>` +
      noBridge +
    '</div>';
  // Static content — no cleanup needed.
}

export function homeDef() {
  return defineWidget({
    id: 'home',
    title: 'DOM · HOME ASSISTANT',
    color: null, // grayed placeholder — strictly B&W, no accent
    size: 'md',
    render(bodyEl) {
      placeholderBody(bodyEl, 'Jeszcze nie podpięte, człowieku. Cierpliwości.');
    }
  });
}

export function bambuDef() {
  return defineWidget({
    id: 'bambu',
    title: 'DRUKARKA · BAMBU X1C',
    color: null,
    size: 'md',
    render(bodyEl) {
      placeholderBody(bodyEl, 'Jeszcze nie podpięte, człowieku. Cierpliwości.');
    }
  });
}

// Routing lives in clock.js; nothing to wire here.
export async function init() {
  // Idempotent no-op.
}
