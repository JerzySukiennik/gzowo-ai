// js/core/layout-engine.js — layout-owned, FINAL.
// ============================================================================
// THE SINGLE AUTHORITY FOR POSITIONING. Guarantor of "Prawo ruchu":
//   (1) ZERO overlap — ever — between widgets, and between widgets and the orb
//       zone / HUD / dock / chat. Achieved BY CONSTRUCTION: we compute disjoint
//       slot rectangles and nothing else positions widgets.
//   (2) Choreography — every add/remove/state-change is animated (fly-in,
//       fly-out, fly-to-trash), neighbors FLIP-glide to their new slots.
//   (3) Orb never occluded — we reserve an orb zone, subtract it from widget
//       space, and emit its rect ('orb:slot') so the orb follows.
//
// Perf law: animate transform + opacity ONLY (Web Animations API), batch DOM
// reads then writes, never animate layout properties. Target 60fps on Intel i9.
// B&W law: this file positions frames only; color lives inside .widget-body.
// ============================================================================

import { bus } from './event-bus.js';
import { state } from './state-manager.js';
import { el } from '../widgets/widget-base.js';

// ---- Constants --------------------------------------------------------------
const LAYER_ID = 'widget-layer';
const TRASH_ID = 'trash-target';
const DOCK_ID = 'dock';

const HALO_IDLE = 1.4;   // orb-idle-ratio halo factor (centered orb zone)
const HALO_CORNER = 1.6; // orb-corner-ratio halo factor (top-left orb zone)

const MAX_GRID_RETRIES = 3;   // extra columns to try when cells collide w/ orb
const MAX_PINNED_COMPACT = 4; // idle/talking: at most 4 pinned widgets ring orb
const SINGLE_CAP = 0.70;      // single showing widget caps to 70% of free rect
const COMPACT_MIN_W = 240;    // idle/talking compact slot clamp
const COMPACT_MAX_W = 340;
const COMPACT_ASPECT = 2 / 3; // height = width * 2/3  (3:2 w:h)

const RESIZE_DEBOUNCE = 100;

// ---- Motion (read from tokens once, with sane fallbacks) --------------------
// We resolve token *values* lazily in init(); these mirror design-tokens.css.
const MOTION = {
  flyDistance: 120,   // --fly-distance px
  stagger: 40,        // --stagger ms
  tFast: 150,         // --t-fast
  tMed: 300,          // --t-med
  tSlow: 600,         // --t-slow
  easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
  easeIn: 'cubic-bezier(0.65, 0, 0.35, 1)'
};

// ---- Token cache (recomputed on resize) -------------------------------------
const METRICS = {
  hudH: 48,
  dockH: 56,
  gap: 16,
  margin: 24,        // --space-5
  orbIdleRatio: 0.30,
  orbCornerRatio: 0.12
};

// ---- Engine state -----------------------------------------------------------
/**
 * @typedef {Object} WidgetEntry
 * @property {string} id
 * @property {object} def
 * @property {HTMLElement} node
 * @property {HTMLElement} body
 * @property {string[]} pinned            subset of ['idle','talking','showing']
 * @property {Function|null} cleanup      render() teardown
 * @property {DOMRect|null} rect          last committed slot (px, viewport space)
 * @property {boolean} visible            currently laid out (not display:none)
 * @property {boolean} mounted            has completed its enter animation once
 * @property {boolean} exiting            mid fly-out (may be re-shown before it ends)
 */

/** @type {Map<string, WidgetEntry>} */
const widgets = new Map();
/** insertion order — drives grid row-major placement + overflow queueing. */
const order = [];

/** cleanup fns from render(), keyed by node (survives entry churn). */
const cleanups = new WeakMap();

let layer = null;
let reservedRight = 0;
let resizeTimer = 0;
let inited = false;
let reflowScheduled = false;

