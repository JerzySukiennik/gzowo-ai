// js/auth/auth-screen.js — auth-owned, v2. The register/login gate rendered inside
// #auth-layer. Pure DOM + the shared bus; strictly B&W (all styling lives in
// css/auth.css via design tokens). English code, PL UI copy (friendly, concise).
//
// Flow (v2 point 13), Enter-driven and password-manager friendly:
//   1. NAZWA UŻYTKOWNIKA is autofocused. Enter -> exists(username)?
//        • found  -> reveal HASŁO, focus it, stage = login.
//        • absent -> label 'NOWE KONTO', reveal HASŁO + POWTÓRZ HASŁO (min 4),
//                    focus HASŁO, stage = register.
//   2. Enter in the last field submits: login() or register() (match + length
//      validated first, inline PL errors).
//   3. While pending the button reads 'SPRAWDZAM…'.
//   4. On error: inline white text + a transform-shake + 'sound:play' {deny};
//      the password is cleared and refocused.
//   5. On success: 'sound:play' {grant}; the card fades/scales out (~400ms), then
//      #auth-layer is hidden (hidden + display:none).
//
// LOCAL mode (isLocal()===true): a 'TRYB LOKALNY — BEZ CHMURY' badge is shown; the
// flow is otherwise identical (custom-auth stores the same salted-hash records in
// localStorage). This module never throws — a wiring failure just logs.

import { bus } from '../core/event-bus.js';

const EXIT_MS = 420;                       // card fade/scale-out before hiding the layer
const USERNAME_RE = /^[a-z0-9_-]{2,24}$/i; // mirror of custom-auth's rule (for nice copy)

/**
 * Mount the auth gate into #auth-layer and wire the whole flow.
 * @param {{
 *   exists:(u:string)=>Promise<boolean>,
 *   register:(u:string,p:string)=>Promise<{ok:boolean,error?:string}>,
 *   login:(u:string,p:string)=>Promise<{ok:boolean,error?:string}>,
 *   isLocal:()=>boolean
 * }} api
 */
