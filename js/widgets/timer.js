// js/widgets/timer.js — TIMER / STOPER widget.
// Owns: timerDef() factory, an exported timerControl handle (start/stop the
// countdown from the tool router without touching window), and async init().
// Two tabs: TIMER (countdown ring) and STOPER (count-up with laps).
//
// Math is timestamp-based (no drift); display is rAF-driven and paused when the
// widget unmounts or the tab is hidden. Optional accent '#ffd166' appears ONLY
// on the progress ring when < 10s remain — and only inside .widget-body.
//
// Contract honored:
//   - export async function init()
//   - export function timerDef()
//   - export const timerControl = { start(seconds,label), stop() }
//   - render(bodyEl, ctx) returns a cleanup fn (cancels rAF, unhooks state).

import { defineWidget } from './widget-base.js';
import { bus } from '../core/event-bus.js';

// Accent for the warning ring lives in css/widgets.css (--tmr-accent, scoped to
// .widget-body). We reference the CSS var so the literal has a single home.
const ACCENT = 'var(--tmr-accent)';
const MAX_LAPS = 5;
const WARN_MS = 10 * 1000; // ring turns accent under 10s left

// ---- Shared model -----------------------------------------------------------
// One live instance is bound while the widget is mounted. timerControl proxies
// to it; when nothing is mounted, start() still works by (re)adding the widget
// through the router, then the router calls start again — but to be safe the
// model persists across mounts so a start_timer fired before mount is honored.
const model = {
  mode: 'timer',          // 'timer' | 'stopwatch'
  // timer
  duration: 5 * 60 * 1000, // ms total (default 5:00)
  remaining: 5 * 60 * 1000,
  running: false,
  endAt: 0,               // wall-clock ms when it should hit 0
  label: '',
  finished: false,
  // stopwatch
  swElapsed: 0,           // accumulated ms while paused
  swRunning: false,
  swStartAt: 0,
  laps: []                // [ms,...] most-recent first, max MAX_LAPS
};

// The mounted view registers a repaint hook here; null when unmounted.
let repaint = null;
// The mounted view registers a flash hook here (ring done animation).
let flashDone = null;

function timerRemainingMs() {
  if (model.running) return Math.max(0, model.endAt - Date.now());
  return model.remaining;
}

function swElapsedMs() {
  if (model.swRunning) return model.swElapsed + (Date.now() - model.swStartAt);
  return model.swElapsed;
}

function fmtClock(ms) {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  // v4 #7: hour-long timers read as H:MM:SS; below an hour stays MM:SS.
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function fmtStopwatch(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const cs = Math.floor((ms % 1000) / 10);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') +
    '.' + String(cs).padStart(2, '0');
}

// ---- Countdown control (used by tool router + UI buttons) -------------------
function timerStart(seconds, label) {
  dismissAlarm();               // a new countdown always silences a ringing alarm
  model.mode = 'timer';
  if (typeof seconds === 'number' && seconds > 0) {
    model.duration = Math.round(seconds * 1000);
    model.remaining = model.duration;
  }
  if (typeof label === 'string') model.label = label;
  model.finished = false;
  model.endAt = Date.now() + model.remaining;
  model.running = true;
  if (repaint) repaint(true); // force a view rebuild (tab/label may have changed)
}

function timerPause() {
  if (!model.running) return;
  model.remaining = timerRemainingMs();
  model.running = false;
  if (repaint) repaint();
}

function timerReset() {
  dismissAlarm();
  model.running = false;
  model.finished = false;
  model.remaining = model.duration;
  if (repaint) repaint();
}

function timerStop() {
  // Full stop: halt and reset to the configured duration.
  timerReset();
}

function timerAdd(seconds) {
  const add = seconds * 1000;
  model.duration = Math.max(1000, model.duration + add);
  if (model.running) {
    model.endAt += add;
  } else {
    model.remaining = Math.max(0, model.remaining + add);
  }
  model.finished = false;
  if (repaint) repaint();
}

function onTimerHitZero() {
  model.running = false;
  model.remaining = 0;
  model.finished = true;
  // v4 #5+#6: full-screen alarm with the REAL ringtone (looped) + ODRZUĆ.
  showAlarmOverlay();
  if (flashDone) flashDone();
  if (repaint) repaint();
}

// ---- Full-screen alarm (v4 #5+#6) -------------------------------------------
// When the countdown hits zero the whole screen takes over: big "CZAS MINĄŁ",
// the timer label, and one ODRZUĆ button. Jurek's Timer.m4r (vendored as
// assets/audio/timer-alarm.m4a) LOOPS until dismissed; if the audio can't play
// (no gesture yet / codec) we fall back to the old one-shot cue — honest, and
// the overlay still shows. ESC dismisses too.
const ALARM_URL = 'assets/audio/timer-alarm.m4a';
let alarmEl = null;
let alarmAudio = null;

function dismissAlarm() {
  if (alarmAudio) { try { alarmAudio.pause(); alarmAudio.src = ''; } catch (_e) { /* dead */ } alarmAudio = null; }
  if (alarmEl) { try { alarmEl.remove(); } catch (_e) { /* gone */ } alarmEl = null; }
  window.removeEventListener('keydown', onAlarmKey, true);
}

function onAlarmKey(e) {
  if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); dismissAlarm(); }
}