// ============================================================================
// Geometry helpers — pure rect math (viewport coordinate space, px)
// ============================================================================
function rect(x, y, w, h) {
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}
function intersects(a, b, pad = 0) {
  return !(
    a.x + a.w <= b.x - pad ||
    b.x + b.w <= a.x - pad ||
    a.y + a.h <= b.y - pad ||
    b.y + b.h <= a.y - pad
  );
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function px(v) {
  return `${Math.round(v * 100) / 100}px`;
}

// ============================================================================
// Token reading — batched, once per init + resize
// ============================================================================
function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const num = (name, fallback) => {
    const raw = cs.getPropertyValue(name).trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  METRICS.hudH = num('--hud-h', 48);
  METRICS.dockH = num('--dock-h', 56);
  METRICS.gap = num('--widget-gap', 16);
  METRICS.margin = num('--space-5', 24);
  METRICS.orbIdleRatio = num('--orb-idle-ratio', 0.30);
  METRICS.orbCornerRatio = num('--orb-corner-ratio', 0.12);

  MOTION.flyDistance = num('--fly-distance', 120);
  MOTION.stagger = num('--stagger', 40);
  MOTION.tFast = num('--t-fast', 150);
  MOTION.tMed = num('--t-med', 300);
  MOTION.tSlow = num('--t-slow', 600);
  const eo = cs.getPropertyValue('--ease-out').trim();
  const ei = cs.getPropertyValue('--ease-in-out').trim();
  if (eo) MOTION.easeOut = eo;
  if (ei) MOTION.easeIn = ei;
}

function prefersReducedMotion() {
  return typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ============================================================================
// Safe area + orb zone
// ============================================================================
/** Viewport minus HUD top, dock bottom, reservedRight, and --space-5 inset. */
function safeArea() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const m = METRICS.margin;
  const x = m;
  const y = METRICS.hudH + m;
  const w = Math.max(0, vw - reservedRight - m - x);
  const h = Math.max(0, vh - METRICS.dockH - m - y);
  return rect(x, y, w, h);
}

/**
 * The orb zone for the current UI state, in viewport coords.
 * - idle/talking: centered square, side = orbIdleRatio × min(vw,vh) × HALO_IDLE
 * - showing:      top-left square at safe-area corner,
 *                 side = orbCornerRatio × min(vw,vh) × HALO_CORNER
 * - intro:        null (orb hidden)
 * Returns { zone: rect|null, halo, visualR } where visualR is the on-screen orb
 * radius (zone side / 2 ÷ halo) and zone.cx/cy is the orb center to emit.
 */
function orbZone(ui, area) {
  const minSide = Math.min(window.innerWidth, window.innerHeight);
  if (ui === 'intro') return { zone: null, halo: HALO_IDLE, visualR: 0 };

  if (ui === 'showing') {
    const side = METRICS.orbCornerRatio * minSide * HALO_CORNER;
    // Anchor at the safe-area top-left corner (inside the margin).
    const zone = rect(area.x, area.y, side, side);
    return { zone, halo: HALO_CORNER, visualR: side / 2 / HALO_CORNER };
  }

  // idle / talking → centered on the FREE area (viewport minus HUD/dock/margins
  // and reservedRight for the chat panel), NOT the raw viewport. Centering on the
  // raw viewport left the orb overlapping the chat panel and the right-band compact
  // slots when chat was open. `area` already has reservedRight subtracted.
  const side = METRICS.orbIdleRatio * minSide * HALO_IDLE;
  const cx = area.x + area.w / 2;
  const cy = area.y + area.h / 2;
  const zone = rect(cx - side / 2, cy - side / 2, side, side);
  return { zone, halo: HALO_IDLE, visualR: side / 2 / HALO_IDLE };
}

// ============================================================================
// SHOWING layout — self-arranging grid, "im mniej tym większe"
// ============================================================================
/**
 * Compute disjoint slot rects for `n` visible widgets over the content area,
 * skipping any grid cell that intersects the orb zone. Density is increased
 * (add a column) up to MAX_GRID_RETRIES if the orb eats too many cells.
 *
 * @returns {{slots:rect[], capped:boolean}} slots.length may be < n (capped).
 */
function computeShowingSlots(n, area, zone) {
  if (n <= 0) return { slots: [], capped: false };

  // Special case: a single widget gets a large, comfortable cell placed in the
  // free space to the RIGHT of the orb corner zone, capped to SINGLE_CAP.
  if (n === 1) {
    return { slots: [singleSlot(area, zone)], capped: false };
  }

  let extraCols = 0;
  let best = null;
  while (extraCols <= MAX_GRID_RETRIES) {
    let cols = Math.ceil(Math.sqrt(n)) + extraCols;
    let rows = Math.ceil(n / cols);
    const cells = gridCells(area, cols, rows);
    // Keep only cells clear of the orb zone.
    const free = zone ? cells.filter((c) => !intersects(c, zone, 0)) : cells;
    if (free.length >= n) {
      return { slots: free.slice(0, n), capped: false };
    }
    best = free; // remember the densest attempt in case we must cap
    extraCols++;
  }
  // Could not fit all — cap to what fits, queue the rest hidden (caller does).
  return { slots: (best || []).slice(0, n), capped: true };
}

/** Row-major grid cells over `area`, each inset by gap/2 (=> gap between cells). */
function gridCells(area, cols, rows) {
  const cellW = area.w / cols;
  const cellH = area.h / rows;
  const half = METRICS.gap / 2;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = area.x + c * cellW + half;
      const y = area.y + r * cellH + half;
      const w = Math.max(0, cellW - METRICS.gap);
      const h = Math.max(0, cellH - METRICS.gap);
      cells.push(rect(x, y, w, h));
    }
  }
  return cells;
}

