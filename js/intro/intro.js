// js/intro/intro.js — Iron-Man boot ceremony wrapping REAL Firebase login.
// Owner: intro module. Builds all DOM inside #intro-layer, runs a cancellable
// async beat sequencer, then emits 'intro:done' exactly once and hands the UI
// over to 'idle'. STRICTLY B&W, terminal/mono; only transform/opacity animate
// (the two glitch flashes are the sole sanctioned filter animations).
//
// Contracts honored:
//   auth  : signIn(email,password) -> {ok, error?}          (js/memory/firebase.js)
//   state : get('demo') / get('user') / setUI('idle', ...)  (js/core/state-manager.js)
//   bus   : emit 'sound:play' {name}, emit 'intro:done' {}   (js/core/event-bus.js)
//           listen 'auth:ready' {user, demo} (once, guarded — memory inits first)

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';
import { signIn } from '../memory/firebase.js';

// ---- Small helpers ----------------------------------------------------------

const $ = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};

const prefersReducedMotion = () =>
  typeof matchMedia === 'function' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches;

/** sound cue helper — fire-and-forget, sound module honors mute. */
const cue = (name) => bus.emit('sound:play', { name });

/**
 * A cancellable sleep. Rejects with a tagged AbortError the moment `signal`
 * aborts, so an awaiting beat unwinds immediately (skip = fast-forward).
 * @param {number} ms
 * @param {AbortSignal} signal
 */
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const id = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  const e = new Error('intro-skipped');
  e.name = 'AbortError';
  return e;
}
const isAbort = (e) => e && e.name === 'AbortError';

/**
 * Await a real user submit of a form field (Enter / button). Resolves with the
 * trimmed value. Rejects on abort. Blocks empty submits (stays waiting).
 * @param {HTMLFormElement} form
 * @param {HTMLInputElement} input
 * @param {AbortSignal} signal
 */
function awaitSubmit(form, input, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const finish = () => {
      const val = input.value.trim();
      if (!val) { input.focus(); return; } // ignore empty, keep waiting
      cleanup();
      resolve(val);
    };
    const onSubmit = (e) => { e.preventDefault(); finish(); };
    // A form with two inputs (username + password) and NO submit button does
    // NOT implicitly submit on Enter — so the native 'submit' never fires on the
    // password step and Enter appears dead. Catch Enter on the input directly.
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(); }
    };
    const onAbort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => {
      form.removeEventListener('submit', onSubmit);
      input.removeEventListener('keydown', onKey);
      signal.removeEventListener('abort', onAbort);
    };
    form.addEventListener('submit', onSubmit);
    input.addEventListener('keydown', onKey);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Typewriter into `el`, char-by-char with a blinking block caret. Reduced
 * motion / short mode => instant. Monospace guarantees zero reflow.
 * @param {HTMLElement} el
 * @param {string} text
 * @param {number} perChar ms per character
 * @param {AbortSignal} signal
 * @param {boolean} instant
 */
async function typewriter(el, text, perChar, signal, instant) {
  const caret = $('span', 'intro-caret', '▮'); // ▮
  if (instant) {
    el.textContent = text;
    el.appendChild(caret);
    return caret;
  }
  el.textContent = '';
  el.appendChild(caret);
  for (let i = 0; i < text.length; i++) {
    caret.remove();
    el.append(text[i]);
    el.appendChild(caret);
    cue('blip-in');
    // eslint-disable-next-line no-await-in-loop
    await wait(perChar, signal);
  }
  return caret;
}

// ---- Persisted "seen" flag --------------------------------------------------
//
// The flag is DEVICE-level, not uid-scoped. It is READ at run() start (before
// login, when the uid is unknown / the Firebase session may not have restored
// yet) and WRITTEN at finishBoot() (after login, uid known). A uid-scoped key
// therefore never round-trips reliably: a first-ever login writes under the real
// uid but the next boot reads under the pre-login fallback key → the full
// ceremony replays forever and orphans keys. A single stable device key fixes
// both and matches the real intent: "short second run ON THIS DEVICE".
const SEEN_KEY = 'gzowo.introSeen';
function hasSeen() {
  try { return localStorage.getItem(SEEN_KEY) === '1'; }
  catch { return false; }
}
function markSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); }
  catch { /* private mode — ignore, just replay full ceremony */ }
}

// ============================================================================
//  Module entry
// ============================================================================

let started = false; // idempotent guard (init must never run twice)

