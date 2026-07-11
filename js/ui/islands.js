// js/ui/islands.js — the two floating liquid-glass pills, bottom-center: the
// ONLY chrome left in v2. GŁOS toggles the voice session; TRYBY opens an upward
// glass panel with WEJŚCIE/WYJŚCIE (głos|tekst) toggles that write state.mode.
//
// Strictly B&W (styling lives in css/islands.css). English code, PL copy.
// export async function init() — idempotent, never throws.

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';

let booted = false;
let panelOpen = false;

// Cached node handles.
const el = {};

// ---------------------------------------------------------------------------
// Tiny DOM helper.
// ---------------------------------------------------------------------------
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
// Build.
// ---------------------------------------------------------------------------
function build() {
  const root = document.getElementById('islands');
  if (!root) return false;
  root.innerHTML = '';

  // --- (1) GŁOS pill: reveal -> bob -> button ---
  const voiceReveal = h('div', 'island-reveal is-first');
  const voiceBob = h('div', 'island-bob');
  const voiceBtn = h('button', 'island island-voice glass', {
    type: 'button',
    'aria-label': 'Rozpocznij rozmowę'
  });
  const voiceLabel = h('span', 'island-label', { text: 'GŁOS' });
  voiceBtn.append(voiceLabel);
  voiceBtn.addEventListener('click', () => bus.emit('voice:toggle', {}));
  voiceBob.append(voiceBtn);
  voiceReveal.append(voiceBob);
  el.voiceBtn = voiceBtn;
  el.voiceLabel = voiceLabel;
  el.voiceReveal = voiceReveal;

  // v4 #12: with text INPUT the GŁOS pill is meaningless — hide the whole pill
  // while mode.input==='text'; it reappears the moment input flips back to voice.
  const syncVoicePill = (mode) => {
    voiceReveal.style.display = (mode && mode.input === 'text') ? 'none' : '';
  };
  state.subscribe('mode', syncVoicePill);
  syncVoicePill(state.get('mode'));

  // --- (2) TRYBY pill: reveal -> bob(=group) -> button + panel ---
  const modesReveal = h('div', 'island-reveal is-second');
  const group = h('div', 'island-bob island-group');
  const modesBtn = h('button', 'island island-modes glass', {
    type: 'button',
    'aria-haspopup': 'true',
    'aria-expanded': 'false',
    'aria-label': 'Tryby rozmowy'
  });
  modesBtn.append(h('span', 'island-label', { text: 'TRYBY' }));
  modesBtn.addEventListener('click', () => togglePanel());

  const panel = h('div', 'modes-panel glass', {
    'aria-label': 'Tryby rozmowy'
  });
  el.optionButtons = [];
  panel.append(buildRow('WEJŚCIE', 'input'));
  panel.append(buildRow('WYJŚCIE', 'output'));

  group.append(modesBtn, panel);
  modesReveal.append(group);
  el.group = group;
  el.modesBtn = modesBtn;
  el.panel = panel;

  root.append(voiceReveal, modesReveal);
  return true;
}

// One labelled option row (WEJŚCIE / WYJŚCIE) with GŁOS|TEKST toggles.
function buildRow(labelText, axis) {
  const row = h('div', 'modes-row', { role: 'group', 'aria-label': labelText });
  row.append(h('span', 'modes-row-label', { text: labelText }));

  const opts = h('div', 'modes-opts');
  for (const value of ['voice', 'text']) {
    const b = h('button', 'mode-opt', {
      type: 'button',
      'aria-pressed': 'false'
    });
    b.dataset.axis = axis;
    b.dataset.value = value;
    b.textContent = value === 'voice' ? 'GŁOS' : 'TEKST';
    b.addEventListener('click', () => pickOption(axis, value));
    el.optionButtons.push(b);
    opts.append(b);
  }
  row.append(opts);
  return row;
}

