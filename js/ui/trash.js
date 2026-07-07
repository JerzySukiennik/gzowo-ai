// js/ui/trash.js — the pop-up KOSZ (trash) icon, bottom-right.
//
// v2 point 3: the trash is ONLY visible while the assistant throws widgets away.
// It is NOT a button — pointer-events are never enabled and there is no click
// handler. It is purely an animation TARGET that the layout engine's
// fly-to-trash choreography aims at (#trash-corner, fixed by base.css).
//
// Lifecycle (driven by the event bus, never by the user):
//   'trash:throw' {count} -> pop in (spring), pulse each time (retrigger-safe)
//   'trash:done'  {}       -> after 250ms, retract (reverse)
// Overlapping throws are guarded by a counter (not a boolean), so a burst of
// individual removals keeps the can up until the LAST 'trash:done'.
//
// Motion law: transform + opacity ONLY (Web Animations API). We animate an
// INNER disc, never #trash-corner itself, so the engine's getBoundingClientRect
// on #trash-corner stays a stable fixed box. Respects prefers-reduced-motion.

import { bus } from '../core/event-bus.js';

const HOST_ID = 'trash-corner';
const RETRACT_DELAY_MS = 250;

// White line trash-can (stroke = currentColor => var(--fg); no fill).
const CAN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 7h16"/>' +
  '<path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>' +
  '<path d="M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7"/>' +
  '<path d="M10 11v6M14 11v6"/>' +
  '</svg>';

const REST = 'translateY(16px) scale(0.5)';
const SHOWN = 'translateY(0) scale(1)';

// Motion tokens (resolved in init with fallbacks).
const T = { med: 300, fast: 150, spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)', out: 'cubic-bezier(0.16, 1, 0.3, 1)' };

let inited = false;
let disc = null;         // the animated inner element (NOT #trash-corner)
let stateAnim = null;    // current pop-in / retract animation (fill: forwards)
let activeThrows = 0;    // overlapping-throw guard (counter)
let isUp = false;        // logical up/down state
let retractTimer = 0;

function reduced() {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function readMotion() {
  try {
    const cs = getComputedStyle(document.documentElement);
    const ms = (name, fb) => {
      const raw = cs.getPropertyValue(name).trim();
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : fb;
    };
    T.med = ms('--t-med', 300);
    T.fast = ms('--t-fast', 150);
    const spring = cs.getPropertyValue('--ease-spring').trim();
    const out = cs.getPropertyValue('--ease-out').trim();
    if (spring) T.spring = spring;
    if (out) T.out = out;
  } catch (_e) { /* keep fallbacks */ }
}

// Animate the disc up (spring, ~260ms) or down (reverse, --t-med). Reduced
// motion collapses to a plain opacity fade with no spring/scale.
function animateTo(up) {
  if (!disc) return;
  if (stateAnim) { try { stateAnim.cancel(); } catch (_e) { /* ignore */ } }

  if (reduced()) {
    stateAnim = disc.animate(
      [{ opacity: up ? 0 : 1, transform: 'none' },
       { opacity: up ? 1 : 0, transform: 'none' }],
      { duration: T.med, easing: 'linear', fill: 'forwards' }
    );
    return;
  }

  stateAnim = disc.animate(
    up
      ? [{ opacity: 0, transform: REST }, { opacity: 1, transform: SHOWN }]
      : [{ opacity: 1, transform: SHOWN }, { opacity: 0, transform: REST }],
    { duration: up ? 260 : T.med, easing: up ? T.spring : T.out, fill: 'forwards' }
  );
}

// Brief scale pulse layered on top of the (forwards-filled) shown state. No
// fill, so it reverts to SHOWN when done. Skipped under reduced motion.
function pulse() {
  if (!disc || reduced()) return;
  disc.animate(
    [{ transform: SHOWN }, { transform: 'translateY(0) scale(1.14)' }, { transform: SHOWN }],
    { duration: T.fast, easing: T.out }
  );
}

function onThrow() {
  if (!disc) return;
  activeThrows += 1;
  if (retractTimer) { clearTimeout(retractTimer); retractTimer = 0; }
  if (!isUp) {
    isUp = true;
    animateTo(true);
    // Let the spring settle, then pulse (so it does not fight the pop-in).
    if (!reduced() && stateAnim && stateAnim.finished) {
      stateAnim.finished.then(() => { if (isUp) pulse(); }).catch(() => {});
    }
  } else {
    // Already up — a fresh throw just pulses again (retrigger-safe).
    pulse();
  }
}

function onDone() {
  if (!disc) return;
  activeThrows = Math.max(0, activeThrows - 1);
  if (activeThrows > 0) return; // still throwing — stay up
  if (retractTimer) clearTimeout(retractTimer);
  retractTimer = window.setTimeout(() => {
    retractTimer = 0;
    if (activeThrows > 0) return; // a throw arrived during the delay
    isUp = false;
    animateTo(false);
  }, RETRACT_DELAY_MS);
}

export async function init() {
  if (inited) return;
  inited = true;

  const host = document.getElementById(HOST_ID);
  if (!host) {
    console.warn('[trash] #trash-corner missing — trash disabled');
    return;
  }

  readMotion();

  // Build the glass disc. It rests invisible (opacity 0, shrunk + nudged down)
  // via css/trash.css; it never receives pointer events.
  disc = document.createElement('div');
  disc.className = 'trash-disc glass';
  disc.setAttribute('aria-hidden', 'true');
  disc.innerHTML = CAN_SVG;
  host.appendChild(disc);

  bus.on('trash:throw', onThrow);
  bus.on('trash:done', onDone);

  console.info('[trash] ready');
}
