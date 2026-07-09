// js/ui/chat.js — Gzowo AI v2 chat bubble.
// -----------------------------------------------------------------------------
// A floating glass SPEECH BUBBLE anchored beside the 2D avatar. It reserves NO
// layout space (explicit v2 exemption from the reservation rule — it overlays
// widgets and is allowed to visually overlap thanks to the glass blur). The old
// v1 right-side chat panel + its layout reservation are DEAD; zero reservation
// calls here — the bubble floats and reserves nothing.
//
// Responsibilities:
//   • Visible iff (mode.input==='text' OR mode.output==='text') AND ui in
//     {idle,talking,showing}. Hidden in pure voice↔voice and during auth/startup.
//   • Position purely via transform next to the avatar (from 'avatar:slot'),
//     clamped to the viewport; falls below the avatar when the right is too tight.
//   • Stream 'voice:transcript' — partials update the current line in place per
//     role, finals commit (the v1 streaming semantics, kept). A bubble shows only
//     the LATEST assistant turn (history lives in Firestore transcripts), so a new
//     gzowo turn replaces the previous one with a quick opacity dip.
//   • Input row (mode.input==='text' only) emits 'chat:send' {text}.
//
// Strictly B&W (design-tokens). Animate transform/opacity only. init() never throws.

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';

let booted = false;

// DOM handles (filled by build()).
let root = null;         // #chat-bubble (the fixed, transform-positioned anchor)
let el = {};             // { card, user, userText, body, gzowo, caret, form, input }

// Latest avatar slot {cx,cy,r} in px, or null until the layout emits one.
let slot = null;

// Manual placement (drag): once Jurek drags the bubble, {x,y} wins over the
// avatar anchor for the rest of the session (still clamped to the viewport).
let manual = null;
let lastPos = { x: 0, y: 0 };   // last committed translate (drag base)
let dragState = null;           // {startX, startY, baseX, baseY, moved}

// Visibility + hide-transition bookkeeping.
let visible = false;
let hideTimer = 0;
let resizeTimer = 0;
let lastInputWanted = false;

// Conversation model — the single source of truth for what the bubble shows.
// We ALWAYS keep this current (even while hidden) so a mode flip mid-stream can
// render the in-flight partial; DOM is only touched while visible (no churn).
const model = { userText: '', gzowoText: '', streaming: false };

// Resolved token values (refreshed on resize — mobile media query changes them).
const T = { offset: 24, space5: 24, clearance: 112 };
const MOTION = { tFast: 150, tMed: 300, easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)' };