export async function init() {
  if (started) return;
  started = true;

  const layer = document.getElementById('intro-layer');
  if (!layer) {
    // No stage — degrade honestly: still hand off so the app is usable.
    finishBoot(null, true);
    return;
  }

  // memory.init() runs BEFORE intro.init() (main.js order), so 'auth:ready'
  // has usually already fired and set authResolved. Gate on "auth resolved at
  // all" (authResolved), NOT on "user present" — a signed-OUT returning user has
  // user===null & demo===false yet auth IS resolved, and the old check would
  // wait for an auth:ready that already fired, hitting the 4s timeout every boot
  // (black cover before IDENTIFY). authResolved is set by every terminal auth
  // path in firebase.js (signed-in, signed-out, demo, init-fail).
  const authResolved = () => state.get('authResolved') === true;
  if (!authResolved()) {
    await new Promise((resolve) => {
      const done = () => resolve();
      bus.once('auth:ready', done);
      // If it already fired before we subscribed, don't hang.
      if (authResolved()) {
        bus.off('auth:ready', done);
        resolve();
      }
      // Hard timeout so a missing memory module never freezes the boot cover.
      setTimeout(resolve, 4000);
    });
  }

  try {
    await new Ceremony(layer).run();
  } catch (e) {
    if (!isAbort(e)) console.error('[intro] ceremony error', e);
    // Any unexpected failure must still hand off — never trap the user behind
    // the cover. The handoff itself is idempotent.
    finishBoot(state.get('user'), state.get('demo') === true);
  }
}

// ---- The single handoff, guaranteed to run its side effects once -----------

let handedOff = false;
function finishBoot(user, demo) {
  if (handedOff) return;
  handedOff = true;

  // Persist the device-level "seen" flag so the next load takes the short cut.
  markSeen();

  bus.emit('intro:done', {});
  state.setUI('idle', 'intro-complete');

  const layer = document.getElementById('intro-layer');
  if (layer) {
    layer.hidden = true;               // removes from hit-testing + a11y tree
    layer.style.display = 'none';      // belt-and-suspenders per contract
  }
}

// ============================================================================
//  Ceremony — builds DOM, runs the beat sheet, owns the abort timeline
// ============================================================================

class Ceremony {
  constructor(layer) {
    this.layer = layer;
    this.reduced = prefersReducedMotion();
    // Skip aborts the ceremony timeline. It is armed only once ignition begins;
    // login can never be skipped.
    this.ctrl = new AbortController();
    this.signal = this.ctrl.signal;
    this.skipArmed = false;
    this._buildDom();
  }

  // ---- DOM construction (all inside #intro-layer, < 100 nodes) --------------

  _buildDom() {
    const L = this.layer;
    L.replaceChildren(); // clean stage (defensive; scaffold ships it empty)

    // Opaque cover that the ignition sweep masks away to reveal the grid.
    this.cover = $('div', 'intro-cover');
    L.appendChild(this.cover);

    // Content stage.
    this.stage = $('div', 'intro-stage');
    L.appendChild(this.stage);

    // --- Login console ---
    this.console = $('div', 'intro-console');
    this.osline = $('div', 'intro-osline');
    this.prompt = $('div', 'intro-prompt');
    this.console.append(this.osline, this.prompt);

    // Real form (password-manager friendly): username + password fields.
    this.form = document.createElement('form');
    this.form.className = 'intro-form';
    this.form.setAttribute('autocomplete', 'on');
    this.form.setAttribute('novalidate', '');

    this.userField = this._field('USERNAME', 'text', 'username', 'gzowo-user');
    this.passField = this._field('PASSWORD', 'password', 'current-password', 'gzowo-pass');
    this.passField.field.hidden = true; // whole field (label + input) hidden until step 2

    this.status = $('div', 'intro-status');
    this.error = $('div', 'intro-error');

    this.demoBadge = $('div', 'intro-demo-badge',
      'TRYB DEMO — FIREBASE NIE SKONFIGUROWANY');
    this.demoBadge.hidden = true;

    this.form.append(
      this.userField.field, this.passField.field, this.status, this.error, this.demoBadge
    );
    this.console.appendChild(this.form);
    this.stage.appendChild(this.console);

    // --- Ignition core (SVG rings + dot) ---
    this.core = $('div', 'intro-core');
    const pulse = $('div', 'intro-core-pulse');
    pulse.innerHTML = this._coreSvg();
    this.core.appendChild(pulse);
    L.appendChild(this.core);

    // --- Bright flash overlay (collapse + glitch support) ---
    this.flash = $('div', 'intro-flash');
    L.appendChild(this.flash);

    // --- Grant / hello banner ---
    this.banner = $('div', 'intro-banner');
    this.banner.hidden = true;
    this.bannerLead = $('div', 'intro-banner-lead intro-glitch');
    this.bannerSub = $('div', 'intro-banner-sub');
    this.banner.append(this.bannerLead, this.bannerSub);
    L.appendChild(this.banner);

    // --- HUD frame + corner microtext ---
    this.hud = $('div', 'intro-hud');
    this.hud.hidden = true;
    for (const side of ['top', 'bottom', 'left', 'right']) {
      this.hud.appendChild($('div', `intro-frame intro-frame-${side}`));
    }
    this.micro = {
      tl: this._microBlock('intro-micro-tl'),
      tr: this._microBlock('intro-micro-tr'),
      bl: this._microBlock('intro-micro-bl'),
      br: this._microBlock('intro-micro-br')
    };
    for (const k of Object.keys(this.micro)) this.hud.appendChild(this.micro[k].el);
    L.appendChild(this.hud);

    // --- Skip button ---
    this.skip = $('button', 'intro-skip', '[ESC] POMIŃ');
    this.skip.type = 'button';
    this.skip.hidden = true;
    L.appendChild(this.skip);

    // Position the sweep mask on the core center (screen center for v1).
    L.style.setProperty('--core-x', '50%');
    L.style.setProperty('--core-y', '50%');
  }