/** One big centered cell in the free rect right of the orb corner zone. */
function singleSlot(area, zone) {
  // Free rect = safe area minus the orb corner column (if the orb sits at
  // top-left, reclaim the space to its right + below).
  let free = area;
  if (zone && intersects(area, zone, 0)) {
    // Prefer the horizontal band to the right of the orb; if too narrow, use
    // the vertical band below it.
    const rightW = area.x + area.w - (zone.x + zone.w) - METRICS.gap;
    const belowH = area.y + area.h - (zone.y + zone.h) - METRICS.gap;
    if (rightW >= belowH) {
      free = rect(zone.x + zone.w + METRICS.gap, area.y, Math.max(0, rightW), area.h);
    } else {
      free = rect(area.x, zone.y + zone.h + METRICS.gap, area.w, Math.max(0, belowH));
    }
  }
  const w = free.w * SINGLE_CAP;
  const h = free.h * SINGLE_CAP;
  const x = free.x + (free.w - w) / 2;
  const y = free.y + (free.h - h) / 2;
  return rect(x, y, w, h);
}

// ============================================================================
// IDLE / TALKING layout — fixed compact slots ringing the central orb
// ============================================================================
/**
 * Up to 4 pinned widgets in fixed bands around the centered orb:
 *   [0] mid-left band, [1] mid-right band, [2] bottom-left, [3] bottom-right.
 * Each ~ (orb side / 4), clamped to [COMPACT_MIN_W, COMPACT_MAX_W], 3:2 aspect,
 * gap-respecting, and asserted NOT to intersect the orb zone.
 */
function computeCompactSlots(count, area, zone) {
  const n = Math.min(count, MAX_PINNED_COMPACT);
  if (n <= 0) return [];

  const orbSide = zone ? zone.w : Math.min(area.w, area.h) * 0.4;
  let w = clamp(orbSide / 4, COMPACT_MIN_W, COMPACT_MAX_W);
  // Never wider than the side gutter available beside the orb.
  const gutter = zone ? Math.max(0, zone.x - area.x - METRICS.gap) : area.w / 3;
  if (gutter > 0) w = Math.min(w, gutter);
  w = Math.max(w, 0);
  const h = w * COMPACT_ASPECT;

  const leftX = area.x;
  const rightX = area.x + area.w - w;

  // Two vertical rows per gutter (top + bottom). They must NEVER overlap each
  // other — `pushClear` only guards the orb zone, never widget↔widget, so the
  // separation is enforced here by construction. On short viewports where two
  // rows plus a gap don't fit, we collapse to a SINGLE centered row per gutter
  // (mid-left / mid-right only), so mid/bottom bands can never collide.
  const centerY = area.y + (area.h - h) / 2;
  const twoRowsFit = area.h >= 2 * h + METRICS.gap;

  let candidates;
  if (twoRowsFit) {
    const topY = area.y;
    const botY = area.y + area.h - h;
    candidates = [
      rect(leftX, topY, w, h),   // top-left
      rect(rightX, topY, w, h),  // top-right
      rect(leftX, botY, w, h),   // bottom-left
      rect(rightX, botY, w, h)   // bottom-right
    ];
  } else {
    // Only two non-overlapping bands available (one centered row).
    candidates = [
      rect(leftX, centerY, w, h),  // mid-left
      rect(rightX, centerY, w, h)  // mid-right
    ];
  }

  const limit = Math.min(n, candidates.length);
  const slots = [];
  for (let i = 0; i < limit; i++) {
    let slot = candidates[i];
    // Assert clearance: if a compact slot somehow grazes the orb zone (tiny
    // viewport), nudge it outward toward its band edge until clear or give up.
    if (zone && intersects(slot, zone, 0)) {
      slot = pushClear(slot, zone, area);
    }
    slots.push(slot);
  }
  return slots;
}

/** Nudge a rect away from the orb zone toward the nearest safe-area edge. */
function pushClear(slot, zone, area) {
  const goLeft = slot.cx < zone.cx;
  if (goLeft) {
    const x = Math.min(slot.x, zone.x - slot.w - METRICS.gap);
    return rect(clamp(x, area.x, slot.x), slot.y, slot.w, slot.h);
  }
  const x = Math.max(slot.x, zone.x + zone.w + METRICS.gap);
  return rect(clamp(x, slot.x, area.x + area.w - slot.w), slot.y, slot.w, slot.h);
}

