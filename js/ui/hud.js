// js/ui/hud.js — Gzowo HUD chrome: top bar, dock, mode matrix, trash target,
// toasts, and global hotkeys. Strictly B&W (token grays only). Honest states:
// every indicator reflects a real event, nothing is faked.
//
// export async function init()  — idempotent, never throws.

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';

let booted = false;

// Live-state label copy per UI state (Edek-terse UPPERCASE).
const STATE_LABEL = {
  intro: 'BOOT',
  idle: 'IDLE',
  talking: 'TALKING',
  showing: 'SHOWING'
};

// Mode matrix definition: 4 segmented input->output toggles.
const MODES = [
  { input: 'voice', output: 'voice', label: 'GŁOS→GŁOS' },
  { input: 'voice', output: 'text', label: 'GŁOS→TEKST' },
  { input: 'text', output: 'voice', label: 'TEKST→GŁOS' },
  { input: 'text', output: 'text', label: 'TEKST→TEKST' }
];

// Widget quick-add buttons.
const QUICK_ADDS = [
  { name: 'weather', label: 'POGODA' },
  { name: 'clock', label: 'ZEGAR' },
  { name: 'timer', label: 'TIMER' },
  { name: 'projects', label: 'PROJEKTY' }
];

// Cached element handles.
let el = {};

// ---------------------------------------------------------------------------
// Small DOM helpers.
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

function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

// ---------------------------------------------------------------------------
// TOP BAR
// ---------------------------------------------------------------------------
function buildTopBar() {
  const bar = document.getElementById('hud-top');
  if (!bar) return;
  bar.innerHTML = '';

  // Left: wordmark + version.
  const left = h('div', 'hud-left');
  const mark = h('span', 'hud-wordmark', { text: 'GZOWO' });
  const ver = h('span', 'hud-version', { text: 'v1' });
  left.append(mark, ver);

  // Center: live state label.
  const center = h('div', 'hud-center');
  const stateLabel = h('span', 'hud-state', { 'aria-live': 'polite' });
  stateLabel.textContent = `STAN: ${STATE_LABEL[state.ui] || 'IDLE'}`;
  center.append(stateLabel);
  el.stateLabel = stateLabel;

  // Right: indicator cluster.
  const right = h('div', 'hud-right');

  // Bridge indicator.
  const bridge = h('span', 'hud-ind hud-bridge', { role: 'status' });
  right.append(bridge);
  el.bridge = bridge;

  // Wake toggle (click toggles state.wakeEnabled). Gated on real capability:
  // wakeAvailable flips true only once the Vosk wake-word model has loaded (served
  // by the bridge). Until then the toggle must NOT flip to a lying "WAKE ON".
  const wake = h('button', 'hud-ind hud-wake', { type: 'button', title: 'Nasłuch słowa-klucza' });
  wake.addEventListener('click', () => {
    if (!state.get('wakeAvailable')) {
      bus.emit('toast', {
        text: 'Nasłuch jeszcze niedostępny — model „Hej Gzowo" się ładuje albo nie ma mostu. Daj chwilę / odśwież na localhost:8787, człowieku.',
        kind: 'warn'
      });
      return;
    }
    state.set('wakeEnabled', !state.get('wakeEnabled'));
  });
  right.append(wake);
  el.wake = wake;

  // Mic-privacy dot (pulses while a voice session is open).
  const mic = h('span', 'hud-ind hud-mic', { title: 'Prywatność mikrofonu' });
  const micDot = h('span', 'hud-mic-dot');
  const micLabel = h('span', 'hud-mic-label', { text: 'MIK' });
  mic.append(micDot, micLabel);
  right.append(mic);
  el.mic = mic;

  // Demo badge.
  const demo = h('span', 'hud-ind hud-demo', { text: 'DEMO' });
  right.append(demo);
  el.demo = demo;

  bar.append(left, center, right);

  renderBridge(state.get('bridgeOnline'));
  renderWake(state.get('wakeEnabled'));
  renderDemo(state.get('demo'));
}

function renderBridge(online) {
  if (!el.bridge) return;
  el.bridge.textContent = online ? '● MOST' : '○ MOST OFF';
  el.bridge.classList.toggle('is-off', !online);
}

function renderWake(on) {
  if (!el.wake) return;
  // If wake isn't available, the indicator is honestly OFF regardless of the
  // persisted preference — nothing is listening.
  const available = !!state.get('wakeAvailable');
  const effective = available && !!on;
  el.wake.textContent = effective ? 'WAKE ON' : 'WAKE OFF · NIE SŁUCHAM';
  el.wake.classList.toggle('is-off', !effective);
  el.wake.classList.toggle('is-unavailable', !available);
  el.wake.setAttribute('aria-pressed', effective ? 'true' : 'false');
  el.wake.setAttribute('aria-disabled', available ? 'false' : 'true');
}