  _field(label, type, autocomplete, name) {
    const field = $('div', 'intro-field');
    const lab = $('label', 'intro-label', label);
    lab.setAttribute('for', name);
    const wrap = $('div', 'intro-input-wrap');
    const input = document.createElement('input');
    input.className = 'intro-input';
    input.type = type;
    input.id = name;
    input.name = name;
    input.setAttribute('autocomplete', autocomplete);
    input.setAttribute('autocapitalize', type === 'password' ? 'off' : 'characters');
    input.setAttribute('autocorrect', 'off');
    input.spellcheck = false;
    const underline = $('div', 'intro-underline');
    input.addEventListener('focus', () => wrap.classList.add('is-focused'));
    input.addEventListener('blur', () => wrap.classList.remove('is-focused'));
    wrap.append(input, underline);
    field.append(lab, wrap);
    return { field, wrap, input, label: lab };
  }

  _microBlock(cls) {
    const el = $('div', `intro-micro ${cls}`);
    return { el, lines: [] };
  }

  _coreSvg() {
    // Three concentric dashed rings + a center dot. Strokes are 1px, B&W tokens.
    return `
      <svg viewBox="0 0 340 340" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle class="intro-ring intro-ring-1" cx="170" cy="170" r="150"
                stroke-width="1" stroke-dasharray="2 10" />
        <circle class="intro-ring intro-ring-2" cx="170" cy="170" r="112"
                stroke-width="1" stroke-dasharray="1 6" />
        <circle class="intro-ring intro-ring-3" cx="170" cy="170" r="74"
                stroke-width="1" stroke-dasharray="4 8" />
        <circle class="intro-dot" cx="170" cy="170" r="5" />
      </svg>`;
  }

  // ---- Skip wiring ----------------------------------------------------------