// ============================================================================
// Visibility selection per UI state
// ============================================================================
/** Ordered list of entries that should be visible for `ui`, honoring pins. */
function selectVisible(ui) {
  const inOrder = order.map((id) => widgets.get(id)).filter(Boolean);
  if (ui === 'showing') {
    return inOrder; // all widgets compete for grid cells (may be capped)
  }
  // idle / talking → only widgets pinned for THIS state, max 4.
  return inOrder
    .filter((w) => w.pinned.includes(ui))
    .slice(0, MAX_PINNED_COMPACT);
}

// ============================================================================
// Node building (engine is the sole frame builder)
// ============================================================================
function buildNode(def) {
  const section = el('section', 'widget');
  section.dataset.id = def.id;

  const head = el('header', 'widget-head');
  const title = el('span', 'widget-title', def.title || def.id);
  const controls = el('div', 'widget-controls');

  const pinBtn = el('button', 'widget-pin', '⌖');
  pinBtn.type = 'button';
  pinBtn.setAttribute('aria-label', 'Przypnij');
  pinBtn.addEventListener('click', () => togglePin(def.id));

  const closeBtn = el('button', 'widget-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Schowaj');
  closeBtn.addEventListener('click', () => removeWidget(def.id, { toTrash: true }));

  controls.append(pinBtn, closeBtn);
  head.append(title, controls);

  const body = el('div', 'widget-body');
  if (def.color) {
    // Expose the widget's accent as a custom prop, scoped to the BODY only.
    // Chrome stays B&W; widgets opt into color internally via var(--widget-accent).
    body.style.setProperty('--widget-accent', def.color);
  }

  section.append(head, body);
  return { section, body };
}

function refreshBody(entry) {
  // Tear down previous render, clear body, re-render. Used by ctx.refresh().
  const prev = cleanups.get(entry.node);
  if (typeof prev === 'function') {
    try { prev(); } catch (e) { console.error('[layout] cleanup failed', entry.id, e); }
  }
  entry.body.replaceChildren();
  runRender(entry);
}

function runRender(entry) {
  let cleanup = null;
  try {
    cleanup = entry.def.render(entry.body, {
      bus,
      state,
      refresh: () => refreshBody(entry)
    });
  } catch (e) {
    console.error('[layout] widget render failed', entry.id, e);
    entry.body.replaceChildren(el('div', '', '[GZOWO] Widget się wywalił.'));
  }
  cleanups.set(entry.node, typeof cleanup === 'function' ? cleanup : null);
  entry.cleanup = typeof cleanup === 'function' ? cleanup : null;
}

// ============================================================================
// Animations (Web Animations API — transform + opacity ONLY)
// ============================================================================
function animate(node, keyframes, opts) {
  if (prefersReducedMotion()) {
    // Skip motion but still land on the final frame.
    const last = keyframes[keyframes.length - 1] || {};
    Object.assign(node.style, {
      transform: last.transform || '',
      opacity: last.opacity != null ? String(last.opacity) : ''
    });
    return { finished: Promise.resolve(), cancel() {} };
  }
  const anim = node.animate(keyframes, opts);
  return anim;
}

function flyIn(node, delay = 0) {
  return animate(node, [
    { transform: `translateY(${MOTION.flyDistance}px) scale(0.92)`, opacity: 0 },
    { transform: 'translateY(0) scale(1)', opacity: 1 }
  ], {
    duration: MOTION.tSlow, delay, easing: MOTION.easeOut, fill: 'both'
  }).finished;
}

function flyOut(node, delay = 0) {
  return animate(node, [
    { transform: 'translateY(0) scale(1)', opacity: 1 },
    { transform: `translateY(${MOTION.flyDistance}px) scale(0.92)`, opacity: 0 }
  ], {
    duration: MOTION.tSlow, delay, easing: MOTION.easeOut, fill: 'both'
  }).finished;
}

function pulse(node) {
  return animate(node, [
    { transform: 'scale(1)' },
    { transform: 'scale(1.03)' },
    { transform: 'scale(1)' }
  ], {
    duration: MOTION.tFast, easing: MOTION.easeOut
  }).finished;
}

/** Animate a widget's center into #trash-target center, shrinking + fading. */
function flyToTrash(node, delay = 0) {
  const target = trashPoint();
  const from = node.getBoundingClientRect();
  const fromCx = from.left + from.width / 2;
  const fromCy = from.top + from.height / 2;
  const dx = target.x - fromCx;
  const dy = target.y - fromCy;
  return animate(node, [
    { transform: 'translate(0,0) scale(1)', opacity: 1 },
    { transform: `translate(${dx}px, ${dy}px) scale(0.05)`, opacity: 0 }
  ], {
    duration: MOTION.tSlow, delay, easing: MOTION.easeIn, fill: 'both'
  }).finished;
}

