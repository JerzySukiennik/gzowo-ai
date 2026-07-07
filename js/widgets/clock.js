// js/widgets/clock.js — ZEGAR widget (pure B&W showcase, NO color).
//
// v2: this is ONLY the clock widget now. The shared tool/request router that
// used to live here moved to js/widgets/widget-tools.js (the assistant-only
// control surface). This module imports nothing but widget-base.js — in
// particular it no longer touches layout/memory/bus/state or the deleted
// placeholders.js, so it can never crash the boot on a missing sibling.
//
// Contract honored:
//   - export function clockDef()
//   - render(bodyEl, ctx) returns a cleanup fn (clears the 1s interval).
//   - export async function init()  (idempotent no-op; see widget-tools.js).

import { defineWidget } from './widget-base.js';

// ---------------------------------------------------------------------------
// CLOCK WIDGET
// ---------------------------------------------------------------------------
// Weekday on its own so we can join with ' · ' (spec wants a middle dot, not the
// locale's default comma): 'wtorek · 7 lipca 2026'.
const PL_WEEKDAY_FMT = new Intl.DateTimeFormat('pl-PL', { weekday: 'long' });
const PL_REST_FMT = new Intl.DateTimeFormat('pl-PL', {
  day: 'numeric', month: 'long', year: 'numeric'
});
function formatPlDate(d) {
  return `${PL_WEEKDAY_FMT.format(d)} · ${PL_REST_FMT.format(d)}`;
}

export function clockDef() {
  return defineWidget({
    id: 'clock',
    title: 'ZEGAR',
    color: null, // ZEGAR is the pure black-and-white showcase — no accent.
    size: 'md',
    render(bodyEl) {
      let alive = true;
      let timer = null;
      let blinkOn = true;

      bodyEl.innerHTML =
        '<div class="clk">' +
          '<div class="clk-time">' +
            '<span data-role="h">00</span>' +
            '<span class="clk-sep" data-role="s1">:</span>' +
            '<span data-role="m">00</span>' +
            '<span class="clk-sep" data-role="s2">:</span>' +
            '<span data-role="s">00</span>' +
          '</div>' +
          '<div class="clk-date" data-role="date">&nbsp;</div>' +
        '</div>';

      const hEl = bodyEl.querySelector('[data-role="h"]');
      const mEl = bodyEl.querySelector('[data-role="m"]');
      const sEl = bodyEl.querySelector('[data-role="s"]');
      const sep1 = bodyEl.querySelector('[data-role="s1"]');
      const sep2 = bodyEl.querySelector('[data-role="s2"]');
      const dateEl = bodyEl.querySelector('[data-role="date"]');

      function pad(n) { return String(n).padStart(2, '0'); }

      function paint() {
        if (!alive) return;
        const now = new Date();
        hEl.textContent = pad(now.getHours());
        mEl.textContent = pad(now.getMinutes());
        sEl.textContent = pad(now.getSeconds());
        // blink the two ':' at 1 Hz via opacity (no layout thrash)
        blinkOn = !blinkOn;
        const op = blinkOn ? '1' : '0.25';
        sep1.style.opacity = op;
        sep2.style.opacity = op;
        dateEl.textContent = formatPlDate(now);
      }

      // Align the first tick to the next second boundary, then run every 1000ms.
      paint();
      const msToNextSecond = 1000 - (Date.now() % 1000);
      let boundaryTimeout = setTimeout(() => {
        if (!alive) return;
        paint();
        timer = setInterval(paint, 1000);
      }, msToNextSecond);

      return () => {
        alive = false;
        if (boundaryTimeout) clearTimeout(boundaryTimeout);
        if (timer) clearInterval(timer);
      };
    }
  });
}

// Routing + tool registration live in js/widgets/widget-tools.js now.
export async function init() {
  // Idempotent no-op.
}