export function mountAuthScreen({ exists, register, login, isLocal }) {
  const layer = document.getElementById('auth-layer');
  if (!layer) {
    console.error('[auth-screen] #auth-layer missing — cannot mount gate');
    return;
  }

  // ---- Markup -------------------------------------------------------------
  // No user input is interpolated here, so innerHTML is safe.
  layer.innerHTML = `
    <div class="auth-screen">
      <form class="auth-card glass" novalidate autocomplete="on">
        <div class="auth-wordmark">GZOWO AI</div>
        <div class="auth-badge" hidden>TRYB LOKALNY — BEZ CHMURY</div>
        <div class="auth-hint" hidden></div>

        <div class="auth-field" data-field="username">
          <label class="auth-label" for="auth-username">Nazwa użytkownika</label>
          <input class="auth-input" id="auth-username" name="username" type="text"
                 autocomplete="username" autocapitalize="off" autocorrect="off"
                 spellcheck="false" />
        </div>

        <div class="auth-field" data-field="password" hidden>
          <label class="auth-label" for="auth-password">Hasło</label>
          <input class="auth-input" id="auth-password" name="password" type="password"
                 autocomplete="current-password" />
        </div>

        <div class="auth-field" data-field="confirm" hidden>
          <label class="auth-label" for="auth-confirm">Powtórz hasło
            <span class="auth-sub">(min. 4 znaki)</span></label>
          <input class="auth-input" id="auth-confirm" name="confirm-password" type="password"
                 autocomplete="new-password" />
        </div>

        <p class="auth-error" role="alert" aria-live="polite"></p>

        <button class="auth-submit" type="submit">Dalej</button>
      </form>
    </div>
  `;

  const card      = layer.querySelector('.auth-card');
  const badge     = layer.querySelector('.auth-badge');
  const hintEl    = layer.querySelector('.auth-hint');
  const uField    = layer.querySelector('.auth-field[data-field="username"]');
  const pField    = layer.querySelector('.auth-field[data-field="password"]');
  const cField    = layer.querySelector('.auth-field[data-field="confirm"]');
  const uInput    = layer.querySelector('#auth-username');
  const pInput    = layer.querySelector('#auth-password');
  const cInput    = layer.querySelector('#auth-confirm');
  const errorEl   = layer.querySelector('.auth-error');
  const submitBtn = layer.querySelector('.auth-submit');

  // ---- State --------------------------------------------------------------
  let stage = 'username';   // 'username' | 'login' | 'register'
  let busy = false;         // a network call is in flight
  let done = false;         // success exit runs exactly once

  const LABELS = { username: 'Dalej', login: 'Zaloguj', register: 'Załóż konto' };

  if (typeof isLocal === 'function' && isLocal()) badge.hidden = false;

  // ---- Small view helpers -------------------------------------------------
  function updateSubmitLabel() {
    submitBtn.textContent = busy ? 'Sprawdzam…' : LABELS[stage];
  }

  function reveal(field) {
    if (!field.hidden) return;
    field.hidden = false;
    field.classList.remove('is-in');
    void field.offsetWidth;           // reflow so the reveal animation replays
    field.classList.add('is-in');
  }
  function conceal(field, input) {
    field.hidden = true;
    field.classList.remove('is-in');
    if (input) input.value = '';
  }

  function showError(msg) {
    errorEl.textContent = msg || '';
  }
  function clearError() {
    errorEl.textContent = '';
  }

  function shake() {
    card.classList.remove('is-shake');
    void card.offsetWidth;
    card.classList.add('is-shake');
  }
  card.addEventListener('animationend', (e) => {
    if (e.animationName === 'auth-shake') card.classList.remove('is-shake');
  });

  function setBusy(on) {
    busy = on;
    submitBtn.disabled = on;
    uInput.disabled = on;
    pInput.disabled = on;
    cInput.disabled = on;
    updateSubmitLabel();
  }

  // Wrong-credentials / rejected path: inline error + shake + deny cue, then clear
  // the password(s) and refocus so the user can retry immediately.
  function fail(msg, focusEl) {
    showError(msg || 'Coś poszło nie tak. Spróbuj ponownie.');
    shake();
    bus.emit('sound:play', { name: 'deny' });
    pInput.value = '';
    cInput.value = '';
    (focusEl || pInput).focus();
  }

  function succeed() {
    if (done) return;
    done = true;
    bus.emit('sound:play', { name: 'grant' });
    card.classList.add('is-exit');
    // Hide after the fade/scale so late reveals never flash the gate again.
    setTimeout(hideLayer, EXIT_MS);
  }
  function hideLayer() {
    layer.hidden = true;
    layer.style.display = 'none';
  }

  // ---- Stage transitions --------------------------------------------------
  function toUsernameStage() {
    stage = 'username';
    hintEl.hidden = true;
    hintEl.textContent = '';
    conceal(pField, pInput);
    conceal(cField, cInput);
    clearError();
    updateSubmitLabel();
  }

  function toLoginStage() {
    stage = 'login';
    hintEl.hidden = true;
    hintEl.textContent = '';
    conceal(cField, cInput);          // no repeat field for an existing account
    pInput.setAttribute('autocomplete', 'current-password');
    reveal(pField);
    updateSubmitLabel();
    pInput.focus();
  }

  function toRegisterStage() {
    stage = 'register';
    hintEl.hidden = false;
    hintEl.textContent = 'Nowe konto';
    pInput.setAttribute('autocomplete', 'new-password');
    reveal(pField);
    reveal(cField);
    updateSubmitLabel();
    pInput.focus();                   // Enter later hops to the repeat field
  }

  // ---- Actions ------------------------------------------------------------
  async function advanceFromUsername() {
    const u = uInput.value.trim().toLowerCase();
    clearError();
    if (!u) { fail('Podaj nazwę użytkownika.', uInput); return; }
    if (!USERNAME_RE.test(u)) {
      fail('Nazwa: 2–24 znaki, litery, cyfry, _ lub -.', uInput);
      return;
    }
    setBusy(true);
    let found = false;
    try {
      found = await exists(u);
    } catch (err) {
      console.warn('[auth-screen] exists() failed', err);
      found = false;                  // treat as new account; register() still guards
    }
    setBusy(false);
    if (found) toLoginStage();
    else toRegisterStage();
  }

  async function doLogin() {
    const u = uInput.value.trim().toLowerCase();
    const p = pInput.value;
    clearError();
    if (!p) { fail('Podaj hasło.', pInput); return; }
    setBusy(true);
    let res;
    try {
      res = await login(u, p);
    } catch (err) {
      console.error('[auth-screen] login threw', err);
      res = { ok: false, error: 'Coś poszło nie tak. Spróbuj ponownie.' };
    }
    setBusy(false);
    if (res && res.ok) succeed();
    else fail(res && res.error, pInput);
  }

  async function doRegister() {
    const u = uInput.value.trim().toLowerCase();
    const p = pInput.value;
    const c = cInput.value;
    clearError();
    if (p.length < 4) { fail('Hasło musi mieć min. 4 znaki.', pInput); return; }
    if (p !== c) {
      // Keep the first field, only clear + refocus the mismatched repeat.
      showError('Hasła się nie zgadzają.');
      shake();
      bus.emit('sound:play', { name: 'deny' });
      cInput.value = '';
      cInput.focus();
      return;
    }
    setBusy(true);
    let res;
    try {
      res = await register(u, p);
    } catch (err) {
      console.error('[auth-screen] register threw', err);
      res = { ok: false, error: 'Nie udało się założyć konta — spróbuj ponownie.' };
    }
    setBusy(false);
    if (res && res.ok) succeed();
    else fail(res && res.error, pInput);
  }

  // ---- Wiring -------------------------------------------------------------
  const form = card; // the card IS the <form>

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy || done) return;
    // If the caret is back in the username field, re-evaluate it (the user edited
    // the name after advancing) — otherwise run the current stage's action.
    if (stage === 'username' || document.activeElement === uInput) {
      advanceFromUsername();
    } else if (stage === 'login') {
      doLogin();
    } else if (stage === 'register') {
      doRegister();
    }
  });

  // Register: Enter in HASŁO hops focus to POWTÓRZ HASŁO instead of submitting, so
  // the last field is always the one that submits (contract: focus hops, no clicks).
  pInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (stage === 'register') {
      e.preventDefault();
      cInput.focus();
    }
  });

  // Editing the username after advancing rewinds the flow cleanly.
  uInput.addEventListener('input', () => {
    if (stage !== 'username') toUsernameStage();
  });

  // ---- Go -----------------------------------------------------------------
  updateSubmitLabel();
  requestAnimationFrame(() => { try { uInput.focus(); } catch { /* ignore */ } });
}
