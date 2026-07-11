// js/core/gravity.js — "Wyłącz grawitację" (Jurek, v3 #6).
// Real 2D physics: on command EVERYTHING on screen (widgets, the two islands, the
// chat bubble, even the avatar) drops, tumbles, piles up at the bottom and can be
// shoved with the cursor. "Włącz grawitację" freezes physics and floats each
// element back to its real UI position. Matter.js loaded from CDN (+esm, no build,
// same pattern as vosk-browser). Honest degrade: if Matter fails to load the tool
// says so and nothing breaks.
//
// How elements move: each gets a Matter body seeded at its current screen center.
// A single rAF writes `transform: translate()+rotate()` (delta from the element's
// ORIGINAL center) every frame — layout boxes are untouched, so releasing gravity
// just clears the transforms and reflows. The avatar has no DOM box, so its body
// drives the avatar:slot event (snap) instead.

import { bus } from './event-bus.js';
import { state } from './state-manager.js';
import { toolRouter } from './tool-router.js';
import { layout } from './layout-engine.js';

const MATTER_ESM = 'https://cdn.jsdelivr.net/npm/matter-js@0.19.0/+esm';

let Matter = null;
let active = false;
let engine = null;
let rafId = 0;
let items = [];          // { el|null, body, w, h, cx0, cy0, isAvatar }
let walls = [];
let mouseHandler = null;
let resizeHandler = null;
let avatarR = 60;

async function ensureMatter() {
  if (Matter) return Matter;
  const mod = await import(MATTER_ESM);
  Matter = mod.default || mod;
  return Matter;
}

// Collect the visible, movable surfaces + their screen rects.
function collectTargets() {
  const out = [];
  const push = (el) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    out.push({ el, w: r.width, h: r.height, cx0: r.left + r.width / 2, cy0: r.top + r.height / 2, isAvatar: false });
  };
  document.querySelectorAll('#widget-layer .widget').forEach(push);
  // Islands: the two pill wrappers (fall as whole pills).
  const islandWraps = document.querySelectorAll('#islands .island-reveal');
  if (islandWraps.length) islandWraps.forEach(push);
  else document.querySelectorAll('#islands .island, #islands .island-group').forEach(push);
  // Chat bubble card (only when shown).
  const bubble = document.getElementById('chat-bubble');
  if (bubble && !bubble.hidden) push(bubble.querySelector('.chat-card'));
  // Trash disc if it happens to be popped.
  const trash = document.querySelector('#trash-corner .trash-disc');
  if (trash) push(trash);

  // Avatar — no DOM box; seed from its current on-screen slot.
  const canvas = document.getElementById('avatar-canvas');
  if (canvas) {
    // The avatar center is roughly viewport-center in idle, corner in showing; read
    // the last emitted slot from a data attribute the avatar keeps, else center.
    const cx = window.__gzAvatarSlot?.cx ?? window.innerWidth / 2;
    const cy = window.__gzAvatarSlot?.cy ?? window.innerHeight / 2;
    avatarR = window.__gzAvatarSlot?.r ?? Math.min(window.innerWidth, window.innerHeight) * 0.13;
    out.push({ el: null, w: avatarR * 2, h: avatarR * 2, cx0: cx, cy0: cy, isAvatar: true });
  }
  return out;
}

function buildWalls(M, vw, vh) {
  const t = 200; // thick so nothing tunnels out
  const opt = { isStatic: true, restitution: 0.2, friction: 0.6 };
  return [
    M.Bodies.rectangle(vw / 2, vh + t / 2 - 2, vw + 2 * t, t, opt),   // floor
    M.Bodies.rectangle(-t / 2, vh / 2, t, vh * 3, opt),               // left
    M.Bodies.rectangle(vw + t / 2, vh / 2, t, vh * 3, opt),           // right
    M.Bodies.rectangle(vw / 2, -vh - t / 2, vw + 2 * t, t, opt)       // ceiling (far up)
  ];
}

function step() {
  const M = Matter;
  M.Engine.update(engine, 1000 / 60);
  for (const it of items) {
    const b = it.body;
    if (it.isAvatar) {
      bus.emit('avatar:slot', { cx: b.position.x, cy: b.position.y, r: avatarR, snap: true });
      continue;
    }
    const dx = b.position.x - it.cx0;
    const dy = b.position.y - it.cy0;
    const deg = (b.angle * 180) / Math.PI;
    it.el.style.transform = `translate(${dx}px, ${dy}px) rotate(${deg}deg)`;
    it.el.style.transition = 'none';
  }
  rafId = requestAnimationFrame(step);
}

