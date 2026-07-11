// js/ui/theme-scene.js — per-theme animated SCENERY (Jurek v3: "motywy mają
// zmieniać WSZYSTKO, np. Natura = drzewa"). Draws a living backdrop on
// #scene-canvas behind the avatar: trees + falling leaves (nature), rising
// bubbles + caustics (water), starfield + shooting stars (gsp), snow + fireworks
// (newyear), faint drifting ink (inverted). mono/blueprint = no scene (clean).
// gOS scenery is the CSS blobs in themes.css, so its canvas stays idle.
//
// Perf laws (Intel i9 target): ONE rAF, only while a decorated theme is active
// AND the tab is visible; DPR capped; modest particle counts; the static tree
// silhouette is pre-rendered to an offscreen canvas and blitted. Colour is fine
// here — scenery is decorative, like widget colour. init() never throws.

import { state } from '../core/state-manager.js';

const DPR_CAP = 1.5;
// Themes that draw on the canvas (gos/mono/blueprint don't).
const CANVAS_THEMES = new Set(['nature', 'water', 'gsp', 'newyear', 'inverted']);

let canvas = null, ctx = null;
let cssW = 1, cssH = 1, dpr = 1;
let rafId = 0, running = false;
let current = null;      // active scene object
let t0 = 0, lastT = 0;

function rand(a, b) { return a + Math.random() * (b - a); }

// ---------------------------------------------------------------------------
// Scenes — each: seed(w,h), draw(ctx,w,h,t,dt). Kept tiny + allocation-light.
// ---------------------------------------------------------------------------
function makeNature() {
  let leaves = [], trees = null, tw = 0, th = 0;
  const COLORS = ['#4f9c5e', '#6fbf73', '#3d7a49', '#c9a24b', '#b5772e'];
  function buildTrees(w, h) {
    trees = document.createElement('canvas');
    tw = w; th = h;
    trees.width = Math.max(1, w); trees.height = Math.max(1, h);
    const c = trees.getContext('2d');
    const base = h;
    // Two silhouette rows (far dim, near darker) of pine triangles.
    const rows = [{ y: base, hgt: h * 0.28, step: w / 9, col: 'rgba(6,26,14,0.9)' },
                  { y: base, hgt: h * 0.20, step: w / 14, col: 'rgba(10,38,20,0.7)' }];
    for (const r of rows) {
      c.fillStyle = r.col;
      for (let x = -r.step; x < w + r.step; x += r.step) {
        const jx = x + rand(-r.step * 0.2, r.step * 0.2);
        const hh = r.hgt * rand(0.7, 1.15);
        const halfW = r.step * 0.55;
        // stacked triangle pine
        for (let k = 0; k < 3; k++) {
          const ty = r.y - (hh * k) / 2.4;
          const kw = halfW * (1 - k * 0.24);
          const kh = hh * 0.55;
          c.beginPath();
          c.moveTo(jx, ty - kh);
          c.lineTo(jx - kw, ty);
          c.lineTo(jx + kw, ty);
          c.closePath();
          c.fill();
        }
      }
    }
  }
  return {
    seed(w, h) {
      buildTrees(w, h);
      leaves = Array.from({ length: 26 }, () => ({
        x: rand(0, w), y: rand(-h, h), r: rand(4, 9), rot: rand(0, 6.28),
        vr: rand(-1.4, 1.4), vy: rand(18, 46), sway: rand(14, 40), sp: rand(0.6, 1.6),
        col: COLORS[(Math.random() * COLORS.length) | 0], ph: rand(0, 6.28)
      }));
    },
    draw(ctx, w, h, t, dt) {
      if (!trees || tw !== w || th !== h) buildTrees(w, h);
      for (const l of leaves) {
        l.y += l.vy * dt;
        l.x += Math.sin(t * l.sp + l.ph) * l.sway * dt;
        l.rot += l.vr * dt;
        if (l.y > h + 12) { l.y = -12; l.x = rand(0, w); }
        ctx.save();
        ctx.translate(l.x, l.y); ctx.rotate(l.rot);
        ctx.fillStyle = l.col; ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.ellipse(0, 0, l.r, l.r * 0.5, 0, 0, 6.2832);
        ctx.fill();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      ctx.drawImage(trees, 0, 0);
    }
  };
}

function makeWater() {
  let bubbles = [];
  return {
    seed(w, h) {
      bubbles = Array.from({ length: 34 }, () => ({
        x: rand(0, w), y: rand(0, h), r: rand(2, 9), vy: rand(20, 60),
        ph: rand(0, 6.28), sp: rand(0.8, 2.2), amp: rand(6, 20)
      }));
    },
    draw(ctx, w, h, t, dt) {
      // caustic bands
      ctx.strokeStyle = 'rgba(120,205,255,0.06)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 4; i++) {
        const y = ((i / 4) * h + (t * 12) % h);
        ctx.beginPath();
        for (let x = 0; x <= w; x += 40) ctx.lineTo(x, y + Math.sin(x * 0.02 + t + i) * 10);
        ctx.stroke();
      }
      for (const b of bubbles) {
        b.y -= b.vy * dt;
        const x = b.x + Math.sin(t * b.sp + b.ph) * b.amp;
        if (b.y < -12) { b.y = h + 12; b.x = rand(0, w); }
        ctx.beginPath();
        ctx.arc(x, b.y, b.r, 0, 6.2832);
        ctx.strokeStyle = 'rgba(150,220,255,0.5)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.28, 0, 6.2832);
        ctx.fillStyle = 'rgba(220,245,255,0.6)';
        ctx.fill();
      }
    }
  };
}