/** Center of #trash-target if present, else the dock's bottom-right corner. */
function trashPoint() {
  const t = document.getElementById(TRASH_ID);
  if (t) {
    const r = t.getBoundingClientRect();
    if (r.width || r.height) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  const dock = document.getElementById(DOCK_ID);
  if (dock) {
    const r = dock.getBoundingClientRect();
    return { x: r.right - 28, y: r.top + r.height / 2 };
  }
  return { x: window.innerWidth - 28, y: window.innerHeight - METRICS.dockH / 2 };
}

// ============================================================================
// Slot commit + FLIP glide for survivors
// ============================================================================
/**
 * Apply a target rect to a widget. If it was already on-screen at a different
 * rect, FLIP-glide from old→new (transform only). New/entering widgets get
 * their box set and are flagged for a fly-in by the caller.
 *
 * @param {WidgetEntry} entry
 * @param {rect} target
 * @param {number} glideDelay stagger for neighbor glides
 * @returns {Promise|null} glide finished promise (null if none)
 */
function commitSlot(entry, target, glideDelay) {
  const node = entry.node;
  const prev = entry.rect;
  // Write the new geometry (this is the layout property change — done WITHOUT
  // animation; motion is done purely via transform on top of the new box).
  node.style.left = px(target.x);
  node.style.top = px(target.y);
  node.style.width = px(target.w);
  node.style.height = px(target.h);
  entry.rect = target;
  entry.visible = true;

  if (!entry.mounted) return null; // entering widget → caller runs fly-in

  if (!prev) return null;

  // FLIP: invert the delta on transform, then play to identity.
  const dx = prev.x - target.x;
  const dy = prev.y - target.y;
  const sx = prev.w && target.w ? prev.w / target.w : 1;
  const sy = prev.h && target.h ? prev.h / target.h : 1;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 &&
      Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005) {
    return null; // no meaningful move
  }
  return animate(node, [
    { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
    { transform: 'translate(0,0) scale(1,1)' }
  ], {
    duration: MOTION.tMed, delay: glideDelay, easing: MOTION.easeOut, fill: 'both'
  }).finished;
}

// ============================================================================
// The reflow — recompute slots for current state + viewport, animate to them
// ============================================================================
/**
 * @param {object} [opts]
 * @param {boolean} [opts.enterNew=true] play fly-in for freshly-mounted widgets
 */
function doReflow(opts = {}) {
  const enterNew = opts.enterNew !== false;
  if (!layer) return;

  const ui = state.ui;
  const area = safeArea();
  const { zone, visualR } = orbZone(ui, area);

  // --- 1. Emit the orb slot first so the orb glides in parallel. -----------
  if (zone) {
    bus.emit('orb:slot', { cx: zone.cx, cy: zone.cy, r: visualR });
  }

  // --- 2. Decide who is visible + their slots. -----------------------------
  const visible = selectVisible(ui);
  let slots = [];
  let capped = false;

  if (ui === 'intro') {
    // No widget layout during intro — hide everything (should be empty anyway).
    slots = [];
  } else if (ui === 'showing') {
    const res = computeShowingSlots(visible.length, area, zone);
    slots = res.slots;
    capped = res.capped;
  } else {
    // idle / talking
    slots = computeCompactSlots(visible.length, area, zone);
  }

  const nPlaced = slots.length;
  const placed = visible.slice(0, nPlaced);
  const overflow = visible.slice(nPlaced);

  if (capped && overflow.length > 0) {
    bus.emit('toast', {
      text: '[GZOWO] Za dużo widgetów, człowieku — coś musiało zejść.',
      kind: 'warn'
    });
  }

  // --- 3. Hide entries that must not be visible now (fly-out then display:none).
  const shouldBeVisible = new Set(placed.map((w) => w.id));
  for (const id of order) {
    const entry = widgets.get(id);
    if (!entry) continue;
    if (!shouldBeVisible.has(id) && entry.visible) {
      hideEntry(entry);
    }
  }

  // --- 4. Place / glide the visible set. -----------------------------------
  const glidePromises = [];
  let glideIndex = 0;
  let enterIndex = 0;
  for (let i = 0; i < placed.length; i++) {
    const entry = placed[i];

    // A widget that was flying out but is now re-selected must have its in-flight
    // exit cancelled and its residual opacity/transform cleared, otherwise it
    // lands committed-but-invisible-and-offset (fill:'both' holds the exit's last
    // frame). Treat it as a fresh entry so it flies back in cleanly.
    const wasInterruptedExit = entry.exiting;
    if (wasInterruptedExit) {
      resetNodeMotion(entry.node);
      entry.exiting = false;
    }

    ensureShown(entry);
    // Entering = never mounted, OR mounted but re-appearing from an interrupted
    // exit (its FLIP `prev` rect was cleared, so it would otherwise get neither a
    // glide nor a fly-in).
    const wasEntering = !entry.mounted || wasInterruptedExit;
    const glide = commitSlot(entry, slots[i], glideIndex * MOTION.stagger);
    if (glide) { glidePromises.push(glide); glideIndex++; }

    if (wasEntering && enterNew) {
      // Start the widget at its box, invisible, then fly in with stagger.
      entry.node.style.opacity = '0';
      entry.mounted = true;
      const delay = enterIndex * MOTION.stagger;
      enterIndex++;
      glidePromises.push(flyIn(entry.node, delay));
    } else if (wasEntering) {
      entry.mounted = true;
      entry.node.style.opacity = '1';
    }
  }

  // --- 5. Debug assertion after the DOM settles. ---------------------------
  if (typeof window !== 'undefined' && window.GZOWO_DEBUG) {
    Promise.allSettled(glidePromises).then(() => assertNoOverlap(zone));
  }
}

/** Make an entry present in the DOM + eligible for layout. */
function ensureShown(entry) {
  entry.node.style.display = '';
  if (!entry.node.isConnected) layer.appendChild(entry.node);
  entry.visible = true;
}

/**
 * Cancel any in-flight enter/exit WAAPI animation on a node and clear the
 * residual transform/opacity they leave behind (fill:'both' holds the last
 * frame). Without this, a widget interrupted mid-fly-out and re-shown stays
 * committed to a real grid slot yet pinned invisible + offset — a Prawo-ruchu
 * violation ("abandoned unanimated on screen"). Called before we re-commit a
 * re-shown entry.
 */
function resetNodeMotion(node) {
  const anims = typeof node.getAnimations === 'function' ? node.getAnimations() : [];
  for (const a of anims) {
    try { a.cancel(); } catch (_e) { /* ignore */ }
  }
  node.style.opacity = '';
  node.style.transform = '';
}

/** Fly an entry out, then take it out of layout flow (display:none). */
function hideEntry(entry) {
  entry.visible = false;
  entry.exiting = true;
  entry.rect = null;
  flyOut(entry.node).then(() => {
    // Only hide if it hasn't been re-shown in the meantime.
    if (!entry.visible && widgets.has(entry.id)) {
      entry.node.style.display = 'none';
    }
    // Whether hidden or re-shown, this particular exit is over.
    entry.exiting = false;
  });
}

// ============================================================================
// Debug assertion — pairwise overlap + orb clearance
// ============================================================================
function assertNoOverlap(zone) {
  const live = order
    .map((id) => widgets.get(id))
    .filter((w) => w && w.visible && w.node.style.display !== 'none');

  const rects = live.map((w) => {
    const r = w.node.getBoundingClientRect();
    return { id: w.id, r: rect(r.left, r.top, r.width, r.height) };
  });

  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (intersects(rects[i].r, rects[j].r, -0.5)) {
        console.error('[layout] OVERLAP', rects[i].id, rects[j].id, rects[i].r, rects[j].r);
      }
    }
    if (zone && intersects(rects[i].r, zone, -0.5)) {
      console.error('[layout] OVERLAP (orb zone)', rects[i].id, rects[i].r, zone);
    }
  }
}

