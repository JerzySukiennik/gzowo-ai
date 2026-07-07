// js/ui/toasts.js — honest, transient notices + the one global voice hotkey.
// Salvaged from v1 hud.js: a queue of at most 3 stacked cards in #toast-layer,
// each auto-dismissed after 4s, flying in/out via transform+opacity only.
// Also owns the ONLY global hotkey left in v2: Space -> toggle voice.
//
// Self-contained: styles are injected here (css/hud.css is gone). Strictly B&W —
// every value comes from css/design-tokens.css. English code, PL copy from events.
// export async function init() — idempotent, never throws.

import { bus } from '../core/event-bus.js';

const MAX_TOASTS = 3;
const TOAST_TTL = 4000;    // auto-dismiss window
const OUT_MS = 320;        // fly-out duration before removal

let booted = false;
/** @type {{card: HTMLElement, timer: number}[]} */
let live = [];

// ---------------------------------------------------------------------------
// Injected stylesheet (once). Keeps this module standalone now that hud.css is
// deleted. Cards animate transform+opacity only.
// ---------------------------------------------------------------------------
const STYLE_ID = 'gz-toasts-style';
const CSS = `
#toast-layer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-4);
}
.gz-toast {
  pointer-events: none;
  max-width: min(420px, 92vw);
  padding: var(--space-3) var(--space-4);
  background: var(--bg-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--glass-radius-sm);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.4;
  letter-spacing: var(--tracking);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  box-shadow: var(--glass-shadow);
  opacity: 0;
  transform: translateY(12px);
  transition:
    transform var(--t-med) var(--ease-out),
    opacity var(--t-med) var(--ease-out);
  will-change: transform, opacity;
}
.gz-toast.gz-warn { border-color: var(--line-bright); }
.gz-toast.is-in  { opacity: 1; transform: translateY(0); }
.gz-toast.is-out { opacity: 0; transform: translateY(12px); }
@media (prefers-reduced-motion: reduce) {
  .gz-toast,
  .gz-toast.is-in,
  .gz-toast.is-out {
    transform: none;
    transition: opacity var(--t-fast) linear;
  }
}
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Toast queue.
// ---------------------------------------------------------------------------
function showToast({ text, kind = 'info' } = {}) {
  const layer = document.getElementById('toast-layer');
  if (!layer || !text) return;

  // Enforce the cap: drop the oldest immediately when full.
  while (live.length >= MAX_TOASTS) {
    const old = live.shift();
    if (old) dismiss(old, true);
  }

  const card = document.createElement('div');
  card.className = kind === 'warn' ? 'gz-toast gz-warn' : 'gz-toast';
  card.setAttribute('role', 'status');
  card.textContent = (kind === 'warn' ? '! ' : '') + text;
  layer.appendChild(card);

  // Fly in next frame.
  requestAnimationFrame(() => card.classList.add('is-in'));

  const entry = { card, timer: 0 };
  entry.timer = window.setTimeout(() => {
    live = live.filter((e) => e !== entry);
    dismiss(entry, false);
  }, TOAST_TTL);
  live.push(entry);
}

function dismiss(entry, immediate) {
  if (!entry || !entry.card) return;
  if (entry.timer) window.clearTimeout(entry.timer);
  const card = entry.card;
  if (immediate) {
    card.remove();
    return;
  }
  card.classList.remove('is-in');
  card.classList.add('is-out');
  window.setTimeout(() => card.remove(), OUT_MS);
}

// ---------------------------------------------------------------------------
// Global hotkey — Space toggles voice. The only hotkey in v2 (v1's T/C/Escape
// are gone: theme lives in Settings, the chat panel is a bubble, hiding widgets
// is assistant-only). Skipped while typing or with any modifier held.
// ---------------------------------------------------------------------------
function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

function onKeydown(e) {
  if (e.code !== 'Space') return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  if (isTyping(e.target)) return;
  e.preventDefault();
  bus.emit('voice:toggle', {});
}

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------
export async function init() {
  if (booted) return;
  booted = true;

  try {
    injectStyles();
  } catch (e) {
    console.error('[toasts] style injection failed', e);
  }

  bus.on('toast', showToast);
  window.addEventListener('keydown', onKeydown);

  console.info('[toasts] ready');
}