function showAlarmOverlay(labelOverride) {
  dismissAlarm(); // never stack two alarms
  const shownLabel = (labelOverride != null && String(labelOverride).trim())
    ? String(labelOverride).trim() : model.label;
  const wrap = document.createElement('div');
  wrap.className = 'tmr-alarm';
  Object.assign(wrap.style, {
    position: 'fixed', inset: '0', zIndex: '95', display: 'flex',
    flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 'var(--space-5)', background: 'var(--scrim)',
    backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)'
  });

  const title = document.createElement('div');
  title.textContent = 'CZAS MINĄŁ';
  Object.assign(title.style, {
    fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xl)',
    letterSpacing: 'var(--tracking-wide)', color: 'var(--fg)'
  });

  const sub = document.createElement('div');
  sub.textContent = shownLabel ? shownLabel : '';
  Object.assign(sub.style, {
    fontFamily: 'var(--font-mono)', fontSize: 'var(--text-lg)',
    letterSpacing: 'var(--tracking)', color: 'var(--fg-dim)'
  });
  if (!shownLabel) sub.style.display = 'none';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'ODRZUĆ';
  Object.assign(btn.style, {
    appearance: 'none', cursor: 'pointer', background: 'var(--fg)',
    color: 'var(--bg)', border: '0', borderRadius: 'var(--glass-radius-sm)',
    fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)',
    letterSpacing: 'var(--tracking-wide)', padding: 'var(--space-3) var(--space-7)'
  });
  btn.addEventListener('click', dismissAlarm);

  wrap.append(title, sub, btn);
  document.body.appendChild(wrap);
  alarmEl = wrap;
  window.addEventListener('keydown', onAlarmKey, true);
  try { btn.focus(); } catch (_e) { /* best-effort */ }

  alarmAudio = new Audio(ALARM_URL);
  alarmAudio.loop = true;                    // rings until ODRZUĆ (v4 #5)
  alarmAudio.play().catch(() => {
    bus.emit('sound:play', { name: 'timer-done' });  // honest fallback cue
  });
}

// ---- Named concurrent timers (v4-f #6) --------------------------------------
// Independent of the ring timer above: many can run at once, each keyed by label,
// each firing its OWN full-screen alarm (reusing showAlarmOverlay). Ephemeral —
// they live in memory (a page reload clears them), which is fine for kitchen-scale
// timers ("herbata 3 min", "pizza 12 min").
const namedTimers = new Map();   // key -> {label, endAt, handle}
function nkey(label) { return String(label || '').toLowerCase().trim() || ('timer-' + (namedTimers.size + 1)); }