function renderMic(sessionOpen) {
  if (!el.mic) return;
  el.mic.classList.toggle('is-live', sessionOpen);
}

function renderDemo(isDemo) {
  if (!el.demo) return;
  el.demo.hidden = !isDemo;
}

// Blip the state label opacity on change (--t-fast), then update text.
function updateStateLabel() {
  if (!el.stateLabel) return;
  el.stateLabel.classList.add('is-blip');
  el.stateLabel.textContent = `STAN: ${STATE_LABEL[state.ui] || 'IDLE'}`;
  // remove the class after the fast transition so it can retrigger next time
  window.setTimeout(() => el.stateLabel && el.stateLabel.classList.remove('is-blip'), 160);
}

// ---------------------------------------------------------------------------
// DOCK
// ---------------------------------------------------------------------------
function buildDock() {
  const dock = document.getElementById('dock');
  if (!dock) return;
  dock.innerHTML = '';

  // --- Mic / voice-session button ---
  const micBtn = h('button', 'dock-btn dock-voice', { type: 'button' });
  micBtn.textContent = '◉ GŁOS';
  micBtn.addEventListener('click', () => bus.emit('voice:toggle', {}));
  el.voiceBtn = micBtn;

  // --- Mode matrix ---
  const matrix = h('div', 'dock-group dock-modes', { role: 'group', 'aria-label': 'Tryb rozmowy' });
  el.modeBtns = [];
  for (const m of MODES) {
    const b = h('button', 'dock-btn dock-mode', { type: 'button', 'data-input': m.input, 'data-output': m.output });
    b.textContent = `[${m.label}]`;
    b.addEventListener('click', () => {
      state.set('mode', { input: m.input, output: m.output });
      bus.emit('mode:change', { input: m.input, output: m.output });
    });
    el.modeBtns.push(b);
    matrix.append(b);
  }

  // --- Widget quick-adds ---
  const adds = h('div', 'dock-group dock-adds', { role: 'group', 'aria-label': 'Dodaj widget' });
  // Collapsed-mode trigger (mobile) — a leading pseudo-label; CSS decides layout.
  const addsLabel = h('span', 'dock-adds-label', { text: '[+ WIDGET]' });
  adds.append(addsLabel);
  for (const w of QUICK_ADDS) {
    const b = h('button', 'dock-btn dock-add', { type: 'button', 'data-widget': w.name });
    b.textContent = w.label;
    b.addEventListener('click', () => bus.emit('widget:request', { name: w.name }));
    adds.append(b);
  }

  // --- Theme toggle ---
  const themeBtn = h('button', 'dock-btn dock-theme', { type: 'button' });
  themeBtn.addEventListener('click', toggleTheme);
  el.themeBtn = themeBtn;

  // --- Sound toggle ---
  const soundBtn = h('button', 'dock-btn dock-sound', { type: 'button' });
  soundBtn.addEventListener('click', () => state.set('muted', !state.get('muted')));
  el.soundBtn = soundBtn;

  // --- Trash target (layout engine's fly-to anchor; keep in DOM always) ---
  const trash = h('div', 'dock-trash', { id: 'trash-target', 'aria-label': 'Kosz' });
  const trashIcon = h('span', 'dock-trash-icon', { text: '⌫' });
  const trashLabel = h('span', 'dock-trash-label', { text: 'KOSZ' });
  trash.append(trashIcon, trashLabel);
  el.trash = trash;

  // Left cluster (voice + modes + adds), spacer, right cluster (theme/sound/trash).
  const leftCluster = h('div', 'dock-cluster dock-cluster-left');
  leftCluster.append(micBtn, matrix, adds);
  const rightCluster = h('div', 'dock-cluster dock-cluster-right');
  rightCluster.append(themeBtn, soundBtn, trash);

  dock.append(leftCluster, rightCluster);

  renderModes(state.get('mode'));
  renderTheme(state.get('theme'));
  renderSound(state.get('muted'));
}

