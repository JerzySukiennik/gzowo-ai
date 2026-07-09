// js/avatar/avatar.js — THE AVATAR. Face of Gzowo AI v2.
//
// A single living, breathing WHITE loop on transparent BLACK, rendered entirely in
// Canvas 2D (no WebGL, no shaders, no libraries). The v1 three.js orb is gone; this
// is the same soul in 2D: an irregular hand-drawn circle that breathes while idle and
// MELTS into a horizontal, amplitude-driven sound-wave that spans the full canvas
// width while Gzowo speaks — then relaxes back.
//
// Contracts consumed (see js/core/*):
//   bus 'avatar:slot'      {cx,cy,r}  px -> target center/radius (spring-lerp, never teleport)
//   bus 'state:change'     {from,to}  -> 'auth' hidden | 'startup' REVEAL | idle/showing orb | talking wave
//   bus 'voice:amplitude'  {level,source} -> drives the talking wave ('out' 1.0, 'in' 0.35)
//   window 'pointermove'   -> points near the cursor are repelled
//
// Degrades honestly: if Canvas 2D is unavailable, warns and returns — the app keeps
// working without the avatar. init() is idempotent and never throws.
//
// Perf laws honored: ONE rAF loop; 60fps while active, frame-skipped to 30fps when
// everything has settled; full clearRect each frame; a PRE-RENDERED radial-gradient
// glow sprite (composited with 'lighter') instead of per-frame ctx.filter/shadowBlur
// (both dog-slow on the Intel i9 + Radeon 5500M target); and ZERO heap allocations in
// the frame loop — every point is computed from scalar locals and streamed straight
// into the path (no per-frame arrays/objects/strings). Grayscale only; pure white max,
// black stays transparent so the background grid shows through.

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';

// ---- Tunables (mirrored from the v1 orb so the "feel" is preserved) ---------
const MORPH_RATE = 4.0;          // morph units per second toward target (idle<->talking)
const AMP_ATTACK = 0.35;         // amplitude smoothing rise per frame (fast attack)
const AMP_RELEASE = 0.06;        // amplitude smoothing fall per frame (slow release)
const AMP_DECAY = 0.9;           // raw amplitude decay per frame (fresh events re-raise it)
const SLOT_STIFFNESS = 0.12;     // spring-lerp factor per frame toward the slot target
const MOUSE_LERP = 0.12;         // pointer follow easing per frame
const REPEL_STRENGTH = 0.15;     // pointer repulsion magnitude (radius units)
const REPEL_FALLOFF = 1.6;       // pointer repulsion exp() falloff
const BREATH_AMP = 0.045;        // idle breath radius modulation (~+/-4.5%, visibly alive)
const BREATH_SPEED = 0.8;        // idle breath angular speed
const REVEAL_MS = 1200;          // startup reveal duration (--t-cine)
const IDLE_FPS = 30;             // frame-skip target when fully settled
const SETTLE_EPS_PX = 0.35;      // "slot settled" threshold (px) for center
const SETTLE_EPS_R = 0.35;       // "slot settled" threshold (px) for radius
const DPR_CAP = 1.5;             // devicePixelRatio cap (backing-store resolution)
const RESIZE_DEBOUNCE = 120;     // ms

const N_FULL = 140;              // loop points at full size
const N_LOD = 90;                // loop points when small (r < LOD_RADIUS)
const LOD_RADIUS = 120;          // px radius below which LOD kicks in
const RIBBON_SAMPLES = 120;      // samples per analytic talking ribbon
const TWO_PI = Math.PI * 2;