async function enable() {
  if (active) return { ok: true, already: true };
  let M;
  try { M = await ensureMatter(); }
  catch (_e) { return { ok: false, error: 'nie udało się załadować silnika fizyki (brak sieci?)' }; }

  const targets = collectTargets();
  if (!targets.length) return { ok: false, error: 'nie ma czego upuścić' };

  const vw = window.innerWidth, vh = window.innerHeight;
  engine = M.Engine.create();
  engine.gravity.y = 1;
  engine.gravity.scale = 0.0016; // a touch snappier than default

  walls = buildWalls(M, vw, vh);
  M.World.add(engine.world, walls);

  items = targets.map((t) => {
    const body = M.Bodies.rectangle(t.cx0, t.cy0, Math.max(8, t.w), Math.max(8, t.h), {
      restitution: 0.35, friction: 0.4, frictionAir: 0.012,
      chamfer: t.isAvatar ? { radius: Math.min(t.w, t.h) / 2 } : { radius: 8 }
    });
    // A little spin + sideways kick so they don't drop like a boring elevator.
    M.Body.setAngularVelocity(body, (t.cx0 / vw - 0.5) * 0.25);
    M.Body.setVelocity(body, { x: (Math.sin(t.cx0 * 0.7) * 2), y: 0 });
    if (t.el) {
      // Kill any lingering WAAPI animation (finished fill:'both' overrides
      // style.transform and freezes the element mid-air — v4 #14).
      try { t.el.getAnimations({ subtree: true }).forEach((a) => a.cancel()); } catch (_e) { /* old engine */ }
      t.el.style.willChange = 'transform'; t.el.style.zIndex = String(90);
    }
    M.World.add(engine.world, body);
    return { ...t, body };
  });

  // Cursor shove: push nearby bodies away from the pointer.
  mouseHandler = (e) => {
    const px = e.clientX, py = e.clientY;
    for (const it of items) {
      const dx = it.body.position.x - px, dy = it.body.position.y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < 140 * 140 && d2 > 1) {
        const f = 0.06 / Math.sqrt(d2);
        M.Body.applyForce(it.body, it.body.position, { x: dx * f, y: dy * f });
      }
    }
  };
  window.addEventListener('pointermove', mouseHandler, { passive: true });

  // Re-floor on resize so nothing ends up off-screen.
  resizeHandler = () => {
    M.World.remove(engine.world, walls);
    walls = buildWalls(M, window.innerWidth, window.innerHeight);
    M.World.add(engine.world, walls);
  };
  window.addEventListener('resize', resizeHandler, { passive: true });

  active = true;
  state.set('gravityOff', true);
  bus.emit('sound:play', { name: 'blip-out' });
  rafId = requestAnimationFrame(step);
  return { ok: true };
}

function disable() {
  if (!active) return { ok: true, already: true };
  active = false;
  cancelAnimationFrame(rafId); rafId = 0;
  window.removeEventListener('pointermove', mouseHandler);
  window.removeEventListener('resize', resizeHandler);
  mouseHandler = resizeHandler = null;

  // Float every element back home (transform -> none, with a spring-ish ease).
  for (const it of items) {
    if (it.isAvatar) continue;
    it.el.style.transition = 'transform 620ms cubic-bezier(0.34, 1.4, 0.5, 1)';
    it.el.style.transform = 'translate(0px, 0px) rotate(0deg)';
    const el = it.el;
    setTimeout(() => {
      el.style.transition = '';
      el.style.transform = '';
      el.style.willChange = '';
      el.style.zIndex = '';
    }, 700);
  }
  items = [];
  if (engine) { Matter.World.clear(engine.world, false); Matter.Engine.clear(engine); engine = null; }
  walls = [];
  state.set('gravityOff', false);
  bus.emit('sound:play', { name: 'blip-in' });
  // Avatar + widgets snap back to their real slots.
  try { layout.reflow(); } catch (_e) { /* engine stub */ }
  return { ok: true };
}

export async function init() {
  // Keep the last avatar slot so gravity can seed the orb's body accurately.
  bus.on('avatar:slot', (p) => {
    if (p && !p.snap && typeof p.cx === 'number') {
      window.__gzAvatarSlot = { cx: p.cx, cy: p.cy, r: p.r };
    }
  });

  toolRouter.registerTool(
    {
      name: 'disable_gravity',
      description: 'WYŁĄCZA grawitację interfejsu: wszystko na ekranie (widgety, wyspy, czat, ' +
        'awatar) spada na dół, zderza się i układa w stos. Czysta zabawa. Użyj gdy Jurek mówi ' +
        '„wyłącz grawitację".',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    async () => enable()
  );

  toolRouter.registerTool(
    {
      name: 'enable_gravity',
      description: 'WŁĄCZA grawitację z powrotem: wszystko wraca płynnie na swoje miejsce. Użyj gdy ' +
        'Jurek mówi „włącz grawitację" albo „przywróć wszystko".',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    async () => disable()
  );
}
