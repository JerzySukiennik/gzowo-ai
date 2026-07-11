// js/avatar/avatar.js — THE AVATAR (clean rewrite, 2026-07-10, v4 #3).
// A glowing white GLOBE on transparent black, Canvas 2D. Three behaviours:
//   • idle/showing  — a breathing volumetric sphere crossed by slowly rotating
//                     great-circle arcs (the "globe" look Jurek approved).
//   • talking       — the sphere MELTS into a horizontal amplitude-driven
//                     waveform; at silence it stays a globe, at volume a wave.
//   • hover         — points near the cursor are pushed away (whole orb reacts).
//
// Contracts (bus/window), unchanged so the rest of the app keeps working:
//   bus 'avatar:slot'     {cx,cy,r,snap?} px -> spring target (snap=teleport, gravity)
//   bus 'state:change'    {to}            -> auth hidden | startup reveal | idle/showing/talking
//   bus 'voice:amplitude' {level,source}  -> talking wave drive ('out' 1.0, 'in' 0.4)
//   window 'pointermove'                  -> cursor repulsion
//
// Perf: ONE rAF; DPR-capped backing store; frame-skipped to ~30fps when settled;
// full clearRect each frame; a cached radial-gradient glow; zero per-frame heap
// allocations in the hot path. Grayscale ink (#fff); the ui-ux theme inverts the
// whole canvas in CSS. init() is idempotent and never throws.

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';

// ---- Tunables ---------------------------------------------------------------
const DPR_CAP = 1.5;
const SLOT_STIFF = 0.14;        // spring toward the layout slot
const MOUSE_LERP = 0.18;        // cursor follow easing
const REPEL_RADIUS = 0.9;       // cursor influence radius (in orb-radius units)
const REPEL_STRENGTH = 0.5;     // push magnitude (orb-radius units)
const BREATH_AMP = 0.035;       // idle radius breathing (±3.5%)
const BREATH_SPEED = 1.1;       // rad/s
const WAVE_ATTACK = 0.28;       // talk-morph rise per frame
const WAVE_RELEASE = 0.05;      // talk-morph fall per frame
const AMP_ATTACK = 0.4;
const AMP_RELEASE = 0.08;
const AMP_DECAY = 0.9;
const REVEAL_MS = 900;
const IDLE_FPS = 30;
const RESIZE_DEBOUNCE = 120;
const TWO_PI = Math.PI * 2;

const N_RIM = 120;              // silhouette points
const N_WAVE = 128;            // waveform samples
// Great-circle arcs: [tiltBase, flatten k, tilt-drift rad/s, spin rad/s]
const ARCS = [
  [0.20, 0.34, 0.05, 0.22],
  [2.85, 0.52, -0.04, -0.17],
  [0.85, 0.24, 0.07, 0.19],
  [5.75, 0.62, -0.06, -0.25]
];
const ARC_SAMPLES = 46;

let inited = false;

