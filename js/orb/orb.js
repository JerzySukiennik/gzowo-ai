// js/orb/orb.js — THE ORB. Avatar of Gzowo AI v1.
//
// A single volumetric glowing white orb on pure black, rendered ENTIRELY in one
// fragment shader (one draw call, one WebGL context — the only one in the app).
// three.js OrthographicCamera(-1..1) + a fullscreen PlaneGeometry(2,2) carrying a
// ShaderMaterial. All the visuals — irregular glowing rim, gray misty interior,
// drifting luminous filaments, and the horizontal "sound-wave made of silk" talking
// ribbons — live in the GLSL below.
//
// Contracts consumed (see js/core/*):
//   bus 'orb:slot'         {cx,cy,r}  px -> target center/radius (glide, never teleport)
//   bus 'state:change'     {from,to}  -> morph idle<->talking (talking = wave mode);
//                                        intro stays hidden (opacity 0)
//   bus 'intro:done'       {}         -> reveal: scale/opacity 0->1 over ~1200ms ease-out
//   bus 'voice:amplitude'  {level,source} -> drive talking wave ('out' strong, 'in' subtle)
//
// Degrades honestly: if WebGL context creation fails, warns + emits 'toast' and
// leaves the canvas empty. The app must keep working without the orb.
//
// English comments; grayscale only (pure white max, black transparent); never edits
// other files. Targets steady 60fps on Intel i9 + Radeon 5500M.

import * as THREE from 'three';
import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';

// ---- Tunables ---------------------------------------------------------------
const MORPH_RATE = 4.0;          // uMorph units per second toward target (idle<->talking)
const AMP_ATTACK = 0.35;         // amplitude smoothing rise per frame
const AMP_RELEASE = 0.06;        // amplitude smoothing fall per frame
const SLOT_STIFFNESS = 0.12;     // spring-lerp factor per 60fps frame toward slot target
const MOUSE_LERP = 0.12;         // pointer follow easing per frame
const BREATH_AMP = 0.03;         // idle breath radius modulation
const BREATH_SPEED = 0.8;        // idle breath angular speed
const REVEAL_MS = 1200;          // intro reveal duration
const IDLE_FPS = 30;             // frame-skip target when fully idle/stable
const SETTLE_EPS_PX = 0.35;      // "slot settled" threshold (px) for center
const SETTLE_EPS_R = 0.35;       // "slot settled" threshold (px) for radius

// ---- GLSL: vertex (trivial fullscreen pass-through) -------------------------
const VERT = /* glsl */ `
precision mediump float;
void main() {
  // PlaneGeometry(2,2) spans clip space directly.
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// ---- GLSL: fragment (the entire orb) ----------------------------------------
const FRAG = /* glsl */ `
precision mediump float;

uniform vec2  uRes;      // canvas resolution in device px
uniform float uTime;     // seconds
uniform vec2  uCenter;   // orb center in device px (gl_FragCoord space)
uniform float uRadius;   // orb radius in device px (already breath-modulated CPU-side)
uniform float uMorph;    // 0 = idle, 1 = talking (lerped on CPU)
uniform float uSmall;    // 0..1 shrink factor (showing) — interior detail LOD
uniform float uAmp;      // smoothed voice amplitude 0..1
uniform vec2  uMouse;    // pointer in device px
uniform float uReveal;   // 0..1 intro reveal (opacity + scale gate)

// ---------- hash / value noise / fbm (all in-shader) ----------
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  // smootherstep for cleaner gradients
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i + vec2(0.0, 0.0));
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  // 3 octaves — enough for a soft mist, cheap on the i9's GPU.
  for (int i = 0; i < 3; i++) {
    v += amp * vnoise(p);
    p = p * 2.02 + vec2(37.1, 11.7);
    amp *= 0.5;
  }
  return v;
}

// 1D fbm on an angle, for the irregular hand-drawn rim silhouette.
float fbm1(float x) {
  return fbm(vec2(x, x * 0.7 + 3.3));
}