// ============================================================================
// Pin handling
// ============================================================================
function togglePin(id) {
  const entry = widgets.get(id);
  if (!entry) return;
  const ui = state.ui;
  if (ui !== 'idle' && ui !== 'talking' && ui !== 'showing') return;
  if (entry.pinned.includes(ui)) {
    unpin(id, [ui]);
  } else {
    pin(id, [ui]);
  }
}

// ============================================================================
// Scheduling — coalesce reflow calls within a frame
// ============================================================================
let pendingReflowOpts = null;
function scheduleReflow(opts) {
  // Merge coalesced opts within a frame. `enterNew` must be true if ANY pending
  // caller wants it — otherwise a resize/setReservedRight reflow (enterNew:false)
  // scheduled just before a widget-add (enterNew:true) would swallow the new
  // widget's fly-in (last-write-loses).
  const enterNew = (opts && opts.enterNew === false) ? false : true;
  if (pendingReflowOpts) {
    pendingReflowOpts.enterNew = pendingReflowOpts.enterNew || enterNew;
  } else {
    pendingReflowOpts = { enterNew };
  }
  if (reflowScheduled) return;
  reflowScheduled = true;
  requestAnimationFrame(() => {
    reflowScheduled = false;
    const finalOpts = pendingReflowOpts || {};
    pendingReflowOpts = null;
    doReflow(finalOpts);
  });
}