// Minimum free px on the right before we drop the bubble BELOW the avatar.
const RIGHT_MIN = 260;
// Avatar-radius multiplier for the gap between avatar edge and bubble anchor.
const R_FACTOR = 1.15;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function cel(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

function reducedMotion() {
  return typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const num = (name, fallback) => {
    const n = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(n) ? n : fallback;
  };
  T.offset = num('--bubble-offset', 24);
  T.space5 = num('--space-5', 24);
  T.clearance = num('--islands-clearance', 112);
  MOTION.tFast = num('--t-fast', 150);
  MOTION.tMed = num('--t-med', 300);
  const eo = cs.getPropertyValue('--ease-out').trim();
  if (eo) MOTION.easeOut = eo;
}

// -----------------------------------------------------------------------------
// DOM
// -----------------------------------------------------------------------------
function build() {
  root = document.getElementById('chat-bubble');
  if (!root) return false;
  root.replaceChildren();
  root.dataset.side = 'right';

  const card = cel('div', 'chat-card glass');

  // (0) drag grip — slim affordance strip; the whole card drags too (except the
  // input row, buttons and the selectable transcript).
  const grip = cel('div', 'chat-grip');
  grip.title = 'Przeciągnij';
  grip.setAttribute('aria-hidden', 'true');
  card.appendChild(grip);

  // (a) optional last-user line — one line, dim, 'TY >' prefix, ellipsis.
  const user = cel('div', 'chat-user');
  user.hidden = true;
  const userPrefix = cel('span', 'chat-user-prefix');
  userPrefix.textContent = 'TY > ';
  const userText = cel('span', 'chat-user-text');
  user.append(userPrefix, userText);

  // (b) assistant transcript — the streaming gzowo text + a blinking caret.
  const body = cel('div', 'chat-body');
  body.setAttribute('role', 'log');
  body.setAttribute('aria-live', 'polite');
  const gzowo = cel('span', 'chat-gzowo');
  const caret = cel('span', 'chat-caret');
  caret.textContent = '▮';
  caret.setAttribute('aria-hidden', 'true');
  body.append(gzowo, caret);

  // (c) input row — only meaningful when mode.input==='text' (toggled in sync).
  const form = cel('form', 'chat-form');
  const input = cel('input', 'chat-input');
  input.type = 'text';
  input.placeholder = 'Napisz do Gzowo…';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', 'Wiadomość do Gzowo');
  const submit = cel('button', 'chat-submit');
  submit.type = 'submit';
  submit.textContent = 'WYŚLIJ';
  form.append(input, submit);

  card.append(user, body, form);
  root.append(card);

  el = { card, user, userText, body, gzowo, caret, form, input };
  form.addEventListener('submit', onSubmit);

  // --- Drag (pointer events; manual position wins from the first real move) ---
  card.addEventListener('pointerdown', onDragStart);
  card.addEventListener('pointermove', onDragMove);
  card.addEventListener('pointerup', onDragEnd);
  card.addEventListener('pointercancel', onDragEnd);

  // --- Resize: native CSS resize handle changes the card box; re-clamp the
  // bubble so the grown card never sticks off-screen. (liquid-glass has its own
  // ResizeObserver and refreshes the refraction map itself.) ---
  try {
    const ro = new ResizeObserver(() => {
      // Inline width/height = the native handle was used → lift the size caps.
      if (card.style.width || card.style.height) card.classList.add('is-resized');
      if (visible) position();
    });
    ro.observe(card);
  } catch (_e) { /* very old engines: resize still works, minus the re-clamp */ }
  return true;
}

// -----------------------------------------------------------------------------
// Dragging — from the grip or any non-interactive part of the card.
// -----------------------------------------------------------------------------
function dragExcluded(target) {
  return !!(target && target.closest &&
    target.closest('input, button, .chat-body'));
}

function onDragStart(e) {
  if (!e.isPrimary || dragExcluded(e.target)) return;
  // Native resize corner (bottom-right ~18px) must keep working — don't hijack it.
  const r = el.card.getBoundingClientRect();
  if (e.clientX > r.right - 20 && e.clientY > r.bottom - 20) return;
  dragState = { startX: e.clientX, startY: e.clientY, baseX: lastPos.x, baseY: lastPos.y, moved: false };
  try { el.card.setPointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
}

function onDragMove(e) {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  if (!dragState.moved && Math.abs(dx) + Math.abs(dy) < 4) return; // click, not drag
  if (!dragState.moved) root.classList.add('is-dragging');         // 1:1, no glide
  dragState.moved = true;
  manual = { x: dragState.baseX + dx, y: dragState.baseY + dy };
  position();
  e.preventDefault();
}

function onDragEnd(e) {
  if (!dragState) return;
  try { el.card.releasePointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
  dragState = null;
  root.classList.remove('is-dragging');
}

// -----------------------------------------------------------------------------
// Rendering (model -> DOM). Only ever called while visible.
// -----------------------------------------------------------------------------
function renderUser() {
  if (!el.user) return;
  const has = !!model.userText;
  el.user.hidden = !has;
  if (has) el.userText.textContent = model.userText;
}

function setGzowo(text) {
  if (el.gzowo) el.gzowo.textContent = text || '';
}

function setCaret(on) {
  if (el.caret) el.caret.classList.toggle('blink', !!on);
}

function scrollBody() {
  if (el.body) el.body.scrollTop = el.body.scrollHeight;
}

// Quick opacity dip on the assistant text — marks a new turn replacing the old.
function dip() {
  if (reducedMotion() || !el.body) return;
  try {
    el.body.animate(
      [{ opacity: 0.15 }, { opacity: 1 }],
      { duration: MOTION.tFast, easing: MOTION.easeOut }
    );
  } catch (_e) { /* WAAPI unavailable — no-op */ }
}

// Fill the whole bubble from the model (used on show — no dip).
function renderAll() {
  renderUser();
  setGzowo(model.gzowoText);
  setCaret(model.streaming);
  scrollBody();
}

// -----------------------------------------------------------------------------
// Transcript streaming — v1 semantics: partials replace the current line in
// place per role, finals commit. A new gzowo turn replaces the previous one.
// -----------------------------------------------------------------------------
function onTranscript(p) {
  if (!p || !p.role) return;
  const text = p.text || '';
  const final = !!p.final;

  if (p.role === 'user') {
    model.userText = text;
    if (visible) renderUser();
    return;
  }

  // gzowo: if we were not mid-stream, this begins a fresh turn (replace + dip).
  const newTurn = !model.streaming;
  model.gzowoText = text;
  model.streaming = !final;

  if (visible) {
    setGzowo(text);
    if (newTurn) dip();
    setCaret(model.streaming);
    scrollBody();
  }
}

// -----------------------------------------------------------------------------
// Send (text input row)
// -----------------------------------------------------------------------------
function onSubmit(e) {
  e.preventDefault();
  if (!el.input) return;
  const text = el.input.value.trim();
  if (!text) return;
  model.userText = text;
  if (visible) renderUser();
  bus.emit('chat:send', { text });
  el.input.value = '';
  try { el.input.focus(); } catch (_e) { /* ignore */ }
  // The user line may have appeared/changed height → keep it clamped in view.
  position();
}

// -----------------------------------------------------------------------------
// Input-row gating (mode.input==='text')
// -----------------------------------------------------------------------------
function inputWanted() {
  const m = state.get('mode') || {};
  return m.input === 'text';
}

function syncInputRow() {
  if (!el.form) return;
  const want = inputWanted();
  el.form.hidden = !want;
  // Focus the field the moment it becomes available for typing.
  if (want && !lastInputWanted && visible) {
    requestAnimationFrame(() => { try { el.input.focus(); } catch (_e) { /* ignore */ } });
  }
  lastInputWanted = want;
}

// -----------------------------------------------------------------------------
// Positioning — transform-only so the bubble glides as the avatar moves.
// -----------------------------------------------------------------------------
function position() {
  if (!root || root.hidden) return;
  const w = root.offsetWidth;
  const h = root.offsetHeight;
  if (!w || !h) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let x;
  let y;
  let side;

  if (manual) {
    // Dragged by Jurek: his spot wins for the session; only the clamp applies.
    side = root.dataset.side || 'right';
    x = manual.x;
    y = manual.y;
  } else if (slot) {
    const rightX = slot.cx + slot.r * R_FACTOR + T.offset;
    const roomRight = vw - T.space5 - rightX - w;
    if (roomRight >= 0 && (vw - T.space5 - rightX) >= RIGHT_MIN) {
      // Default anchor: left edge beside the avatar, vertically centered on cy.
      side = 'right';
      x = rightX;
      y = slot.cy - h / 2;
    } else {
      // Too tight on the right → drop below, horizontally centered on cx.
      side = 'below';
      x = slot.cx - w / 2;
      y = slot.cy + slot.r * R_FACTOR + T.offset;
    }
  } else {
    // No avatar slot ever arrived (layout failed) → bottom-center above islands.
    side = 'below';
    x = (vw - w) / 2;
    y = vh - T.clearance - h;
  }

  // Clamp inside the viewport safe area (right edge, top, bottom-above-islands).
  x = Math.max(T.space5, Math.min(x, vw - T.space5 - w));
  y = Math.max(T.space5, Math.min(y, vh - T.clearance - h));

  lastPos = { x, y };   // drag base for the next pointerdown
  root.dataset.side = side;
  root.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

// -----------------------------------------------------------------------------
// Show / hide — --t-med scale+opacity transition, then toggle [hidden].
// -----------------------------------------------------------------------------
function show() {
  if (visible) {
    // Already open — just keep the input row + placement honest (e.g. mode tick).
    syncInputRow();
    position();
    return;
  }
  visible = true;
  clearTimeout(hideTimer);
  syncInputRow();
  root.hidden = false;      // make it measurable/animatable
  renderAll();              // fill from the model (catches any in-flight partial)
  position();               // measure + place while still scaled-out (no glide)
  requestAnimationFrame(() => { root.classList.add('is-shown'); });
  if (!el.form.hidden && el.input) {
    requestAnimationFrame(() => { try { el.input.focus(); } catch (_e) { /* ignore */ } });
  }
}

function hide() {
  if (!visible) return;
  visible = false;
  root.classList.remove('is-shown');
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (!visible && root) root.hidden = true;
  }, MOTION.tMed + 40);
}

// Re-evaluate the visibility rule against mode + ui.
function evaluate() {
  const mode = state.get('mode') || {};
  const wantText = mode.input === 'text' || mode.output === 'text';
  const ui = state.ui;
  const live = ui === 'idle' || ui === 'talking' || ui === 'showing';
  if (wantText && live) show();
  else hide();
}

// -----------------------------------------------------------------------------
// Events in
// -----------------------------------------------------------------------------
function onSlot(p) {
  if (!p) return;
  slot = { cx: p.cx, cy: p.cy, r: p.r };
  if (visible) position();
}

function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    readTokens();
    if (visible) position();
  }, 100);
}

// -----------------------------------------------------------------------------
// init()
// -----------------------------------------------------------------------------
export async function init() {
  if (booted) return;
  booted = true;

  try {
    if (!build()) {
      console.warn('[chat] #chat-bubble missing — bubble disabled');
      return;
    }
  } catch (e) {
    console.error('[chat] build failed', e);
    bus.emit('toast', { text: 'Dymek czatu nie wstał — działam bez niego.', kind: 'warn' });
    return;
  }

  readTokens();

  bus.on('voice:transcript', onTranscript);
  bus.on('avatar:slot', onSlot);

  // Visibility triggers.
  state.subscribe('mode', evaluate);
  bus.on('mode:change', evaluate);
  bus.on('state:change', evaluate);

  window.addEventListener('resize', onResize, { passive: true });

  // Initial pass (stays hidden during auth/startup, or in pure voice mode).
  evaluate();

  console.info('[chat] ready');
}