// ---- Interior light arcs (the reference-look "crossing streaks") ------------
// Each arc is a segment of a great circle of the sphere seen in orthographic
// projection: an ellipse (semi-axes R, R*k) tilted by psi, both drifting VERY
// slowly — the sphere reads as 3D light and the idle state is never frozen.
// Arrays are module constants -> zero allocations in the frame loop.
// Each streak is a FULL ellipse (a whole great circle): it touches the rim at the
// ends of its major axis and stays inside elsewhere — exactly the reference look,
// with no arc endpoints floating loose inside the sphere.
const ARC_COUNT = 4;
const ARC_K = [0.34, 0.52, 0.24, 0.66]; // ellipse flattening (cos of view angle)
const ARC_PSI = [0.20, 2.85, 0.85, 5.75]; // base tilts ≈ +11°/−17°/+49°/−31° — horizontal flow like the reference
const ARC_ROT = [0.060, -0.045, 0.085, -0.070]; // tilt drift (rad/s) — slow, hypnotic
const ARC_SPIN = [0.22, -0.16, 0.19, -0.26]; // wobble-pattern drift along the ellipse (rad/s)
const ARC_SAMPLES_FULL = 56;
const ARC_SAMPLES_LOD = 32;
const ARC_LOD_COUNT = 3;               // arcs drawn when small

// ---- Tiny value-noise + fbm (no libs; mirrors the v1 in-shader hash) --------
function fract(x) { return x - Math.floor(x); }

// hash a 2D lattice point to [0,1). Same construction as the v1 fragment shader's
// hash21 so the silhouette wobble keeps its organic, hand-drawn character.
function hash21(px, py) {
  let x = fract(px * 123.34);
  let y = fract(py * 456.21);
  const dotv = x * (x + 45.32) + y * (y + 45.32);
  x += dotv;
  y += dotv;
  return fract(x * y);
}

// 2D value noise with smootherstep interpolation.
function vnoise(px, py) {
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = px - ix, fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash21(ix, iy);
  const b = hash21(ix + 1, iy);
  const c = hash21(ix, iy + 1);
  const d = hash21(ix + 1, iy + 1);
  const top = a + (b - a) * ux;
  const bot = c + (d - c) * ux;
  return top + (bot - top) * uy;   // -> [0,1)
}

// 3-octave fbm — soft, drifting layered noise.
function fbm(px, py) {
  let v = 0, amp = 0.5;
  for (let i = 0; i < 3; i++) {
    v += amp * vnoise(px, py);
    px = px * 2.02 + 37.1;
    py = py * 2.02 + 11.7;
    amp *= 0.5;
  }
  return v;
}

// 1D fbm on a scalar (used for the rim silhouette + irregular breath).
function fbm1(x) {
  return fbm(x, x * 0.7 + 3.3);
}

// ---- Module guard -----------------------------------------------------------
let inited = false;

/**
 * Idempotent, never-throws avatar boot. Wires the event bus + a single rAF loop.
 */
