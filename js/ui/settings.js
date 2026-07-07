// js/ui/settings.js — v2 Settings panel. VOICE-ONLY entry.
// There is ZERO button anywhere in the app that opens this panel: the only way in
// is the `open_settings` tool the voice model calls when the user says e.g.
// „otwórz ustawienia". The panel's × and ESC/backdrop only ever CLOSE it.
//
// Contents (all B&W chrome, tokens only): MOTYW (mono|blueprint), DŹWIĘK,
// NASŁUCH „Hej Gzowo" (+ truthful status line), KONTO (username + WYLOGUJ).
//
// GLOBAL RULES honored: strict B&W via design tokens + the shared .glass utility;
// only transform/opacity are animated; PL copy (friendly, concise); English code;
// init() is idempotent and never throws.

import { state } from '../core/state-manager.js';
import { bus } from '../core/event-bus.js';
import { toolRouter } from '../core/tool-router.js';

// Match --t-med so the card's hidden flip lands exactly when the transition ends.
const CLOSE_MS = 300;

// Truthful wake-model status copy, keyed by state 'wakeModelStatus'.
const WAKE_STATUS_TEXT = {
  loading: 'model się ładuje w tle…',
  ready: 'gotowy — powiedz „Hej Gzowo”',
  unavailable: 'niedostępny — uruchom most (localhost:8787)',
  idle: 'nieaktywny'
};

let built = false;
let isOpen = false;
let closeTimer = 0;
let lastFocused = null;

// DOM refs (populated once by build())
let root = null;        // #settings-layer
let backdrop = null;    // scrim + centering flex
let card = null;        // the glass dialog
let themeSeg = null;
let soundSeg = null;
let wakeSeg = null;
let wakeOnBtn = null;   // the WŁĄCZONY option — dimmed when wake unavailable
let statusEl = null;    // wake status line
let userEl = null;      // KONTO username text

// ---------------------------------------------------------------------------
// Segmented control — a row of options; the active one is inverted (white-on-black).
// onSelect receives the option's raw value (bool or string).
// ---------------------------------------------------------------------------
function segmented(options, onSelect, groupLabel) {
  const wrap = document.createElement('div');
  wrap.className = 'seg';
  wrap.setAttribute('role', 'group');
  if (groupLabel) wrap.setAttribute('aria-label', groupLabel);

  const btns = options.map((o) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-opt';
    b.dataset.value = String(o.value);
    b.textContent = o.label;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => onSelect(o.value));
    wrap.appendChild(b);
    return b;
  });

  function setActive(value) {
    const v = String(value);
    for (const b of btns) {
      const active = b.dataset.value === v;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  return { el: wrap, setActive, btns };
}

// Small helper: a labelled section (mono uppercase label + a body slot).
function section(labelText) {
  const sec = document.createElement('section');
  sec.className = 'settings-section';
  const label = document.createElement('div');
  label.className = 'settings-label';
  label.textContent = labelText;
  sec.appendChild(label);
  return sec;
}

// ---------------------------------------------------------------------------
// Build the panel DOM exactly once and wire live state subscriptions.
// ---------------------------------------------------------------------------
function build() {
  if (built) return;
  root = document.getElementById('settings-layer');
  if (!root) {
    console.warn('[settings] #settings-layer missing — panel not built');
    return;
  }

  // Backdrop = scrim + centering container. Clicking it (but not the card) closes.
  backdrop = document.createElement('div');
  backdrop.className = 'settings-backdrop';

  // Card = the one shared glass surface, sized per brief.
  card = document.createElement('div');
  card.className = 'settings-card glass';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'settings-title');
  card.tabIndex = -1;

  // Header — title + close (× closes only; it is NOT an opener).
  const head = document.createElement('div');
  head.className = 'settings-head';
  const title = document.createElement('h2');
  title.className = 'settings-title';
  title.id = 'settings-title';
  title.textContent = 'USTAWIENIA';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'settings-close';
  closeBtn.setAttribute('aria-label', 'Zamknij ustawienia');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', close);
  head.append(title, closeBtn);

  // 1. MOTYW ----------------------------------------------------------------
  const themeSec = section('MOTYW');
  themeSeg = segmented(
    [{ label: 'MONO', value: 'mono' }, { label: 'BLUEPRINT', value: 'blueprint' }],
    (v) => state.set('theme', v),
    'Motyw'
  );
  themeSec.appendChild(themeSeg.el);

  // 2. DŹWIĘK ---------------------------------------------------------------
  const soundSec = section('DŹWIĘK');
  soundSeg = segmented(
    [{ label: 'WŁĄCZONY', value: false }, { label: 'WYCISZONY', value: true }],
    (v) => state.set('muted', v),
    'Dźwięk'
  );
  soundSec.appendChild(soundSeg.el);

  // 3. NASŁUCH „HEJ GZOWO” --------------------------------------------------
  const wakeSec = section('NASŁUCH „HEJ GZOWO”');
  wakeSeg = segmented(
    [{ label: 'WŁĄCZONY', value: true }, { label: 'WYŁĄCZONY', value: false }],
    (v) => state.set('wakeEnabled', v),
    'Nasłuch Hej Gzowo'
  );
  wakeOnBtn = wakeSeg.btns[0]; // WŁĄCZONY — dimmed (but still clickable) when unavailable
  statusEl = document.createElement('div');
  statusEl.className = 'settings-status';
  statusEl.setAttribute('aria-live', 'polite');
  wakeSec.append(wakeSeg.el, statusEl);

  // 4. KONTO ----------------------------------------------------------------
  const accSec = section('KONTO');
  const accRow = document.createElement('div');
  accRow.className = 'settings-account';
  userEl = document.createElement('span');
  userEl.className = 'settings-user';
  const logoutBtn = document.createElement('button');
  logoutBtn.type = 'button';
  logoutBtn.className = 'settings-logout';
  logoutBtn.textContent = 'WYLOGUJ';
  logoutBtn.addEventListener('click', doLogout);
  accRow.append(userEl, logoutBtn);
  accSec.appendChild(accRow);

  card.append(head, themeSec, soundSec, wakeSec, accSec);
  backdrop.appendChild(card);
  root.appendChild(backdrop);

  // Close on backdrop click; card clicks never propagate to the backdrop.
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  card.addEventListener('click', (e) => e.stopPropagation());

  // Live state -> UI. Subscriptions live for the app's lifetime (the panel is
  // built once); they keep the DOM correct whether the panel is open or not.
  state.subscribe('theme', (v) => themeSeg.setActive(v));
  state.subscribe('muted', (v) => soundSeg.setActive(v));
  state.subscribe('wakeEnabled', (v) => wakeSeg.setActive(v));
  state.subscribe('wakeModelStatus', renderWakeStatus);
  state.subscribe('wakeAvailable', renderWakeDim);
  state.subscribe('user', renderUser);

  built = true;
  renderAll();
}