  _armSkip() {
    if (this.skipArmed) return;
    this.skipArmed = true;
    this.skip.hidden = false;
    requestAnimationFrame(() => this.skip.classList.add('is-in'));

    this._onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this._doSkip(); }
    };
    this._onClick = () => this._doSkip();
    document.addEventListener('keydown', this._onKey);
    this.skip.addEventListener('click', this._onClick);
  }

  _disarmSkip() {
    if (this._onKey) document.removeEventListener('keydown', this._onKey);
    if (this._onClick) this.skip.removeEventListener('click', this._onClick);
    this.skip.classList.remove('is-in');
    this.skip.hidden = true;
  }

  _doSkip() {
    if (this.signal.aborted) return;
    this.ctrl.abort(); // fast-forward: every awaiting beat unwinds via AbortError
  }

  // ---- Beat sheet -----------------------------------------------------------

  async run() {
    const demo = state.get('demo') === true;
    const seen = hasSeen(); // device-level; independent of login timing
    const short = seen || this.reduced;
    const instant = short; // no typewriter in the short/reduced timeline

    if (demo) this.demoBadge.hidden = false;

    try {
      // ---- (1) IDENTIFY ----
      if (!short) {
        await wait(600, this.signal);                       // black silence
      }
      await typewriter(this.osline, 'GZOWO OS v1.0', 26, this.signal, instant);
      await this._promptLine('PLEASE IDENTIFY YOURSELF', instant);
      this._revealField(this.userField, instant);
      this.userField.input.focus();

      const rawUser = await awaitSubmit(this.form, this.userField.input, this.signal);
      const typedPrefix = (rawUser.split('@')[0] || rawUser).trim();
      // Map a bare username to an email so the login screen stays "just your name"
      // (Jarvis-style) while Firebase still gets a valid email. A typed full email
      // is used verbatim. Domain is configurable via CONFIG.auth.emailDomain.
      const domain = (window.GZOWO_CONFIG && window.GZOWO_CONFIG.auth
        && window.GZOWO_CONFIG.auth.emailDomain) || 'gzowo.ai';
      const email = (rawUser.includes('@') ? rawUser : `${rawUser}@${domain}`).toLowerCase();

      // ---- (2) PASSWORD ----
      this.userField.input.setAttribute('readonly', ''); // lock the username
      await this._promptLine('ENTER PASSWORD', instant);
      this.passField.field.hidden = false;
      this._revealField(this.passField, instant);
      this.passField.input.focus();

      // ---- (3) AUTHORIZE — loop until signIn ok (attempts unlimited) ----
      let result;
      for (;;) {
        const password = await awaitSubmit(this.form, this.passField.input, this.signal);
        this._setStatus('AUTHORIZING', true);
        this.error.textContent = '';
        // signIn is REAL every time (short version too). Not abortable — login
        // can never be skipped, only the ceremony around it.
        // eslint-disable-next-line no-await-in-loop
        result = await signIn(email, password);
        if (result && result.ok) break;

        // Denied: PL Edek copy + shake + deny cue, back to password.
        this._setStatus('ACCESS DENIED', true, true);
        this.error.textContent =
          (result && result.error) || 'Złe hasło, człowieku. Jeszcze raz.';
        cue('deny');
        if (!this.reduced) this._shake(this.console);
        this.passField.input.value = '';
        this.passField.input.focus();
      }

      // Login done. From here the ceremony (not the login) may be skipped.
      this._clearStatus();

      // ---- (4) ACCESS GRANTED — invert glitch + grant cue ----
      const name = (state.get('user')?.name || typedPrefix || 'PILOCIE').toUpperCase();
      await this._grant(short);

      // ---- (5) HELLO, {NAME} / WELCOME BACK ----
      await this._hello(name, short);

      // ---- (6) IGNITION ----
      await this._ignition(short);

      // ---- (7) HANDOFF ----
      await this._handoff();
    } catch (e) {
      if (!isAbort(e)) throw e;
      // Skipped mid-ceremony (only possible post-grant): jump to handoff.
      await this._handoff().catch(() => {});
    } finally {
      this._disarmSkip();
    }
  }

  // ---- Beat implementations -------------------------------------------------

  async _promptLine(text, instant) {
    this.prompt.replaceChildren();
    await typewriter(this.prompt, text, 30, this.signal, instant);
  }

  _revealField(f, instant) {
    f.field.classList.add('intro-fade-in');
    // Border draws itself left-to-right (scaleX). Instant in short mode.
    if (instant) {
      f.wrap.querySelector('.intro-underline').style.transition = 'none';
      f.wrap.classList.add('is-drawn');
      // restore transition next frame so focus glow still animates
      requestAnimationFrame(() => {
        f.wrap.querySelector('.intro-underline').style.transition = '';
      });
    } else {
      requestAnimationFrame(() => f.wrap.classList.add('is-drawn'));
    }
  }

  _setStatus(text, dots = false, deny = false) {
    this.status.replaceChildren();
    this.status.classList.toggle('is-deny', deny);
    this.status.append(document.createTextNode(text));
    if (dots) {
      const d = $('span', 'intro-dots');
      this.status.appendChild(d);
    }
  }
  _clearStatus() {
    this.status.replaceChildren();
    this.status.classList.remove('is-deny');
  }

  _shake(el) {
    el.classList.remove('intro-shake');
    // reflow to restart the animation
    void el.offsetWidth;
    el.classList.add('intro-shake');
    el.addEventListener('animationend', () => el.classList.remove('intro-shake'), { once: true });
  }

  async _grant(short) {
    cue('grant');
    // Hide the console, show the banner with ACCESS GRANTED.
    this.console.hidden = true;
    this.banner.hidden = false;
    this.bannerLead.textContent = 'ACCESS GRANTED';
    this.bannerSub.textContent = '';

    if (!this.reduced) {
      // The 2-frame invert glitch (~350ms) — one of two sanctioned filter FX.
      this.bannerLead.classList.remove('is-glitching');
      void this.bannerLead.offsetWidth;
      this.bannerLead.classList.add('is-glitching');
      this._flash();
    }
    await wait(short ? 550 : 900, this.signal).catch(rethrowAbort);
  }

  async _hello(name, short) {
    this.bannerLead.classList.remove('is-glitching');
    this.bannerLead.textContent = `HELLO, ${name}`;
    this.bannerLead.classList.add('intro-fade-in');
    void this.bannerLead.offsetWidth;
    this.bannerSub.textContent = 'WELCOME BACK';
    this.bannerSub.classList.add('intro-fade-in');
    await wait(short ? 700 : 1400, this.signal).catch(rethrowAbort);
  }

  async _ignition(short) {
    // Play the boot sound at ignition start.
    cue('boot');
    // Ceremony is now skippable.
    this._armSkip();

    // Fade the banner out; light the core.
    this.banner.classList.add('intro-fade-in');
    this.banner.style.opacity = '0';
    this.banner.style.transition = `opacity var(--t-med) var(--ease-out)`;

    // Light the core.
    this.core.classList.add('is-on');

    // Reveal the grid underneath by sweeping the cover mask open from the core.
    this._sweep(short ? 900 : 2200);

    if (short) {
      // Mini-ignition ~1.5s: draw a couple of frame lines + a bit of microtext.
      this.hud.hidden = false;
      this._drawFrame(80);
      this._fillMicro(120);
      await wait(1500, this.signal).catch(rethrowAbort);
      return;
    }

    // Full ignition ~8s. Stagger HUD frame lines, then microtext columns.
    this.hud.hidden = false;
    await wait(300, this.signal).catch(rethrowAbort);
    this._drawFrame(120);
    await wait(900, this.signal).catch(rethrowAbort);
    this._fillMicro(220);
    // Let the core spin/pulse and the grid breathe for the remainder.
    await wait(5600, this.signal).catch(rethrowAbort);
  }

  /** Animate the cover mask open (grid grows from the core). opacity/mask only. */
  _sweep(duration) {
    const start = performance.now();
    const from = 0, to = 1;
    const tick = (now) => {
      if (this.signal.aborted) { this.layer.style.setProperty('--sweep', '1'); return; }
      const t = Math.min(1, (now - start) / duration);
      // ease-out cubic
      const e = 1 - Math.pow(1 - t, 3);
      this.layer.style.setProperty('--sweep', String(from + (to - from) * e));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _drawFrame(stagger) {
    const frames = [...this.hud.querySelectorAll('.intro-frame')];
    frames.forEach((f, i) => {
      setTimeout(() => { if (!this.signal.aborted) f.classList.add('is-in'); }, i * stagger);
    });
  }

  _fillMicro(stagger) {
    const cols = {
      tl: ['MEM OK', 'CPU OK', 'THRM OK'],
      tr: ['NET OK', 'AUTH OK', 'LINK 100%'],
      bl: ['ORB CORE', 'SPOOLING', 'IGNITED'],
      br: [hex(), hex(), hex()]
    };
    let i = 0;
    for (const key of Object.keys(cols)) {
      const block = this.micro[key];
      block.el.replaceChildren();
      for (const text of cols[key]) {
        const line = $('div', 'line', text);
        block.el.appendChild(line);
        const delay = i++ * stagger;
        setTimeout(() => { if (!this.signal.aborted) line.classList.add('is-in'); }, delay);
      }
    }
  }

  _flash() {
    this.flash.classList.remove('is-flash');
    void this.flash.offsetWidth;
    this.flash.classList.add('is-flash');
    this.flash.addEventListener('animationend',
      () => this.flash.classList.remove('is-flash'), { once: true });
  }

  async _handoff() {
    // Ensure the grid is fully revealed (in case of skip mid-sweep).
    this.layer.style.setProperty('--sweep', '1');

    if (!this.reduced) {
      // Rings collapse into the dot with a bright flash.
      this.core.classList.add('is-collapsing');
      this._flash();
      await settle(300);
    }

    // Fade the whole layer out (600ms), then finish + hide.
    this.layer.classList.add('is-leaving');
    await settle(this.reduced ? 60 : 600);

    finishBoot(state.get('user'), state.get('demo') === true);
  }
}

// ---- Free helpers -----------------------------------------------------------

/** A plain (non-abortable) delay used during handoff, which must always complete. */
function settle(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Re-throw only genuine aborts; swallow nothing else (used after .catch). */
function rethrowAbort(e) {
  if (isAbort(e)) throw e;
}

/** Random 4-hex status token for the corner microtext flicker. */
function hex() {
  return '0x' + Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, '0');
}
