// js/ui/chat.js — Gzowo chat panel (right side). Transcript list that streams
// partial voice transcripts, an input row that emits 'chat:send', and a
// visibility rule that reflows the layout via layout.setReservedRight so
// nothing ever overlaps (Prawo ruchu). Strictly B&W.
//
// export async function init()  — idempotent, never throws.

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';
import { layout } from '../core/layout-engine.js';

let booted = false;

let el = {};
// Track the last streaming (non-final) entry per role so partials update in
// place instead of appending a new line each frame.
let streaming = { user: null, gzowo: null };

function h(tag, cls, attrs = {}) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Build the panel DOM.
// ---------------------------------------------------------------------------
function build() {
  const panel = document.getElementById('chat-panel');
  if (!panel) return;
  panel.innerHTML = '';

  const header = h('div', 'chat-head');
  header.append(h('span', 'chat-head-title', { text: 'ROZMOWA' }));
  panel.append(header);

  const list = h('div', 'chat-list', { role: 'log', 'aria-live': 'polite' });
  panel.append(list);
  el.list = list;

  const row = h('form', 'chat-input-row');
  const input = h('input', 'chat-input', {
    type: 'text',
    placeholder: 'Pisz do Gzowo…',
    autocomplete: 'off',
    'aria-label': 'Wiadomość do Gzowo'
  });
  const send = h('button', 'chat-send', { type: 'submit', text: 'WYŚLIJ' });
  row.append(input, send);
  panel.append(row);
  el.input = input;

  row.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
}

// Append a transcript line. role: 'user' | 'gzowo'.
function appendLine(role, text) {
  if (!el.list) return null;
  const line = h('div', `chat-line chat-${role}`);
  const prefix = h('span', 'chat-prefix', { text: role === 'user' ? 'TY >' : 'GZOWO >' });
  const body = h('span', 'chat-text');
  body.textContent = text || '';
  line.append(prefix, body);
  el.list.append(line);
  autoscroll();
  return { line, body };
}

function autoscroll() {
  if (!el.list) return;
  el.list.scrollTop = el.list.scrollHeight;
}

// ---------------------------------------------------------------------------
// Send text (local echo + bus).
// ---------------------------------------------------------------------------
function submit() {
  if (!el.input) return;
  const text = el.input.value.trim();
  if (!text) return;
  appendLine('user', text);
  bus.emit('chat:send', { text });
  el.input.value = '';
}

// ---------------------------------------------------------------------------
// Streaming transcripts. Partial (final:false) updates the current streaming
// line for that role; final commits and clears the streaming handle.
// ---------------------------------------------------------------------------
function onTranscript(p) {
  if (!p || !p.role) return;
  const role = p.role === 'user' ? 'user' : 'gzowo';
  const text = p.text || '';

  let entry = streaming[role];
  if (!entry) {
    entry = appendLine(role, text);
    streaming[role] = entry;
  } else {
    entry.body.textContent = text;
    autoscroll();
  }

  if (p.final) {
    streaming[role] = null;
  }
}

// ---------------------------------------------------------------------------
// Visibility. Open when mode.input==='text' OR mode.output==='text' OR the
// user forced it via chatOpen (hotkey C). Slides via CSS class; on every
// show/hide we tell the layout engine how many px to reserve on the right so
// widgets reflow and never overlap the panel.
// ---------------------------------------------------------------------------
function shouldBeOpen() {
  if (state.ui === 'intro') return false; // stay hidden during intro
  if (state.get('chatOpen')) return true;
  const mode = state.get('mode') || {};
  return mode.input === 'text' || mode.output === 'text';
}

// Read the numeric px width of --chat-w from computed styles (respects the
// mobile 100vw override). Returns an integer px value.
function chatWidthPx() {
  const panel = document.getElementById('chat-panel');
  if (!panel) return 0;
  // Prefer the resolved layout width; fall back to the token.
  const rect = panel.getBoundingClientRect();
  if (rect.width) return Math.round(rect.width);
  const cs = getComputedStyle(document.documentElement).getPropertyValue('--chat-w').trim();
  const n = parseFloat(cs);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

// Is the panel in mobile full-width overlay mode? In overlay mode the chat
// covers the screen (modal, above widgets) and we must NOT reserve space —
// otherwise the field would collapse to nothing.
function isOverlayMode() {
  return window.matchMedia('(max-width: 720px)').matches;
}

let visible = false;

function applyVisibility() {
  const panel = document.getElementById('chat-panel');
  if (!panel) return;
  const open = shouldBeOpen();
  if (open === visible) {
    // Even if the flag is unchanged, keep body/overlay class in sync (e.g. on
    // a viewport resize that flips overlay mode).
    syncOverlayClass(open);
    return;
  }
  visible = open;

  if (open) {
    panel.hidden = false;
    // next frame -> slide in
    requestAnimationFrame(() => panel.classList.add('is-open'));
    syncOverlayClass(true);
    // Desktop reserves real estate; mobile overlay reserves nothing (modal).
    layout.setReservedRight(isOverlayMode() ? 0 : chatWidthPx());
    // focus the field for immediate typing when user-invoked
    if (el.input) requestAnimationFrame(() => el.input.focus());
  } else {
    panel.classList.remove('is-open');
    syncOverlayClass(false);
    layout.setReservedRight(0);
    // hide after the slide-out transition so it can't catch clicks
    window.setTimeout(() => {
      if (!visible) panel.hidden = true;
    }, 320);
  }
}

function syncOverlayClass(open) {
  const overlay = open && isOverlayMode();
  document.body.classList.toggle('chat-overlay', overlay);
}

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------
export async function init() {
  if (booted) return;
  booted = true;

  try {
    build();
  } catch (e) {
    console.error('[chat] build failed', e);
    bus.emit('toast', { text: 'Panel czatu nie wstał — działam bez niego.', kind: 'warn' });
    return;
  }

  bus.on('voice:transcript', onTranscript);

  // Visibility triggers.
  state.subscribe('mode', applyVisibility);
  state.subscribe('chatOpen', applyVisibility);
  bus.on('state:change', applyVisibility); // leaves intro -> may reveal
  bus.on('mode:change', applyVisibility);

  // Keep reserved width honest across viewport changes (overlay flip, resize).
  window.addEventListener('resize', () => {
    if (!visible) return;
    syncOverlayClass(true);
    layout.setReservedRight(isOverlayMode() ? 0 : chatWidthPx());
  });

  // Initial state (stays hidden during intro).
  applyVisibility();

  console.info('[chat] ready');
}