function startNamedTimer(seconds, label) {
  const sec = Math.round(Number(seconds) || 0);
  if (!(sec > 0)) return { ok: false, error: 'podaj dodatni czas' };
  if (sec > 24 * 3600) return { ok: false, error: 'max 24 godziny' };
  const key = nkey(label);
  const prev = namedTimers.get(key);
  if (prev) clearTimeout(prev.handle);
  const lbl = String(label || '').trim();
  const handle = setTimeout(() => {
    namedTimers.delete(key);
    showAlarmOverlay(lbl || 'Minutnik');
    bus.emit('toast', { text: '⏰ Minęło: ' + (lbl || 'minutnik'), kind: 'info' });
  }, sec * 1000);
  namedTimers.set(key, { label: lbl, endAt: Date.now() + sec * 1000, handle });
  return { ok: true, label: lbl, seconds: sec };
}
function listNamedTimers() {
  const now = Date.now();
  return [...namedTimers.values()]
    .map((t) => ({ label: t.label || '(bez nazwy)', remaining_sec: Math.max(0, Math.round((t.endAt - now) / 1000)) }))
    .sort((a, b) => a.remaining_sec - b.remaining_sec);
}
function cancelNamedTimer(label) {
  const key = nkey(label);
  let t = namedTimers.get(key);
  if (!t) {  // fuzzy: first whose label includes the query
    const q = String(label || '').toLowerCase().trim();
    for (const [k, v] of namedTimers) { if ((v.label || '').toLowerCase().includes(q)) { t = v; namedTimers.delete(k); break; } }
    if (t) { clearTimeout(t.handle); return { ok: true, cancelled: t.label }; }
    return { ok: false, error: 'nie mam minutnika „' + String(label || '').trim() + '"' };
  }
  clearTimeout(t.handle);
  namedTimers.delete(key);
  return { ok: true, cancelled: t.label };
}

// Public handle for the tool router (import { timerControl } from './timer.js').
export const timerControl = {
  start(seconds, label) { timerStart(seconds, label); },
  stop() { timerStop(); },
  startNamed(seconds, label) { return startNamedTimer(seconds, label); },
  listNamed() { return listNamedTimers(); },
  cancelNamed(label) { return cancelNamedTimer(label); }
};

// ---- Stopwatch control ------------------------------------------------------
function swStart() {
  if (model.swRunning) return;
  model.swRunning = true;
  model.swStartAt = Date.now();
  if (repaint) repaint();
}
function swPause() {
  if (!model.swRunning) return;
  model.swElapsed = swElapsedMs();
  model.swRunning = false;
  if (repaint) repaint();
}
function swReset() {
  model.swRunning = false;
  model.swElapsed = 0;
  model.laps = [];
  if (repaint) repaint();
}
function swLap() {
  model.laps.unshift(swElapsedMs());
  if (model.laps.length > MAX_LAPS) model.laps.length = MAX_LAPS;
  if (repaint) repaint();
}

// ---- View markup ------------------------------------------------------------
function ringSVG() {
  // viewBox-based ring; fluid via CSS (width/height 100%). r=45 in a 100 box.
  return '<svg class="tmr-ring-svg" viewBox="0 0 100 100" aria-hidden="true">' +
    '<circle class="tmr-ring-track" cx="50" cy="50" r="45"/>' +
    '<circle class="tmr-ring-prog" cx="50" cy="50" r="45" ' +
    'transform="rotate(-90 50 50)"/>' +
    '</svg>';
}

function tabsMarkup() {
  const t = model.mode === 'timer' ? ' is-active' : '';
  const s = model.mode === 'stopwatch' ? ' is-active' : '';
  return '<div class="tmr-tabs">' +
    `<button class="tmr-tab${t}" data-act="tab-timer">TIMER</button>` +
    `<button class="tmr-tab${s}" data-act="tab-sw">STOPER</button>` +
    '</div>';
}

function timerBodyMarkup() {
  const label = model.label
    ? `<div class="tmr-label">${escapeHTML(model.label)}</div>` : '';
  return '<div class="tmr-panel tmr-panel-timer">' +
    '<div class="tmr-ring">' +
      ringSVG() +
      '<div class="tmr-ring-center">' +
        '<div class="tmr-time" data-role="time">--:--</div>' +
        label +
      '</div>' +
    '</div>' +
    '<div class="tmr-controls">' +
      '<button class="tmr-btn" data-act="add1">+1M</button>' +
      '<button class="tmr-btn" data-act="add5">+5M</button>' +
      '<button class="tmr-btn tmr-btn-primary" data-act="toggle" data-role="toggle">START</button>' +
      '<button class="tmr-btn" data-act="reset">RESET</button>' +
    '</div>' +
  '</div>';
}