function renderModes(mode) {
  if (!el.modeBtns) return;
  const cur = mode || { input: 'voice', output: 'voice' };
  for (const b of el.modeBtns) {
    const active = b.dataset.input === cur.input && b.dataset.output === cur.output;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function renderVoiceBtn(open) {
  if (!el.voiceBtn) return;
  el.voiceBtn.textContent = open ? '■ STOP' : '◉ GŁOS';
  el.voiceBtn.classList.toggle('is-active', open);
}

function renderTheme(theme) {
  if (!el.themeBtn) return;
  // Show the label of the currently-active theme, emphasized.
  const isBlue = theme === 'blueprint';
  el.themeBtn.innerHTML = '';
  const mono = h('span', isBlue ? 'theme-opt' : 'theme-opt is-on', { text: 'MONO' });
  const sep = h('span', 'theme-sep', { text: '/' });
  const blue = h('span', isBlue ? 'theme-opt is-on' : 'theme-opt', { text: 'BLUEPRINT' });
  el.themeBtn.append(mono, sep, blue);
}

function renderSound(muted) {
  if (!el.soundBtn) return;
  el.soundBtn.textContent = muted ? 'DŹWIĘK OFF' : 'DŹWIĘK ON';
  el.soundBtn.classList.toggle('is-off', muted);
}

function toggleTheme() {
  const next = state.get('theme') === 'blueprint' ? 'mono' : 'blueprint';
  state.set('theme', next);
}

// Scale-pulse the trash target when a trash sound passes.
function pulseTrash() {
  if (!el.trash) return;
  el.trash.classList.remove('is-pulse');
  // force reflow so the animation can retrigger
  void el.trash.offsetWidth;
  el.trash.classList.add('is-pulse');
  window.setTimeout(() => el.trash && el.trash.classList.remove('is-pulse'), 360);
}

// ---------------------------------------------------------------------------
// TOASTS — queue max 3 stacked cards, auto-dismiss 4s.
// ---------------------------------------------------------------------------
const MAX_TOASTS = 3;
const TOAST_TTL = 4000;
let liveToasts = [];

function showToast({ text, kind = 'info' } = {}) {
  const layer = document.getElementById('toast-layer');
  if (!layer || !text) return;

  // Enforce cap: drop the oldest immediately if we're at the limit.
  while (liveToasts.length >= MAX_TOASTS) {
    const old = liveToasts.shift();
    if (old) dismissToast(old, true);
  }

  const card = h('div', `toast toast-${kind}`, { role: 'status' });
  const prefix = kind === 'warn' ? '! ' : '';
  card.textContent = prefix + text;
  layer.append(card);
  // fly-in on next frame
  requestAnimationFrame(() => card.classList.add('is-in'));

  const entry = { card, timer: 0 };
  entry.timer = window.setTimeout(() => {
    liveToasts = liveToasts.filter((e) => e !== entry);
    dismissToast(entry, false);
  }, TOAST_TTL);
  liveToasts.push(entry);
}

function dismissToast(entry, immediate) {
  if (!entry || !entry.card) return;
  if (entry.timer) window.clearTimeout(entry.timer);
  const card = entry.card;
  if (immediate) {
    card.remove();
    return;
  }
  card.classList.remove('is-in');
  card.classList.add('is-out');
  window.setTimeout(() => card.remove(), 320);
}

// ---------------------------------------------------------------------------
// HOTKEYS — window keydown; skipped while typing in an input/textarea.
// ---------------------------------------------------------------------------
function onKeydown(e) {
  if (isTyping(e.target)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      bus.emit('voice:toggle', {});
      break;
    case 'Escape':
      if (state.ui === 'showing') {
        bus.emit('assistant:tool', { name: 'hide_widgets', args: {} });
      }
      break;
    case 'KeyT':
      toggleTheme();
      break;
    case 'KeyC':
      state.set('chatOpen', !state.get('chatOpen'));
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------
export async function init() {
  if (booted) return;
  booted = true;

  try {
    buildTopBar();
    buildDock();
  } catch (e) {
    console.error('[hud] build failed', e);
    bus.emit('toast', { text: 'HUD się wysypał, człowieku — lecę dalej.', kind: 'warn' });
    return;
  }

  // --- Event wiring (honest states) ---
  bus.on('state:change', updateStateLabel);

  bus.on('bridge:status', (p) => renderBridge(!!(p && p.online)));
  state.subscribe('bridgeOnline', (v) => renderBridge(!!v));

  state.subscribe('wakeEnabled', (v) => renderWake(!!v));
  // Re-render when capability changes (Porcupine comes up or is unconfigured).
  state.subscribe('wakeAvailable', () => renderWake(state.get('wakeEnabled')));

  bus.on('voice:session', (p) => {
    const status = p && p.status;
    const open = status === 'open' || status === 'connecting';
    renderMic(status === 'open');
    renderVoiceBtn(open);
  });

  state.subscribe('mode', (v) => renderModes(v));
  state.subscribe('theme', (v) => renderTheme(v));
  state.subscribe('muted', (v) => renderSound(v));
  state.subscribe('demo', (v) => renderDemo(!!v));

  // Trash pulse tied to the real trash sound event.
  bus.on('sound:play', (p) => {
    if (p && p.name === 'trash') pulseTrash();
  });

  // Toasts.
  bus.on('toast', showToast);

  // Hotkeys.
  window.addEventListener('keydown', onKeydown);

  console.info('[hud] ready');
}