void main() {
  // Local orb space: p in units of radius, aspect-corrected so the orb is round
  // regardless of canvas aspect. x scaled by aspect keeps circles circular while
  // still letting ribbons run across the FULL screen width.
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = (gl_FragCoord.xy - uCenter) / uRadius;

  // Mouse in the same local space.
  vec2 mouseLocal = (uMouse - uCenter) / uRadius;

  // ---- Pointer repulsion warp: the field bends away from the cursor ----
  vec2 toM = p - mouseLocal;
  float dM = length(toM);
  if (dM > 0.0001) {
    p += normalize(toM) * exp(-dM * 1.6) * 0.15;
  }

  float t = uTime;

  // ============================ IDLE ORB FIELD ============================
  // Wobbled radius: irregular, softly breathing silhouette (+/-4%).
  float ang = atan(p.y, p.x);
  float wob = fbm1(ang * 1.6 + t * 0.12) - 0.5;      // -0.5..0.5
  float rimR = 1.0 + wob * 0.08;                      // ~+/-4%

  float d = length(p) / rimR;

  // Soft bright rim ring: a bright shell hugging the silhouette edge and fading
  // inward. Kept as the brightest feature so the orb reads as a lit sphere.
  float rim = smoothstep(1.0, 0.9, d) - smoothstep(0.9, 0.62, d);
  rim = max(rim, 0.0) * 1.05;

  // Inner core glow — gentle center lift so the body feels volumetric, NOT a
  // white blob. Low enough that the gray mist + bright filaments stay legible.
  float coreGlow = smoothstep(0.9, 0.0, d) * 0.26;

  // Interior gray mist: domain-warped 3-octave fbm, drifting over time. This is
  // the translucent gray BODY the luminous filaments are painted across.
  // Detail scale eases down when small (showing) to avoid shimmer.
  float mistScale = mix(3.4, 2.2, uSmall);
  vec2 warp = vec2(fbm(p * 1.7 + t * 0.06), fbm(p * 1.7 - t * 0.05));
  float mist = fbm(p * mistScale + warp * 1.5 + vec2(0.0, t * 0.08));
  mist = mix(0.14, 0.32, mist);
  // Mist only inside the silhouette.
  float interiorMask = smoothstep(1.02, 0.85, d);
  float interior = mist * interiorMask;

  // ---- FILAMENTS: 2-4 luminous curved light-painting strokes drifting inside ----
  float fil = 0.0;
  // Each filament is a sin curve across x, offset & bent by fbm, drawn as a thin
  // exp() line masked to the interior. Slow drift = long-exposure light painting.
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float f  = 1.1 + fi * 0.55;                              // spatial frequency
    float s  = 0.18 + fi * 0.07;                             // drift speed
    float ph = fi * 1.7;                                     // phase offset
    float bend = (fbm(vec2(p.x * 0.9 + t * 0.07, fi * 4.0)) - 0.5) * 0.9;
    float curve = sin(p.x * f + t * s + ph) * 0.42 + bend
                + (fi - 1.5) * 0.16;                         // vertical spread
    float line = exp(-abs(p.y - curve) * 16.0);
    // Fade filaments toward the rim so they live in the body, not the edge.
    fil += line * smoothstep(1.05, 0.4, d);
  }
  // Bright luminous strokes — the light-painting feature over the gray body.
  fil = clamp(fil, 0.0, 1.2) * 0.85;

  // Assemble the idle orb luminance.
  float orb = rim + coreGlow + interior + fil;

  // ============================ TALKING RIBBON FIELD ============================
  // Horizontal "sound-wave made of silk": ribbons extend symmetrically across the
  // FULL canvas width, smoky & layered, pulsing with voice amplitude. The sphere
  // core stays present so the orb never fully dissolves.
  // Envelope in x, in units of radius. Widens with amplitude so louder = broader wave.
  float ex = exp(-abs(p.x) * (0.55 - uAmp * 0.30));
  float amp01 = 0.25 + uAmp;                                 // baseline motion even when quiet

  float ribbons = 0.0;
  // 3 layered ribbons with distinct amplitude/frequency/phase-speed.
  // Ribbon 0
  {
    float y0 = ex * 0.55 * amp01 * sin(p.x * 2.4 - t * 2.2);
    ribbons += exp(-abs(p.y - y0) * 9.0) * 0.28;
  }
  // Ribbon 1
  {
    float y1 = ex * 0.38 * amp01 * sin(p.x * 3.7 - t * 3.1 + 1.3);
    ribbons += exp(-abs(p.y - y1) * 12.0) * 0.24;
  }
  // Ribbon 2
  {
    float y2 = ex * 0.28 * amp01 * sin(p.x * 5.1 - t * 4.0 + 2.6);
    ribbons += exp(-abs(p.y - y2) * 15.0) * 0.20;
  }
  // A little smoky fbm haze riding the envelope to make it silky, not wiry.
  float haze = fbm(vec2(p.x * 1.3 - t * 0.4, p.y * 3.0 + t * 0.2));
  ribbons += ex * haze * (0.06 + uAmp * 0.10) * smoothstep(0.9, 0.0, abs(p.y));

  // Keep the sphere core visible during talking: rim + core + a hint of interior.
  float talkCore = rim + coreGlow + interior * 0.7 + fil * 0.5;
  float talk = talkCore + ribbons;

  // ---- Blend idle <-> talking ----
  float v = mix(orb, talk, uMorph);

  // Intro / reveal gate: uReveal ramps 0..1. Fades the whole field in.
  v *= uReveal;

  // Grayscale, premultiplied look: alpha = luminance so black stays transparent
  // over the background grid, and bright = opaque white. Pure white is the max.
  v = clamp(v, 0.0, 1.0);
  gl_FragColor = vec4(vec3(v), v);
}
`;

// ---- Module state -----------------------------------------------------------
export async function init() {
  const canvas = document.getElementById('orb-canvas');
  if (!canvas) {
    console.warn('[orb] no #orb-canvas found — orb disabled.');
    return;
  }

  // --- Renderer (the ONE and only WebGL context) ---
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance'
    });
    // If the context silently failed, bail into honest degradation.
    if (!renderer.getContext()) throw new Error('no WebGL context');
  } catch (err) {
    console.warn('[orb] WebGL unavailable — degrading honestly.', err);
    bus.emit('toast', { text: 'Kula niedostępna — brak WebGL, człowieku.', kind: 'warn' });
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  // updateStyle:true (default) so the canvas CSS box tracks the viewport. The
  // drawing buffer is that size × pixelRatio; base.css pins it fixed inset:0.
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0); // transparent clear over the grid
  renderer.autoClear = true;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const geometry = new THREE.PlaneGeometry(2, 2);
  const uniforms = {
    uRes:    { value: new THREE.Vector2(1, 1) },
    uTime:   { value: 0 },
    uCenter: { value: new THREE.Vector2(0, 0) },
    uRadius: { value: 1 },
    uMorph:  { value: 0 },
    uSmall:  { value: 0 },
    uAmp:    { value: 0 },
    uMouse:  { value: new THREE.Vector2(-1e6, -1e6) },
    uReveal: { value: 0 }
  };
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // ---- CPU-side animation state (device-px space, matches gl_FragCoord) ----
  const dpr = () => renderer.getPixelRatio();

  // Slot: current & target center/radius, in CSS px (converted to device px per frame).
  // Default target: centered, sized off --orb-idle-ratio-ish fraction of the viewport
  // so the orb has a sane home before the layout engine emits its first 'orb:slot'.
  function defaultSlot() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const r = Math.min(vw, vh) * 0.15; // ~0.30 diameter ratio
    return { cx: vw / 2, cy: vh / 2, r };
  }
  let target = defaultSlot();
  let cur = { cx: target.cx, cy: target.cy, r: target.r };

  // Morph (idle=0, talking=1) target driven by state.
  let morphTarget = 0;

  // Amplitude: raw incoming (max of in/out weighted) vs smoothed.
  let ampRaw = 0;
  let ampSmoothed = 0;

  // Mouse in CSS px, lerped.
  let mouseTargetX = -1e6, mouseTargetY = -1e6;
  let mouseX = -1e6, mouseY = -1e6;

  // Reveal 0..1 (intro). Starts hidden.
  let revealTarget = 0;
  let reveal = 0;
  let revealStart = 0;

  // ---- Idle frame-skip bookkeeping ----
  let lastRenderTime = 0;

  // ---- Activity gate: decides 30fps idle vs 60fps active ----
  // Declared BEFORE event wiring, because wiring calls wake() during init().
  // "wake" opens a brief full-rate window so freshly-arrived events render at 60.
  let awakeUntil = 0;
  function wake() {
    awakeUntil = performance.now() + 250; // brief full-rate window after any event
  }

  // Small factor (showing shrink) derived implicitly from slot radius vs. idle size.
  function computeSmall() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const idleR = Math.min(vw, vh) * 0.15;
    // 0 when at/above idle radius, ramps to 1 as it shrinks toward corner size.
    const s = 1.0 - Math.min(cur.r / Math.max(idleR, 1), 1);
    return Math.max(0, Math.min(1, s));
  }

  // ---- Event wiring ----
  const unsubs = [];

  // Slot target from layout engine — glide there, never teleport.
  unsubs.push(bus.on('orb:slot', (payload) => {
    if (!payload) return;
    const { cx, cy, r } = payload;
    if (typeof cx === 'number') target.cx = cx;
    if (typeof cy === 'number') target.cy = cy;
    if (typeof r === 'number') target.r = Math.max(2, r);
    wake();
  }));

  // State morph: talking = wave mode; idle/showing = orb; intro = stay hidden.
  function applyState(to) {
    if (to === 'talking') {
      morphTarget = 1;
    } else if (to === 'idle' || to === 'showing') {
      morphTarget = 0;
    }
    // 'intro' => keep hidden; reveal handled by 'intro:done'.
    wake();
  }
  unsubs.push(bus.on('state:change', ({ to }) => applyState(to)));

  // Intro reveal.
  unsubs.push(bus.on('intro:done', () => {
    revealTarget = 1;
    revealStart = performance.now();
    wake();
  }));

  // Voice amplitude -> talking wave. 'out' (Gzowo speaking) strong, 'in' subtle.
  unsubs.push(bus.on('voice:amplitude', (payload) => {
    if (!payload) return;
    const level = Math.max(0, Math.min(1, payload.level || 0));
    const weight = payload.source === 'in' ? 0.35 : 1.0;
    ampRaw = Math.max(ampRaw, level * weight);
    wake();
  }));

  // Pointer tracking (canvas is pointer-events:none, so listen on window).
  const onPointerMove = (e) => {
    mouseTargetX = e.clientX;
    mouseTargetY = e.clientY;
    wake();
  };
  window.addEventListener('pointermove', onPointerMove, { passive: true });

  // Resize (debounced).
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderer.setSize(window.innerWidth, window.innerHeight);
      // If we're still on the default (layout hasn't spoken), recenter it.
      wake();
    }, 120);
  };
  window.addEventListener('resize', onResize, { passive: true });

  // Visibility: pause rAF when hidden.
  const onVisibility = () => {
    if (!document.hidden) {
      lastRenderTime = 0;         // force an immediate frame on return
      wake();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  // If the GL context is lost, degrade honestly.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.warn('[orb] WebGL context lost.');
  }, false);

  // Initialize morph from whatever state we booted into (usually 'intro').
  applyState(state.ui);
  // If we somehow start past intro (hot reload), reveal immediately.
  if (state.ui !== 'intro') {
    reveal = 1; revealTarget = 1;
  }

  // ---- Activity gate predicate: is anything in flight this frame? ----
  function isActive(now) {
    const slotMoving =
      Math.abs(cur.cx - target.cx) > SETTLE_EPS_PX ||
      Math.abs(cur.cy - target.cy) > SETTLE_EPS_PX ||
      Math.abs(cur.r - target.r) > SETTLE_EPS_R;
    const morphMoving = Math.abs(uniforms.uMorph.value - morphTarget) > 0.001;
    const revealMoving = Math.abs(reveal - revealTarget) > 0.001;
    const amped = ampSmoothed > 0.02 || ampRaw > 0.02;
    const mouseMoving =
      Math.abs(mouseX - mouseTargetX) > 0.5 || Math.abs(mouseY - mouseTargetY) > 0.5;
    return slotMoving || morphMoving || revealMoving || amped || mouseMoving || now < awakeUntil;
  }

  // ---- The single render loop ----
  const clock = new THREE.Clock();
  let rafId = 0;

  function frame() {
    rafId = requestAnimationFrame(frame);
    const now = performance.now();

    // Fully paused while the tab is hidden — pure perf, no wasted GPU.
    if (document.hidden) return;

    const active = isActive(now);

    // Frame-skip: run at IDLE_FPS when nothing is happening, full 60 when active.
    if (!active) {
      if (now - lastRenderTime < 1000 / IDLE_FPS) return;
    }
    lastRenderTime = now;

    // Time always advances off the clock (independent of frame-skip) so motion
    // stays smooth and phase-correct whether we render at 30 or 60.
    uniforms.uTime.value = clock.getElapsedTime();
    const et = uniforms.uTime.value;

    // --- Spring-lerp center/radius toward slot target (critically damped-ish) ---
    cur.cx += (target.cx - cur.cx) * SLOT_STIFFNESS;
    cur.cy += (target.cy - cur.cy) * SLOT_STIFFNESS;
    cur.r  += (target.r  - cur.r)  * SLOT_STIFFNESS;

    // --- Idle breath: gently modulate the effective radius (CPU-side) ---
    const breath = 1.0 + BREATH_AMP * Math.sin(et * BREATH_SPEED);
    const effR = cur.r * breath;

    // --- Morph toward target at ~MORPH_RATE/s ---
    const dt = Math.min(0.05, clock.getDelta ? 1 / 60 : 1 / 60); // stable step
    const step = MORPH_RATE * (1 / 60);
    const m = uniforms.uMorph.value;
    if (m < morphTarget) uniforms.uMorph.value = Math.min(morphTarget, m + step);
    else if (m > morphTarget) uniforms.uMorph.value = Math.max(morphTarget, m - step);

    // --- Amplitude smoothing: fast attack, slow release ---
    if (ampRaw > ampSmoothed) {
      ampSmoothed += (ampRaw - ampSmoothed) * AMP_ATTACK;
    } else {
      ampSmoothed += (ampRaw - ampSmoothed) * AMP_RELEASE;
    }
    // Decay the raw input each frame so old peaks fade (fresh events re-raise it).
    ampRaw *= 0.9;
    uniforms.uAmp.value = ampSmoothed;

    // --- Reveal easing (ease-out over REVEAL_MS) ---
    if (revealTarget > 0 && reveal < 1) {
      const p = Math.min(1, (now - revealStart) / REVEAL_MS);
      // ease-out cubic
      reveal = 1 - Math.pow(1 - p, 3);
    } else if (revealTarget === 0) {
      reveal = 0;
    }
    uniforms.uReveal.value = reveal;

    // --- Mouse lerp ---
    if (mouseTargetX > -1e5) {
      if (mouseX < -1e5) { mouseX = mouseTargetX; mouseY = mouseTargetY; }
      mouseX += (mouseTargetX - mouseX) * MOUSE_LERP;
      mouseY += (mouseTargetY - mouseY) * MOUSE_LERP;
    }

    // --- Push uniforms in device-px space (gl_FragCoord matches) ---
    const ratio = dpr();
    uniforms.uRes.value.set(canvas.width, canvas.height);
    // gl_FragCoord y is bottom-up; DOM/client y is top-down -> flip center & mouse.
    const H = canvas.height;
    uniforms.uCenter.value.set(cur.cx * ratio, H - cur.cy * ratio);
    uniforms.uRadius.value = Math.max(2, effR * ratio);
    uniforms.uSmall.value = computeSmall();
    if (mouseX > -1e5) {
      uniforms.uMouse.value.set(mouseX * ratio, H - mouseY * ratio);
    } else {
      uniforms.uMouse.value.set(-1e6, -1e6);
    }

    renderer.render(scene, camera);
  }

  rafId = requestAnimationFrame(frame);

  // Nothing throws out of init(); the module is now live. No teardown API is part
  // of the contract, but keep references discoverable for debugging.
  // (unsubs / listeners intentionally live for the app lifetime.)
  void unsubs;
}