// ---------------------------------------------------------------------------
// Mode selection. Writes state.mode with the one changed axis; modes.js
// rebroadcasts it as 'mode:change' — we deliberately never emit that here.
// Panel stays open so the user can set both axes in one pass.
// ---------------------------------------------------------------------------
function pickOption(axis, value) {
  const cur = state.get('mode') || { input: 'voice', output: 'voice' };
  if (cur[axis] === value) return; // no-op, avoids a redundant state write
  const next = { input: cur.input, output: cur.output };
  next[axis] = value;
  state.set('mode', next);
}

function renderModes(mode) {
  const cur = mode || state.get('mode') || { input: 'voice', output: 'voice' };
  for (const b of el.optionButtons || []) {
    const active = cur[b.dataset.axis] === b.dataset.value;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

// ---------------------------------------------------------------------------
// GŁOS label + state. Mirrors voiceStatus / 'voice:session':
//   connecting -> 'ŁĄCZĘ…' (dimmed)
//   open       -> 'STOP' (+ live pulse)
//   else       -> 'GŁOS'
// ---------------------------------------------------------------------------
function renderVoice(status) {
  const s = status || 'off';
  const connecting = s === 'connecting';
  const live = s === 'open';
  const label = connecting ? 'ŁĄCZĘ…' : live ? 'STOP' : 'GŁOS';

  if (el.voiceLabel) el.voiceLabel.textContent = label;
  if (el.voiceBtn) {
    el.voiceBtn.classList.toggle('is-connecting', connecting);
    el.voiceBtn.classList.toggle('is-live', live);
    el.voiceBtn.setAttribute('aria-pressed', live ? 'true' : 'false');
    el.voiceBtn.setAttribute(
      'aria-label',
      live ? 'Zatrzymaj rozmowę' : 'Rozpocznij rozmowę'
    );
  }
}

// ---------------------------------------------------------------------------
// TRYBY panel open/close. Collapse on outside pointerdown, ESC, or TRYBY again.
// (Never on an option pick.)
// ---------------------------------------------------------------------------
function togglePanel() {
  if (panelOpen) closePanel();
  else openPanel();
}

function openPanel() {
  if (panelOpen || !el.panel) return;
  panelOpen = true;
  el.panel.classList.add('is-open');
  if (el.modesBtn) el.modesBtn.setAttribute('aria-expanded', 'true');
  // Capture phase so we see the press before the target's own handlers.
  document.addEventListener('pointerdown', onOutsidePointer, true);
  document.addEventListener('keydown', onPanelKeydown, true);
}

function closePanel() {
  if (!panelOpen || !el.panel) return;
  panelOpen = false;
  el.panel.classList.remove('is-open');
  if (el.modesBtn) el.modesBtn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onOutsidePointer, true);
  document.removeEventListener('keydown', onPanelKeydown, true);
}

function onOutsidePointer(e) {
  // Presses inside the TRYBY group (button or panel) are handled locally:
  // the button toggles, options pick — neither should trigger outside-close.
  if (el.group && el.group.contains(e.target)) return;
  closePanel();
}

function onPanelKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closePanel();
    if (el.modesBtn) el.modesBtn.focus();
  }
}

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------
export async function init() {
  if (booted) return;
  booted = true;

  try {
    if (!build()) {
      console.warn('[islands] #islands container missing — skipping');
      return;
    }
  } catch (e) {
    console.error('[islands] build failed', e);
    return;
  }

  // Paint from current state (covers late init after voice/mode already moved).
  renderVoice(state.get('voiceStatus'));
  renderModes(state.get('mode'));

  // Live wiring. 'voice:session' is the primary signal; the state subscription
  // is a harmless backstop (render is idempotent).
  bus.on('voice:session', (p) => renderVoice(p && p.status));
  state.subscribe('voiceStatus', (v) => renderVoice(v));
  state.subscribe('mode', (v) => renderModes(v));

  console.info('[islands] ready');
}