// ============================================================================
// State-change choreography
// ============================================================================
function onStateChange({ from, to }) {
  if (to === 'intro') return; // never happens (state machine forbids), guard anyway

  if (from === 'showing' && (to === 'idle' || to === 'talking')) {
    // showing → idle/talking: fly OUT all widgets not pinned for the target,
    // then reflow survivors (which ring the now-centered orb).
    for (const id of order) {
      const entry = widgets.get(id);
      if (!entry) continue;
      if (!entry.pinned.includes(to) && entry.visible) {
        hideEntry(entry);
      }
    }
    // Reflow (emits centered orb:slot; survivors glide into compact ring).
    scheduleReflow();
    return;
  }

  if ((from === 'idle' || from === 'talking') && to === 'showing') {
    // idle/talking → showing: emit the corner orb zone first (via reflow),
    // survivors glide, hidden-but-registered widgets fly in as grid fills.
    scheduleReflow();
    return;
  }

  // idle <-> talking (orb stays centered): pins may differ per state → reflow.
  scheduleReflow();
}

// ============================================================================
// Resize handling — debounced recompute + FLIP glide
// ============================================================================
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    readTokens();
    scheduleReflow({ enterNew: false });
  }, RESIZE_DEBOUNCE);
}

// ============================================================================
// Public API
// ============================================================================
async function init() {
  if (inited) return;
  inited = true;
  layer = document.getElementById(LAYER_ID);
  if (!layer) {
    console.error('[layout] #widget-layer missing — engine disabled');
    return;
  }
  readTokens();
  bus.on('state:change', onStateChange);
  window.addEventListener('resize', onResize, { passive: true });
  // If we boot straight into a non-intro state (or once intro hands off),
  // an initial reflow will publish the orb slot. Do a first pass now so the
  // orb has a target even before any widget exists.
  scheduleReflow({ enterNew: false });
  console.info('[layout] engine ready');
}

/**
 * Add (or, on duplicate id, pulse) a widget. Returns its id.
 * If ui is not 'showing' and the def is not pinned for the current state,
 * defensively switch to 'showing' so the widget is actually visible.
 * @param {object} def frozen def from defineWidget()
 * @returns {string} id
 */
function addWidget(def) {
  if (!def || !def.id) {
    console.error('[layout] addWidget: invalid def', def);
    return null;
  }
  // Duplicate → pulse the existing node, return its id.
  if (widgets.has(def.id)) {
    const existing = widgets.get(def.id);
    if (existing.visible) pulse(existing.node);
    return def.id;
  }

  const { section, body } = buildNode(def);
  section.style.display = 'none'; // hidden until first reflow places it
  layer.appendChild(section);

  /** @type {WidgetEntry} */
  const entry = {
    id: def.id,
    def,
    node: section,
    body,
    pinned: [],
    cleanup: null,
    rect: null,
    visible: false,
    mounted: false,
    exiting: false
  };
  runRender(entry);
  widgets.set(def.id, entry);
  order.push(def.id);

  // Defensive state switch: a non-pinned widget added while idle/talking would
  // never be visible (compact ring shows pins only). Switch to showing.
  const ui = state.ui;
  const pinnedHere = entry.pinned.includes(ui);
  if (ui !== 'showing' && !pinnedHere && ui !== 'intro') {
    state.setUI('showing', 'widget-added');
    // onStateChange schedules the reflow; but if the transition was rejected
    // (shouldn't be), fall back to scheduling here.
    if (state.ui !== 'showing') scheduleReflow();
  } else {
    scheduleReflow();
  }

  emitWidgets();
  return def.id;
}

/**
 * Remove a widget: animate out (fly-out, or fly-to-trash if opts.toTrash),
 * then run its cleanup and drop it. Neighbors reflow into the freed space.
 * @param {string} id
 * @param {{toTrash?:boolean}} [opts]
 */
function removeWidget(id, opts = {}) {
  const entry = widgets.get(id);
  if (!entry) return;
  const toTrash = !!opts.toTrash;

  // Detach from registries immediately so reflow ignores it.
  widgets.delete(id);
  const oi = order.indexOf(id);
  if (oi !== -1) order.splice(oi, 1);

  const finalize = () => {
    const clean = cleanups.get(entry.node);
    if (typeof clean === 'function') {
      try { clean(); } catch (e) { console.error('[layout] cleanup failed', id, e); }
    }
    cleanups.delete(entry.node);
    if (entry.node.isConnected) entry.node.remove();
  };

  const wasVisible = entry.visible && entry.node.style.display !== 'none';
  if (wasVisible) {
    const out = toTrash ? flyToTrash(entry.node) : flyOut(entry.node);
    out.then(finalize);
  } else {
    finalize();
  }

  // Survivors glide to fill the gap.
  scheduleReflow();
  emitWidgets();
}