function stopwatchBodyMarkup() {
  return '<div class="tmr-panel tmr-panel-sw">' +
    '<div class="tmr-sw-time" data-role="swtime">00:00.00</div>' +
    '<div class="tmr-controls">' +
      '<button class="tmr-btn" data-act="sw-lap">MIĘDZYCZAS</button>' +
      '<button class="tmr-btn tmr-btn-primary" data-act="sw-toggle" data-role="swtoggle">START</button>' +
      '<button class="tmr-btn" data-act="sw-reset">RESET</button>' +
    '</div>' +
    '<ol class="tmr-laps" data-role="laps"></ol>' +
  '</div>';
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---- Widget definition factory ---------------------------------------------
export function timerDef() {
  return defineWidget({
    id: 'timer',
    title: 'TIMER',
    color: null, // chrome stays B&W; accent applied only on the ring via class
    size: 'md',
    render(bodyEl) {
      let alive = true;
      let rafId = 0;
      // Cached element handles (refreshed by build()); avoids per-frame
      // querySelector traversals in the hot loop.
      let els = {};
      // Laps are rebuilt (innerHTML) only when the lap set changes, not every
      // frame — tracked by this counter.
      let lastLapCount = -1;

      // Build the whole panel (called on mount + when the tab/label changes).
      function build() {
        bodyEl.innerHTML =
          '<div class="tmr">' +
            tabsMarkup() +
            (model.mode === 'timer' ? timerBodyMarkup() : stopwatchBodyMarkup()) +
          '</div>';
        bindEvents();
        // Re-cache handles for the freshly-built DOM.
        els = {
          ring: bodyEl.querySelector('.tmr-ring'),
          time: bodyEl.querySelector('[data-role="time"]'),
          toggle: bodyEl.querySelector('[data-role="toggle"]'),
          prog: bodyEl.querySelector('.tmr-ring-prog'),
          swtime: bodyEl.querySelector('[data-role="swtime"]'),
          swtoggle: bodyEl.querySelector('[data-role="swtoggle"]'),
          laps: bodyEl.querySelector('[data-role="laps"]')
        };
        lastLapCount = -1; // force a laps rebuild on first paint after build
        ensureLoop();      // (re)start rAF if the model is actually moving
        paintOnce();       // immediate paint so a paused/idle timer still shows
      }

      function bindEvents() {
        bodyEl.querySelectorAll('[data-act]').forEach((el) => {
          el.addEventListener('click', onClick);
        });
      }

      function onClick(e) {
        const act = e.currentTarget.getAttribute('data-act');
        switch (act) {
          case 'tab-timer': model.mode = 'timer'; build(); break;
          case 'tab-sw': model.mode = 'stopwatch'; build(); break;
          case 'add1': timerAdd(60); break;
          case 'add5': timerAdd(300); break;
          case 'toggle':
            if (model.finished) { timerReset(); }
            else if (model.running) { timerPause(); }
            else {
              // resume / start from current remaining
              model.finished = false;
              model.endAt = Date.now() + model.remaining;
              model.running = true;
            }
            break;
          case 'reset': timerReset(); break;
          case 'sw-toggle': model.swRunning ? swPause() : swStart(); break;
          case 'sw-lap': if (model.swRunning) swLap(); break;
          case 'sw-reset': swReset(); break;
        }
        // A click may have started/stopped motion or changed labels: repaint
        // once and (re)arm the loop if now running.
        paintOnce();
        ensureLoop();
      }

      // Register model hooks so external control (tool router) repaints us.
      // repaint(true) rebuilds; repaint() just paints once + re-evaluates the
      // loop (start_timer/stop_timer arrive here).
      repaint = (rebuild) => {
        if (rebuild) { build(); return; }
        paintOnce();
        ensureLoop();
      };
      flashDone = () => {
        const ring = els.ring || bodyEl.querySelector('.tmr-ring');
        if (!ring) return;
        ring.classList.remove('tmr-flash');
        // force reflow so re-adding the class restarts the animation
        void ring.offsetWidth;
        ring.classList.add('tmr-flash');
      };

      function paintTimer() {
        const remaining = timerRemainingMs();
        if (model.running && remaining <= 0 && !model.finished) {
          onTimerHitZero();
          return;
        }
        if (els.time) els.time.textContent = model.finished ? '00:00' : fmtClock(remaining);

        if (els.toggle) {
          els.toggle.textContent = model.finished
            ? 'RESET' : (model.running ? 'PAUZA' : 'START');
        }

        // Ring progress: fraction remaining -> dashoffset. Circumference = 2πr.
        if (els.prog) {
          const C = 2 * Math.PI * 45;
          const frac = model.duration > 0
            ? Math.max(0, Math.min(1, remaining / model.duration)) : 0;
          els.prog.style.strokeDasharray = String(C);
          els.prog.style.strokeDashoffset = String(C * (1 - frac));
          // accent under 10s (only literal color allowed, inside body)
          const warn = model.running && remaining <= WARN_MS && remaining > 0;
          els.prog.style.stroke = warn ? ACCENT : 'var(--fg)';
        }
      }

      function paintStopwatch() {
        if (els.swtime) els.swtime.textContent = fmtStopwatch(swElapsedMs());
        if (els.swtoggle) els.swtoggle.textContent = model.swRunning ? 'PAUZA' : 'START';
        // Rebuild the laps list ONLY when the lap set actually changed — not on
        // every frame (that was a per-frame innerHTML reparse in the hot loop).
        if (els.laps && model.laps.length !== lastLapCount) {
          lastLapCount = model.laps.length;
          els.laps.innerHTML = model.laps.map((ms, i) => {
            const n = model.laps.length - i;
            return `<li class="tmr-lap"><span>${String(n).padStart(2, '0')}</span>` +
              `<span>${fmtStopwatch(ms)}</span></li>`;
          }).join('');
        }
      }

      // A single paint of the current tab (no rAF re-arm).
      function paintOnce() {
        if (!alive) return;
        if (model.mode === 'timer') paintTimer();
        else paintStopwatch();
      }

      // Is anything actually animating right now? Only a live countdown or a live
      // stopwatch needs per-frame repaints. A paused/reset timer changes at most
      // at 1 Hz and is repainted on demand via repaint()/clicks, so we don't burn
      // a 60fps loop next to the orb when nothing is counting.
      function isMoving() {
        return model.running || model.swRunning;
      }

      // rAF loop: only runs while something is moving AND the tab is visible.
      function tick() {
        if (!alive) return;
        // Pause painting while hidden. Keep the loop alive (without touching the
        // DOM) only while something is still counting, so it resumes instantly on
        // return; if nothing is moving, stop entirely. visibilitychange re-arms.
        if (document.hidden) {
          rafId = isMoving() ? requestAnimationFrame(tick) : 0;
          return;
        }
        paintOnce();
        if (isMoving()) {
          rafId = requestAnimationFrame(tick);
        } else {
          rafId = 0; // settle: stop the loop until motion resumes
        }
      }

      // Start the loop if motion is happening and it isn't already running.
      function ensureLoop() {
        if (!alive) return;
        if (isMoving() && !rafId) {
          rafId = requestAnimationFrame(tick);
        }
      }

      // On returning to a visible tab, force an immediate repaint (the loop, if
      // running, was re-arming without painting while hidden).
      function onVisibility() {
        if (!document.hidden) { paintOnce(); ensureLoop(); }
      }
      document.addEventListener('visibilitychange', onVisibility);

      build();

      // cleanup: stop rAF, drop the visibility listener, release model hooks.
      return () => {
        alive = false;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        document.removeEventListener('visibilitychange', onVisibility);
        if (repaint) repaint = null;
        if (flashDone) flashDone = null;
      };
    }
  });
}

// Routing lives in clock.js; nothing to wire here.
export async function init() {
  // Idempotent no-op.
}