// ---- Renderers -------------------------------------------------------------
function renderWakeStatus() {
  if (!statusEl) return;
  statusEl.textContent = WAKE_STATUS_TEXT[state.get('wakeModelStatus')] || WAKE_STATUS_TEXT.idle;
}

function renderWakeDim() {
  if (!wakeOnBtn) return;
  // Unavailable -> visually dim WŁĄCZONY, but keep it clickable: the wake module
  // honors the saved preference the moment its model finishes loading.
  wakeOnBtn.classList.toggle('is-dimmed', !state.get('wakeAvailable'));
}

function renderUser() {
  if (!userEl) return;
  const user = state.get('user');
  const name = (user && user.username) ? user.username : '—';
  userEl.textContent = '';
  userEl.append('ZALOGOWANY: ');
  const b = document.createElement('b');
  b.textContent = name;
  userEl.appendChild(b);
}

function renderAll() {
  themeSeg.setActive(state.get('theme'));
  soundSeg.setActive(state.get('muted'));
  wakeSeg.setActive(state.get('wakeEnabled'));
  renderWakeStatus();
  renderWakeDim();
  renderUser();
}

// ---- Open / close ----------------------------------------------------------
function open() {
  build();
  if (!root) return;
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = 0; }

  if (!isOpen) {
    lastFocused = document.activeElement;
    window.addEventListener('keydown', onKeydown);
  }
  isOpen = true;

  root.hidden = false;
  renderAll(); // re-sync in case values changed while hidden
  // Next frame: flip .is-open so the backdrop fades and the card scales 0.96 -> 1.
  requestAnimationFrame(() => {
    if (isOpen && root) root.classList.add('is-open');
  });
  state.set('settingsOpen', true);

  try { card.focus(); } catch (_e) { /* focus is best-effort */ }
}

function close() {
  if (!root) return;
  const wasOpen = isOpen;
  isOpen = false;
  window.removeEventListener('keydown', onKeydown);
  root.classList.remove('is-open');
  state.set('settingsOpen', false);

  // Hide after the exit transition so the fade/scale-out is visible.
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (!isOpen && root) root.hidden = true;
    closeTimer = 0;
  }, CLOSE_MS);

  if (wasOpen && lastFocused && typeof lastFocused.focus === 'function') {
    try { lastFocused.focus(); } catch (_e) { /* element may be gone */ }
  }
  lastFocused = null;
  return wasOpen;
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  }
}

// ---- Logout ----------------------------------------------------------------
// Dynamic import so a broken/missing auth module can't take down the whole
// settings panel at load time — we degrade honestly with a toast instead.
async function doLogout() {
  try {
    const mod = await import('../auth/custom-auth.js');
    const fn = mod.logout || (mod.customAuth && mod.customAuth.logout);
    if (typeof fn === 'function') {
      fn(); // clears the session + location.reload() — nothing after this runs
      return;
    }
    throw new Error('logout export missing');
  } catch (err) {
    console.warn('[settings] logout unavailable', err);
    bus.emit('toast', { text: 'Nie udało się wylogować. Odśwież stronę.', kind: 'warn' });
  }
}

// ---- Init (idempotent, never throws) --------------------------------------
export function init() {
  build();

  // The ONLY entry point: two voice tools. No button, no hotkey opens the panel.
  toolRouter.registerTool(
    {
      name: 'open_settings',
      description: 'Otwórz panel ustawień (motyw, dźwięk, nasłuch, konto). Jedyny sposób otwarcia — użytkownik prosi głosem, np. „otwórz ustawienia”.',
      parameters: { type: 'object', properties: {} }
    },
    async () => { open(); return { ok: true }; }
  );

  toolRouter.registerTool(
    {
      name: 'close_settings',
      description: 'Zamknij panel ustawień.',
      parameters: { type: 'object', properties: {} }
    },
    async () => { const wasOpen = close(); return { ok: true, wasOpen: Boolean(wasOpen) }; }
  );
}