/**
 * "Schowaj to": stagger all NON-pinned widgets to the trash (40ms apart),
 * play the trash sound once, then reflow survivors.
 * @param {{toTrash?:boolean}} [opts]
 */
function clear(opts = {}) {
  const toTrash = opts.toTrash !== false; // default true
  const ui = state.ui;

  // Victims = widgets not pinned for the current state (or all, if intro/none).
  const victims = order
    .map((id) => widgets.get(id))
    .filter((w) => w && !w.pinned.includes(ui));

  if (victims.length === 0) {
    emitWidgets();
    return;
  }

  if (toTrash) bus.emit('sound:play', { name: 'trash' });

  let i = 0;
  for (const entry of victims) {
    // Drop from registries up-front so reflow ignores them.
    widgets.delete(entry.id);
    const oi = order.indexOf(entry.id);
    if (oi !== -1) order.splice(oi, 1);

    const delay = i * MOTION.stagger;
    i++;

    const finalize = () => {
      const clean = cleanups.get(entry.node);
      if (typeof clean === 'function') {
        try { clean(); } catch (e) { console.error('[layout] cleanup failed', entry.id, e); }
      }
      cleanups.delete(entry.node);
      if (entry.node.isConnected) entry.node.remove();
    };

    const wasVisible = entry.visible && entry.node.style.display !== 'none';
    if (wasVisible && toTrash) {
      flyToTrash(entry.node, delay).then(finalize);
    } else if (wasVisible) {
      flyOut(entry.node, delay).then(finalize);
    } else {
      finalize();
    }
  }

  scheduleReflow();
  emitWidgets();
}

/**
 * Pin a widget for one or more UI states. Pinned widgets survive
 * showing→idle/talking transitions and appear in the compact ring.
 * @param {string} id
 * @param {string[]} uiStates subset of ['idle','talking','showing']
 */
function pin(id, uiStates) {
  const entry = widgets.get(id);
  if (!entry || !Array.isArray(uiStates)) return;
  const valid = uiStates.filter((s) => ['idle', 'talking', 'showing'].includes(s));
  let changed = false;
  for (const s of valid) {
    if (!entry.pinned.includes(s)) { entry.pinned.push(s); changed = true; }
  }
  if (changed) {
    entry.node.classList.add('is-pinned');
    const pinBtn = entry.node.querySelector('.widget-pin');
    if (pinBtn) pinBtn.setAttribute('aria-label', 'Odepnij');
    scheduleReflow();
    emitWidgets();
  }
}

/**
 * Unpin a widget from given states (or all states if omitted).
 * @param {string} id
 * @param {string[]} [uiStates]
 */
function unpin(id, uiStates) {
  const entry = widgets.get(id);
  if (!entry) return;
  if (Array.isArray(uiStates)) {
    entry.pinned = entry.pinned.filter((s) => !uiStates.includes(s));
  } else {
    entry.pinned = [];
  }
  if (entry.pinned.length === 0) {
    entry.node.classList.remove('is-pinned');
    const pinBtn = entry.node.querySelector('.widget-pin');
    if (pinBtn) pinBtn.setAttribute('aria-label', 'Przypnij');
  }
  scheduleReflow();
  emitWidgets();
}

/** @returns {{id:string,pinned:string[],title:string}[]} */
function getWidgets() {
  return order.map((id) => {
    const w = widgets.get(id);
    return { id: w.id, pinned: [...w.pinned], title: w.def.title };
  });
}

/** Chat panel opens/closes → shrink the field from the right, reflow. */
function setReservedRight(pxVal) {
  const next = Math.max(0, Number(pxVal) || 0);
  if (next === reservedRight) return;
  reservedRight = next;
  scheduleReflow({ enterNew: false });
}

/** Recompute slots for the current state + viewport and animate. Public hook. */
function reflow() {
  scheduleReflow({ enterNew: false });
}

// ============================================================================
// Events out
// ============================================================================
function emitWidgets() {
  bus.emit('layout:widgets', { count: order.length, ids: [...order] });
}

// ============================================================================
// Export
// ============================================================================
export const layout = {
  init,
  addWidget,
  removeWidget,
  clear,
  pin,
  unpin,
  getWidgets,
  setReservedRight,
  reflow
};