function makeGsp() {
  let stars = [], shoot = null, nextShoot = 3;
  return {
    seed(w, h) {
      stars = Array.from({ length: 130 }, () => ({
        x: rand(0, w), y: rand(0, h), s: rand(0.4, 1.8), ph: rand(0, 6.28), tw: rand(0.5, 2)
      }));
      shoot = null; nextShoot = rand(2, 5);
    },
    draw(ctx, w, h, t, dt) {
      for (const st of stars) {
        const a = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * st.tw + st.ph));
        ctx.globalAlpha = a;
        ctx.fillStyle = '#fff';
        ctx.fillRect(st.x, st.y, st.s, st.s);
      }
      ctx.globalAlpha = 1;
      // occasional shooting star
      nextShoot -= dt;
      if (!shoot && nextShoot <= 0) {
        shoot = { x: rand(0, w * 0.6), y: rand(0, h * 0.4), vx: rand(260, 420), vy: rand(120, 220), life: 1 };
      }
      if (shoot) {
        shoot.x += shoot.vx * dt; shoot.y += shoot.vy * dt; shoot.life -= dt * 0.8;
        ctx.strokeStyle = 'rgba(255,255,255,' + Math.max(0, shoot.life) + ')';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(shoot.x, shoot.y);
        ctx.lineTo(shoot.x - shoot.vx * 0.06, shoot.y - shoot.vy * 0.06);
        ctx.stroke();
        if (shoot.life <= 0 || shoot.x > w || shoot.y > h) { shoot = null; nextShoot = rand(3, 7); }
      }
    }
  };
}

function makeNewYear() {
  let snow = [], sparks = [], nextFw = 1.2;
  const FW = ['#ffd166', '#ff5a5a', '#5aa9ff', '#57d977', '#ff8ad1', '#ffffff'];
  function burst(w, h) {
    const cx = rand(w * 0.2, w * 0.8), cy = rand(h * 0.12, h * 0.45);
    const col = FW[(Math.random() * FW.length) | 0];
    const n = 34;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * 6.2832, sp = rand(80, 190);
      sparks.push({ x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 1, col });
    }
  }
  return {
    seed(w, h) {
      snow = Array.from({ length: 70 }, () => ({
        x: rand(0, w), y: rand(0, h), r: rand(1, 3), vy: rand(20, 55), vx: rand(-12, 12), ph: rand(0, 6.28)
      }));
      sparks = []; nextFw = 1;
    },
    draw(ctx, w, h, t, dt) {
      for (const s of snow) {
        s.y += s.vy * dt; s.x += (s.vx + Math.sin(t + s.ph) * 8) * dt;
        if (s.y > h + 4) { s.y = -4; s.x = rand(0, w); }
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = '#eef3ff';
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.2832); ctx.fill();
      }
      ctx.globalAlpha = 1;
      nextFw -= dt;
      if (nextFw <= 0) { burst(w, h); nextFw = rand(1.1, 2.6); }
      for (let i = sparks.length - 1; i >= 0; i--) {
        const p = sparks[i];
        p.vy += 60 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt * 0.7;
        if (p.life <= 0) { sparks.splice(i, 1); continue; }
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.col;
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, 6.2832); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  };
}

function makeInverted() {
  let dots = [];
  return {
    seed(w, h) {
      dots = Array.from({ length: 24 }, () => ({
        x: rand(0, w), y: rand(0, h), r: rand(1.5, 4), vy: rand(-14, -30), ph: rand(0, 6.28), sp: rand(0.5, 1.4)
      }));
    },
    draw(ctx, w, h, t, dt) {
      for (const d of dots) {
        d.y += d.vy * dt; d.x += Math.sin(t * d.sp + d.ph) * 10 * dt;
        if (d.y < -6) { d.y = h + 6; d.x = rand(0, w); }
        ctx.globalAlpha = 0.10;
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 6.2832); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  };
}

const FACTORIES = {
  nature: makeNature, water: makeWater, gsp: makeGsp, newyear: makeNewYear, inverted: makeInverted
};

// ---------------------------------------------------------------------------
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  cssW = window.innerWidth; cssH = window.innerHeight;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (current && current.seed) current.seed(cssW, cssH);
}

function frame(now) {
  rafId = requestAnimationFrame(frame);
  if (document.hidden || !current) return;
  const t = (now - t0) / 1000;
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (dt > 0.05) dt = 0.05;           // clamp after a tab-switch stall
  ctx.clearRect(0, 0, cssW, cssH);
  current.draw(ctx, cssW, cssH, t, dt);
}

function start() {
  if (running) return;
  running = true;
  t0 = lastT = performance.now();
  rafId = requestAnimationFrame(frame);
}
function stop() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  if (ctx) ctx.clearRect(0, 0, cssW, cssH);
}

function switchScene(theme) {
  if (!CANVAS_THEMES.has(theme)) { current = null; stop(); return; }
  const factory = FACTORIES[theme];
  current = factory ? factory() : null;
  if (current && current.seed) current.seed(cssW, cssH);
  start();
}

export async function init() {
  canvas = document.getElementById('scene-canvas');
  if (!canvas) { console.warn('[theme-scene] no #scene-canvas'); return; }
  try { ctx = canvas.getContext('2d'); } catch (_e) { ctx = null; }
  if (!ctx) { console.warn('[theme-scene] canvas 2D unavailable'); return; }

  resize();
  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resize, 150); }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) lastT = performance.now(); });

  state.subscribe('theme', switchScene);
  switchScene(state.get('theme'));
  console.info('[theme-scene] ready');
}