export async function init() {
  if (inited) return;
  inited = true;

  const canvas = document.getElementById('avatar-canvas');
  if (!canvas) {
    console.warn('[avatar] no #avatar-canvas found — avatar disabled.');
    return;
  }

  let ctx = null;
  try {
    ctx = canvas.getContext('2d');
  } catch (err) {
    ctx = null;
  }
  if (!ctx) {
    console.warn('[avatar] Canvas 2D unavailable — degrading honestly (app continues).');
    return;
  }

  // ---- Pre-rendered glow sprite (white core -> transparent) -----------------
  // Drawn ONCE here, scaled per frame with drawImage under globalCompositeOperation
  // 'lighter'. This replaces per-frame shadowBlur / ctx.filter, which are slow on
  // Intel + Radeon. Modest core alpha so 'lighter' lifts the center without blowing
  // out the grid behind it.
  const glow = document.createElement('canvas');
  glow.width = 160; glow.height = 160;
  {
    const gctx = glow.getContext('2d');
    const g = gctx.createRadialGradient(80, 80, 0, 80, 80, 80);
    g.addColorStop(0.0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.22, 'rgba(255,255,255,0.22)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.06)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    gctx.fillStyle = g;
    gctx.fillRect(0, 0, 160, 160);
  }

  // ---- Pre-rendered orb BODY sprite (the reference look) ---------------------
  // A volumetric white sphere: faint interior haze that brightens toward the rim,
  // plus a soft, wide rim glow built from concentric strokes of decreasing width
  // and rising alpha (a cheap gaussian). Rendered ONCE at 512px, scaled per frame —
  // zero per-frame filter/shadowBlur. BODY_R is the sphere radius inside the
  // sprite; BODY_SCALE converts the live avatar radius -> sprite draw half-size.
  const BODY_SIZE = 512, BODY_R = 200;
  const BODY_SCALE = (BODY_SIZE / 2) / BODY_R;   // 1.28 — sprite includes rim halo
  const body = document.createElement('canvas');
  body.width = BODY_SIZE; body.height = BODY_SIZE;
  {
    const bctx = body.getContext('2d');
    const c = BODY_SIZE / 2;
    // FILLED white/gray body (Jurek: the orb is the white ACCENT of the black UI,
    // not a wireframe): milky interior, brighter shell at the rim, soft aura past
    // it. Gradient radius = 1.22×R, so the rim sits at stop ≈0.82.
    const g = bctx.createRadialGradient(c, c, 0, c, c, BODY_R * 1.22);
    g.addColorStop(0.00, 'rgba(255,255,255,0.38)');
    g.addColorStop(0.60, 'rgba(255,255,255,0.48)');
    g.addColorStop(0.82, 'rgba(255,255,255,0.66)');
    g.addColorStop(0.90, 'rgba(255,255,255,0.16)');
    g.addColorStop(1.00, 'rgba(255,255,255,0)');
    bctx.fillStyle = g;
    bctx.fillRect(0, 0, BODY_SIZE, BODY_SIZE);
    // Soft rim: concentric strokes emulate a blurred bright edge.
    bctx.strokeStyle = '#fff';
    const rim = [
      [26, 0.030], [16, 0.060], [9, 0.110], [5, 0.220], [2.6, 0.420], [1.3, 0.800]
    ];
    for (const [w, a] of rim) {
      bctx.globalAlpha = a;
      bctx.lineWidth = w;
      bctx.beginPath();
      bctx.arc(c, c, BODY_R, 0, TWO_PI);
      bctx.stroke();
    }
    bctx.globalAlpha = 1;
  }

  // ---- Backing store + DPR --------------------------------------------------
  // The canvas CSS box is pinned fixed inset:0 by base.css; we only own the backing
  // store. We scale the context by dpr so ALL drawing math stays in CSS px.
  let cssW = 1, cssH = 1, dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    cssW = window.innerWidth;
    cssH = window.innerHeight;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // draw in CSS px
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#fff';                 // constant white; opacity via globalAlpha
  }
  resize();

  // ---- Slot: current + target center/radius (CSS px). Default = centered home
  // so the avatar has a sane place before the layout engine's first 'avatar:slot'. --
  function defaultSlot() {
    // Diameter ratio comes from the same token the layout engine reads, so the
    // pre-layout default never disagrees with the first real 'avatar:slot'.
    let ratio = 0.27;
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--avatar-idle-ratio');
      const n = parseFloat(raw);
      if (Number.isFinite(n) && n > 0) ratio = n;
    } catch (_e) { /* keep fallback */ }
    const r = Math.min(window.innerWidth, window.innerHeight) * (ratio / 2);
    return { cx: window.innerWidth / 2, cy: window.innerHeight / 2, r };
  }
  const target = defaultSlot();
  const cur = { cx: target.cx, cy: target.cy, r: target.r };

  // ---- Morph (0 = orb, 1 = wave) --------------------------------------------
  let morph = 0;
  let morphTarget = 0;

  // ---- Amplitude (raw peak vs. smoothed) ------------------------------------
  let ampRaw = 0;
  let ampSmoothed = 0;

  // ---- Mouse (CSS px, lerped) ; -1e6 = "no pointer yet" ---------------------
  let mouseTargetX = -1e6, mouseTargetY = -1e6;
  let mouseX = -1e6, mouseY = -1e6;

  // ---- Reveal (startup): alpha + scale 0..1 ---------------------------------
  let reveal = 0;
  let revealTarget = 0;
  let revealStart = 0;

  // ---- Idle frame-skip bookkeeping ------------------------------------------
  let lastRenderTime = 0;

  // ---- Wake window: a brief full-rate burst after any incoming event ---------
  // Declared before wiring because the wiring calls wake() during init().
  let awakeUntil = 0;
  function wake() { awakeUntil = performance.now() + 250; }

  // ---- Per-frame shared state (updated once at the top of each frame). Kept at
  // this scope so the draw helpers can read it WITHOUT per-frame closures/allocs. --
  let fcx = cur.cx, fcy = cur.cy;   // center (px)
  let frEff = cur.r;                // effective radius (breath + reveal scale)
  let finvR = 1 / frEff;            // 1 / radius
  let finvW = 0.3 * finvR;          // envelope decay coeff (px^-1), widens with amp
  let famp01 = 0.25;                // baseline+amp wave drive
  let ft = 0;                       // elapsed seconds
  let fmx = -1e6, fmy = -1e6;       // mouse (px)
  let fmlx = 0, fmly = 0;           // mouse in radius units
  let fpx = 0, fpy = 0;             // sprite parallax offset (px) — body dodges the cursor
  let morphE = 0;                   // eased morph (smoothstep) for the position melt

  // Repel scratch — module-shared out-params so repel() allocates nothing.
  let _rx = 0, _ry = 0;
  function repel(x, y) {
    if (fmx < -1e5) { _rx = x; _ry = y; return; }
    const dx = (x - fcx) * finvR - fmlx;
    const dy = (y - fcy) * finvR - fmly;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 1e-4) {
      const f = Math.exp(-d * REPEL_FALLOFF) * REPEL_STRENGTH / d;
      _rx = x + dx * f * frEff;
      _ry = y + dy * f * frEff;
    } else {
      _rx = x; _ry = y;
    }
  }

  // One analytic talking ribbon across the FULL canvas width, through the center.
  // y(x) = center + envelope(x) * A * (baseline+amp) * sin(x*freq - t*speed + phase).
  function drawRibbon(A, freq, speed, phase, alpha) {
    if (alpha <= 0.003) return;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let k = 0; k <= RIBBON_SAMPLES; k++) {
      const x = (k / RIBBON_SAMPLES) * cssW;
      const dxc = x - fcx;
      const env = Math.exp(-Math.abs(dxc) * finvW);
      const y = fcy + env * A * famp01 * Math.sin(dxc * finvR * freq - ft * speed + phase) * frEff;
      repel(x, y);
      if (k === 0) ctx.moveTo(_rx, _ry); else ctx.lineTo(_rx, _ry);
    }
    ctx.stroke();
  }

  // Interior light arcs — segments of slowly-drifting great-circle ellipses (the
  // reference look: smooth crossing streaks of light on a 3D sphere). Each arc is
  // stroked 3× (wide/faint -> thin/bright) to fake a soft glow with zero blur.
  // All parameters come from module-const arrays; the loop allocates nothing.
  function drawArcOnce(idx, samples, rr) {
    const psi = ARC_PSI[idx] + ft * ARC_ROT[idx];
    const k = ARC_K[idx];
    const t0 = ft * ARC_SPIN[idx];
    const cosP = Math.cos(psi), sinP = Math.sin(psi);
    ctx.beginPath();
    for (let s = 0; s <= samples; s++) {
      const t = t0 + TWO_PI * (s / samples);
      // Tiny radial wobble keeps the streak hand-drawn, never CAD-perfect.
      const w = 1 + (fbm1(t * 0.9 + idx * 7.3 + ft * 0.10) - 0.5) * 0.04;
      const ex = Math.cos(t) * rr * w;
      const ey = Math.sin(t) * k * rr * w;
      // Same cursor repulsion as the rim — hover bends the streaks too.
      repel(fcx + ex * cosP - ey * sinP, fcy + ex * sinP + ey * cosP);
      if (s === 0) ctx.moveTo(_rx, _ry); else ctx.lineTo(_rx, _ry);
    }
    ctx.closePath();
    ctx.stroke();
  }

  function drawArcs(count, samples, alpha) {
    if (alpha <= 0.003) return;
    const rr = frEff * 0.985;                       // major axis = rim (touch points)
    const sc = Math.max(0.35, frEff / 200);         // glow width scales with size
    for (let i = 0; i < count; i++) {
      // Three passes wide->thin emulate a soft glow around each streak.
      ctx.globalAlpha = alpha * 0.10;
      ctx.lineWidth = 8 * sc;
      drawArcOnce(i, samples, rr);
      ctx.globalAlpha = alpha * 0.30;
      ctx.lineWidth = 3.4 * sc;
      drawArcOnce(i, samples, rr);
      ctx.globalAlpha = alpha * 0.80;
      ctx.lineWidth = Math.max(1, 1.5 * sc);
      drawArcOnce(i, samples, rr);
    }
  }

  // ---- State -> morph + reveal ----------------------------------------------
  function applyState(to) {
    if (to === 'talking') {
      morphTarget = 1;                       // melt into the wave
    } else if (to === 'idle' || to === 'showing' || to === 'startup') {
      morphTarget = 0;                       // orb form
    }
    if (to === 'startup') {                  // REVEAL (replaces v1 'intro:done')
      revealTarget = 1;
      revealStart = performance.now();
    }
    // 'auth' -> stay hidden (revealTarget already 0).
    wake();
  }

  // ---- Event wiring ---------------------------------------------------------
  const unsubs = [];

  // Layout target — glide there, never teleport.
  unsubs.push(bus.on('avatar:slot', (p) => {
    if (!p) return;
    if (typeof p.cx === 'number') target.cx = p.cx;
    if (typeof p.cy === 'number') target.cy = p.cy;
    if (typeof p.r === 'number') target.r = Math.max(2, p.r);
    wake();
  }));

  // UI state changes.
  unsubs.push(bus.on('state:change', ({ to }) => applyState(to)));

  // Voice amplitude -> talking wave. 'out' (Gzowo) strong, 'in' (user) subtle.
  unsubs.push(bus.on('voice:amplitude', (p) => {
    if (!p) return;
    const level = Math.max(0, Math.min(1, p.level || 0));
    const weight = p.source === 'in' ? 0.35 : 1.0;
    ampRaw = Math.max(ampRaw, level * weight);
    wake();
  }));

  // Pointer (canvas is pointer-events:none, so listen on window).
  const onPointerMove = (e) => {
    mouseTargetX = e.clientX;
    mouseTargetY = e.clientY;
    wake();
  };
  window.addEventListener('pointermove', onPointerMove, { passive: true });

  // Resize (debounced) — re-size the backing store only.
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resize(); wake(); }, RESIZE_DEBOUNCE);
  };
  window.addEventListener('resize', onResize, { passive: true });

  // Visibility — force an immediate frame on return; the loop pauses while hidden.
  const onVisibility = () => {
    if (!document.hidden) { lastRenderTime = 0; wake(); }
  };
  document.addEventListener('visibilitychange', onVisibility);

  // Initialize morph from the state we booted into.
  applyState(state.ui);
  // Hot reload past auth -> reveal instantly (no re-run of the startup choreography).
  if (state.ui !== 'auth') { reveal = 1; revealTarget = 1; }

  // ---- Activity gate: is anything in flight this frame? ---------------------
  function isActive(now) {
    const slotMoving =
      Math.abs(cur.cx - target.cx) > SETTLE_EPS_PX ||
      Math.abs(cur.cy - target.cy) > SETTLE_EPS_PX ||
      Math.abs(cur.r - target.r) > SETTLE_EPS_R;
    const morphMoving = Math.abs(morph - morphTarget) > 0.001;
    const revealMoving = Math.abs(reveal - revealTarget) > 0.001;
    const amped = ampSmoothed > 0.02 || ampRaw > 0.02;
    const mouseMoving =
      Math.abs(mouseX - mouseTargetX) > 0.5 || Math.abs(mouseY - mouseTargetY) > 0.5;
    return slotMoving || morphMoving || revealMoving || amped || mouseMoving || now < awakeUntil;
  }

  // ---- The single render loop -----------------------------------------------
  const t0 = performance.now();
  let rafId = 0;

  function frame() {
    rafId = requestAnimationFrame(frame);
    const now = performance.now();

    // Paused entirely while the tab is hidden.
    if (document.hidden) return;

    // Frame-skip to IDLE_FPS when nothing is happening; full 60 when active.
    if (!isActive(now)) {
      if (now - lastRenderTime < 1000 / IDLE_FPS) return;
    }
    lastRenderTime = now;

    // Time advances off the wall clock so breath/noise/wave stay phase-correct
    // whether we render at 30 or 60fps.
    ft = (now - t0) / 1000;

    // --- Spring-lerp center/radius toward the slot target (never teleport) ---
    cur.cx += (target.cx - cur.cx) * SLOT_STIFFNESS;
    cur.cy += (target.cy - cur.cy) * SLOT_STIFFNESS;
    cur.r += (target.r - cur.r) * SLOT_STIFFNESS;

    // --- Morph toward target at ~MORPH_RATE/s, then smoothstep for the melt ---
    const step = MORPH_RATE / 60;
    if (morph < morphTarget) morph = Math.min(morphTarget, morph + step);
    else if (morph > morphTarget) morph = Math.max(morphTarget, morph - step);
    morphE = morph * morph * (3 - 2 * morph);

    // --- Amplitude smoothing: fast attack, slow release; raw decays each frame ---
    if (ampRaw > ampSmoothed) ampSmoothed += (ampRaw - ampSmoothed) * AMP_ATTACK;
    else ampSmoothed += (ampRaw - ampSmoothed) * AMP_RELEASE;
    ampRaw *= AMP_DECAY;

    // --- Reveal easing (ease-out cubic over REVEAL_MS) ---
    if (revealTarget > 0 && reveal < 1) {
      const p = Math.min(1, (now - revealStart) / REVEAL_MS);
      reveal = 1 - Math.pow(1 - p, 3);
    } else if (revealTarget === 0) {
      reveal = 0;
    }

    // --- Mouse lerp ---
    if (mouseTargetX > -1e5) {
      if (mouseX < -1e5) { mouseX = mouseTargetX; mouseY = mouseTargetY; }
      mouseX += (mouseTargetX - mouseX) * MOUSE_LERP;
      mouseY += (mouseTargetY - mouseY) * MOUSE_LERP;
    }

    // Always clear (transparent) so the grid shows through.
    ctx.clearRect(0, 0, cssW, cssH);
    // Hidden during auth (and the first invisible reveal frames are cheap).
    if (reveal < 0.002 && revealTarget < 0.5) return;

    // --- Derive per-frame draw state ---
    // Irregular breathing: a dominant slow sine + a slower noise wobble.
    const breath = 1 + BREATH_AMP * (0.72 * Math.sin(ft * BREATH_SPEED) + 0.28 * (fbm1(ft * 0.13) * 2 - 1));
    fcx = cur.cx;
    fcy = cur.cy;
    frEff = Math.max(2, cur.r * breath * reveal);   // reveal also scales (alpha+scale 0->1)
    finvR = 1 / frEff;
    const ampC = Math.min(1, ampSmoothed);
    finvW = (0.55 - ampC * 0.3) * finvR;            // envelope widens as amp rises
    famp01 = 0.25 + ampC;                           // baseline motion even when quiet
    fmx = mouseX; fmy = mouseY;
    fpx = 0; fpy = 0;
    if (fmx > -1e5) {
      fmlx = (fmx - fcx) * finvR; fmly = (fmy - fcy) * finvR;
      // Interior parallax: the filled body dodges the cursor with the same
      // exp falloff as the point repulsion, so the WHOLE orb reacts to hover.
      const md = Math.sqrt(fmlx * fmlx + fmly * fmly);
      if (md > 1e-4) {
        const f = Math.exp(-md * REPEL_FALLOFF) * REPEL_STRENGTH * 0.6;
        fpx = (-fmlx / md) * f * frEff;
        fpy = (-fmly / md) * f * frEff;
      }
    }

    // LOD off the settled radius (stable — doesn't flicker during reveal/breath).
    const small = cur.r < LOD_RADIUS;
    const N = small ? N_LOD : N_FULL;
    const ARCS = small ? ARC_LOD_COUNT : ARC_COUNT;
    const ARC_S = small ? ARC_SAMPLES_LOD : ARC_SAMPLES_FULL;

    // --- 1. Center glow sprite (pre-rendered, composited additively) ---
    // Both sprites take the parallax offset so the filled interior reacts to hover.
    const gR = frEff * 1.6;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = reveal * (0.55 - 0.15 * morphE);
    ctx.drawImage(glow, fcx + fpx - gR, fcy + fpy - gR, gR * 2, gR * 2);

    // --- 2. Volumetric orb body (pre-rendered haze + soft rim; melts away while
    // talking so only the wave remains) ---
    const bR = frEff * BODY_SCALE;
    ctx.globalAlpha = reveal * (1 - morphE);
    ctx.drawImage(body, fcx + fpx - bR, fcy + fpy - bR, bR * 2, bR * 2);
    ctx.globalCompositeOperation = 'source-over';

    // --- 3. Interior light arcs (reference streaks; fade out under the wave).
    // Brighter than before: they must read on the now-filled milky body. ---
    ctx.lineCap = 'round';
    drawArcs(ARCS, ARC_S, reveal * 0.75 * (1 - morphE));

    // --- 4. The main loop: N points that melt from the circle onto ribbon 0 ---
    // At morphE=0 they trace the softly-irregular breathing circle; at morphE=1 a
    // triangle sweep maps them across the FULL width onto the primary sine ribbon —
    // a genuine per-point position morph (the circle MELTS into the wave).
    ctx.lineWidth = 1.6;
    // The body sprite already carries the bright rim; this live loop adds the
    // organic wobble on top (and becomes the wave itself while talking).
    ctx.globalAlpha = reveal * (0.55 + 0.45 * morphE);
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const u = i / N;
      const theta = u * TWO_PI;

      // Idle circle point (subtle organic rim: angular fbm wobble ~+/-2%).
      const wob = fbm1(theta * 1.6 + ft * 0.12) - 0.5;
      const pr = frEff * (1 + wob * 0.04);
      const ix = fcx + Math.cos(theta) * pr;
      const iy = fcy + Math.sin(theta) * pr;

      let x = ix, y = iy;
      if (morphE > 0.001) {
        // Triangle sweep: u 0->0.5->1 maps s -1->+1->-1 (out and back across width).
        const s = u < 0.5 ? (-1 + 4 * u) : (1 - 4 * (u - 0.5));
        const wx = fcx + (s >= 0 ? s * (cssW - fcx) : s * fcx);
        const dxc = wx - fcx;
        const env = Math.exp(-Math.abs(dxc) * finvW);
        const wy = fcy + env * 0.55 * famp01 * Math.sin(dxc * finvR * 2.4 - ft * 2.2) * frEff;
        x = ix + (wx - ix) * morphE;
        y = iy + (wy - iy) * morphE;
      }
      repel(x, y);
      if (i === 0) ctx.moveTo(_rx, _ry); else ctx.lineTo(_rx, _ry);
    }
    ctx.closePath();
    ctx.stroke();

    // --- 5. Two extra layered ribbons (talking depth; fade in with the morph) ---
    if (morphE > 0.01) {
      ctx.lineWidth = 2;
      drawRibbon(0.38, 3.7, 3.1, 1.3, reveal * 0.4 * morphE);
      drawRibbon(0.28, 5.1, 4.0, 2.6, reveal * 0.3 * morphE);
    }

    ctx.globalAlpha = 1;
  }

  rafId = requestAnimationFrame(frame);

  // Listeners intentionally live for the app lifetime (no teardown in the contract).
  void unsubs; void rafId;
}