export async function init() {
  if (inited) return;
  inited = true;

  const canvas = document.getElementById('avatar-canvas');
  if (!canvas) { console.warn('[avatar] no #avatar-canvas'); return; }
  let ctx = null;
  try { ctx = canvas.getContext('2d'); } catch (_e) { ctx = null; }
  if (!ctx) { console.warn('[avatar] Canvas 2D unavailable'); return; }

  // ---- Cached glow sprite (white core -> transparent), scaled per frame -----
  const glow = document.createElement('canvas');
  glow.width = glow.height = 128;
  {
    const g = glow.getContext('2d');
    const rg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    rg.addColorStop(0, 'rgba(255,255,255,0.42)');
    rg.addColorStop(0.35, 'rgba(255,255,255,0.16)');
    rg.addColorStop(0.7, 'rgba(255,255,255,0.04)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, 128, 128);
  }
  // Cached body sprite (filled milky sphere with a brighter rim shell).
  const body = document.createElement('canvas');
  body.width = body.height = 256;
  {
    const b = body.getContext('2d');
    const rg = b.createRadialGradient(128, 128, 0, 128, 128, 128);
    rg.addColorStop(0, 'rgba(255,255,255,0.30)');
    rg.addColorStop(0.62, 'rgba(255,255,255,0.40)');
    rg.addColorStop(0.85, 'rgba(255,255,255,0.60)');
    rg.addColorStop(0.97, 'rgba(255,255,255,0.10)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    b.fillStyle = rg;
    b.beginPath();
    b.arc(128, 128, 128, 0, TWO_PI);
    b.fill();
  }

  // ---- Backing store ---------------------------------------------------------
  let cssW = 1, cssH = 1, dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    cssW = window.innerWidth; cssH = window.innerHeight;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#fff';
    if (typeof refreshDefaultSlot === 'function') refreshDefaultSlot();
  }

  // ---- Slot (target center/radius) ------------------------------------------
  function defaultRatio() {
    let r = 0.27;
    try {
      const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--avatar-idle-ratio'));
      if (Number.isFinite(n) && n > 0) r = n;
    } catch (_e) { /* keep */ }
    return r;
  }
  let slotFromLayout = false;   // true once the layout engine sends a real slot
  const target = { cx: cssW / 2, cy: cssH / 2, r: Math.min(cssW, cssH) * defaultRatio() / 2 };
  const cur = { cx: target.cx, cy: target.cy, r: target.r };
  // Re-derive the centered home from the viewport until the layout takes over
  // (keeps the orb sane after a resize, and recovers from a 0×0 boot viewport).
  function refreshDefaultSlot() {
    if (slotFromLayout) return;
    target.cx = cssW / 2; target.cy = cssH / 2;
    target.r = Math.min(cssW, cssH) * defaultRatio() / 2;
    if (cur.r < 3) { cur.cx = target.cx; cur.cy = target.cy; cur.r = target.r; }
  }
  resize();   // now safe: refreshDefaultSlot is defined, so the initial sizing recomputes the home

  // ---- Dynamic state ---------------------------------------------------------
  let talking = false;          // in the talking UI state
  let wave = 0;                 // 0 globe -> 1 waveform (eased)
  let ampRaw = 0, amp = 0;      // smoothed voice amplitude
  let mx = -1e6, my = -1e6, mtx = -1e6, mty = -1e6;   // mouse (lerped / target)
  let reveal = 0, revealTarget = 0, revealStart = 0;
  let awakeUntil = 0;
  const wakePulse = () => { awakeUntil = performance.now() + 300; };

  // Per-frame shared scalars (avoid closures/alloc in the point loop).
  let fcx = cur.cx, fcy = cur.cy, fr = cur.r, finv = 1 / fr;
  let mlx = 0, mly = 0, hasMouse = false;
  let _x = 0, _y = 0;
  function repel(x, y) {
    if (!hasMouse) { _x = x; _y = y; return; }
    const dx = (x - fcx) * finv - mlx, dy = (y - fcy) * finv - mly;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 1e-4 && d < REPEL_RADIUS) {
      const f = (1 - d / REPEL_RADIUS) * REPEL_STRENGTH / d;
      _x = x + dx * f * fr; _y = y + dy * f * fr;
    } else { _x = x; _y = y; }
  }

  // ---- Events ----------------------------------------------------------------
  const unsubs = [];
  unsubs.push(bus.on('avatar:slot', (p) => {
    if (!p) return;
    slotFromLayout = true;   // the layout owns positioning from here on
    if (typeof p.cx === 'number') target.cx = p.cx;
    if (typeof p.cy === 'number') target.cy = p.cy;
    if (typeof p.r === 'number') target.r = Math.max(2, p.r);
    if (p.snap) { cur.cx = target.cx; cur.cy = target.cy; cur.r = target.r; }
    wakePulse();
  }));
  unsubs.push(bus.on('state:change', ({ to }) => {
    talking = (to === 'talking');
    if (to === 'startup') { revealTarget = 1; revealStart = performance.now(); }
    else if (to === 'auth') { revealTarget = 0; }
    wakePulse();
  }));
  unsubs.push(bus.on('voice:amplitude', (p) => {
    if (!p) return;
    const level = Math.max(0, Math.min(1, p.level || 0));
    ampRaw = Math.max(ampRaw, level * (p.source === 'in' ? 0.4 : 1));
    wakePulse();
  }));
  const onMove = (e) => { mtx = e.clientX; mty = e.clientY; wakePulse(); };
  window.addEventListener('pointermove', onMove, { passive: true });
  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { resize(); wakePulse(); }, RESIZE_DEBOUNCE); }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastRender = 0; wakePulse(); } });

  // Boot state.
  if (state.ui === 'talking') talking = true;
  if (state.ui !== 'auth') { reveal = 1; revealTarget = 1; }

  // ---- Draw helpers ----------------------------------------------------------
  function drawArcs(alpha, t) {
    if (alpha <= 0.004) return;
    const rr = fr * 0.985;
    const sc = Math.max(0.5, fr / 150);
    for (let a = 0; a < ARCS.length; a++) {
      const [tilt0, k, drift, spin] = ARCS[a];
      const psi = tilt0 + t * drift;
      const cosP = Math.cos(psi), sinP = Math.sin(psi);
      const t0 = t * spin;
      // Build the ellipse path once (with cursor repel), stroke it 2× for glow.
      ctx.beginPath();
      for (let s = 0; s <= ARC_SAMPLES; s++) {
        const ang = t0 + TWO_PI * (s / ARC_SAMPLES);
        const ex = Math.cos(ang) * rr, ey = Math.sin(ang) * k * rr;
        repel(fcx + ex * cosP - ey * sinP, fcy + ex * sinP + ey * cosP);
        if (s === 0) ctx.moveTo(_x, _y); else ctx.lineTo(_x, _y);
      }
      ctx.globalAlpha = alpha * 0.28; ctx.lineWidth = 5 * sc; ctx.stroke();
      ctx.globalAlpha = alpha * 0.9; ctx.lineWidth = 1.8 * sc; ctx.stroke();
    }
  }

  function drawGlobe(t) {
    // 1. glow
    const gr = fr * 1.7;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = reveal * 0.6 * (1 - wave);
    ctx.drawImage(glow, fcx - gr, fcy - gr, gr * 2, gr * 2);
    // 2. body
    ctx.globalAlpha = reveal * (1 - wave);
    ctx.drawImage(body, fcx - fr, fcy - fr, fr * 2, fr * 2);
    ctx.globalCompositeOperation = 'source-over';
    // 3. arcs
    drawArcs(reveal * 0.8 * (1 - wave), t);
    // 4. rim (breathing silhouette with cursor repel)
    ctx.globalAlpha = reveal * (0.85 * (1 - wave) + 0.15);
    ctx.lineWidth = Math.max(2, fr / 36);
    ctx.beginPath();
    for (let i = 0; i <= N_RIM; i++) {
      const th = (i / N_RIM) * TWO_PI;
      const wob = 1 + 0.02 * Math.sin(th * 3 + t * 0.6);
      repel(fcx + Math.cos(th) * fr * wob, fcy + Math.sin(th) * fr * wob);
      if (i === 0) ctx.moveTo(_x, _y); else ctx.lineTo(_x, _y);
    }
    ctx.stroke();
  }

  function drawWave(t) {
    if (wave <= 0.004) return;
    const drive = (0.28 + amp * 1.9) * wave;   // wave height (orb-radius units)
    const lw = Math.max(2, fr / 34);
    // Three layered ribbons for depth; the main one is brightest.
    const ribs = [[1, 2.2, 1.0, 0], [0.5, 3.6, 1.6, 1.3], [0.34, 5.0, 2.3, 2.6]];
    for (let r = 0; r < ribs.length; r++) {
      const [A, freq, speed, ph] = ribs[r];
      ctx.globalAlpha = reveal * wave * (r === 0 ? 0.95 : 0.4);
      ctx.lineWidth = lw * (r === 0 ? 1 : 0.7);
      ctx.beginPath();
      for (let i = 0; i <= N_WAVE; i++) {
        const x = (i / N_WAVE) * cssW;
        const dxc = x - fcx;
        const env = Math.exp(-Math.abs(dxc) * (0.5 * finv));
        const y = fcy + env * A * drive * Math.sin(dxc * finv * freq - t * speed + ph) * fr;
        repel(x, y);
        if (i === 0) ctx.moveTo(_x, _y); else ctx.lineTo(_x, _y);
      }
      ctx.stroke();
    }
  }

  // ---- Loop ------------------------------------------------------------------
  const t0 = performance.now();
  let lastRender = 0;
  function active(now) {
    return Math.abs(cur.cx - target.cx) > 0.3 || Math.abs(cur.cy - target.cy) > 0.3 ||
      Math.abs(cur.r - target.r) > 0.3 || Math.abs(reveal - revealTarget) > 0.001 ||
      wave > 0.02 || (talking ? true : false) || amp > 0.02 || ampRaw > 0.02 ||
      Math.abs(mx - mtx) > 0.5 || Math.abs(my - mty) > 0.5 || now < awakeUntil;
  }

  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    if (document.hidden) return;
    if (!active(now) && now - lastRender < 1000 / IDLE_FPS) return;
    lastRender = now;
    const t = (now - t0) / 1000;

    // springs
    cur.cx += (target.cx - cur.cx) * SLOT_STIFF;
    cur.cy += (target.cy - cur.cy) * SLOT_STIFF;
    cur.r += (target.r - cur.r) * SLOT_STIFF;

    // amplitude smoothing
    if (ampRaw > amp) amp += (ampRaw - amp) * AMP_ATTACK; else amp += (ampRaw - amp) * AMP_RELEASE;
    ampRaw *= AMP_DECAY;

    // talk-morph: only while talking AND loud enough; silence keeps the globe.
    const waveTarget = talking ? Math.min(1, Math.max(0, (amp - 0.05) * 2.6)) : 0;
    if (waveTarget > wave) wave += (waveTarget - wave) * WAVE_ATTACK;
    else wave += (waveTarget - wave) * WAVE_RELEASE;

    // reveal
    if (revealTarget > 0 && reveal < 1) reveal = 1 - Math.pow(1 - Math.min(1, (now - revealStart) / REVEAL_MS), 3);
    else if (revealTarget === 0) reveal = 0;

    // mouse lerp
    if (mtx > -1e5) {
      if (mx < -1e5) { mx = mtx; my = mty; }
      mx += (mtx - mx) * MOUSE_LERP; my += (mty - my) * MOUSE_LERP;
    }

    // per-frame scalars
    const breath = 1 + BREATH_AMP * Math.sin(t * BREATH_SPEED);
    fcx = cur.cx; fcy = cur.cy;
    fr = Math.max(2, cur.r * breath * (0.6 + 0.4 * reveal));
    finv = 1 / fr;
    hasMouse = mx > -1e5;
    if (hasMouse) { mlx = (mx - fcx) * finv; mly = (my - fcy) * finv; }

    ctx.clearRect(0, 0, cssW, cssH);
    if (reveal < 0.003 && revealTarget < 0.5) return;

    drawGlobe(t);
    drawWave(t);
    ctx.globalAlpha = 1;
  }
  requestAnimationFrame(frame);
  void unsubs;
}
