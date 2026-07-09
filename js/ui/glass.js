// js/ui/glass.js — Liquid Glass on every UI element of THIS project (Jurek's
// project-wide rule, 2026-07-09 — Gzowo AI only, not a global standard).
// Applies vendor/liquid-glass.js (SVG-refraction backdrop) to EVERY element that
// carries the .glass class — the ones in the DOM at init AND anything added later
// (MutationObserver), so future surfaces/buttons get it for free: just use .glass.
//
// B&W sanctity: chroma is forced to 0 (no prism color fringe) and saturate to 1 —
// pure grayscale refraction. The CSS .glass recipe (tint, border, highlight,
// shadow) stays untouched; the lib only swaps the backdrop-filter for the real
// refraction. Unsupported browsers (Safari/Firefox) get the lib's frosted
// fallback, which matches the old CSS look — honest degradation.
//
// Policy (agreed with Jurek): liquid glass = floating SURFACES and pill BUTTONS
// (islands, cards, dialogs, toasts, trash disc, chat bubble). Small controls
// INSIDE a glass surface stay flat B&W — nested backdrop filters are costly and
// visually noisy on the i9 target.

const OPTS = Object.freeze({
  chroma: 0,        // NO color fringe — strict B&W
  saturate: 1,      // no saturation boost (grayscale UI)
  scale: -80,       // gentle magnifying bulge at the rim
  blur: 3,
  fallbackBlur: 14  // ≈ the old --glass-blur look on Safari/Firefox
});

const applied = new WeakSet();

/** Apply liquid glass to one element (idempotent, never throws). */
export function applyGlass(el, opts) {
  if (!el || applied.has(el)) return;
  applied.add(el);
  try {
    if (typeof window.liquidGlass === 'function') {
      window.liquidGlass(el, { ...OPTS, ...(opts || {}) });
    }
  } catch (err) {
    console.warn('[glass] apply failed (CSS fallback stays)', err);
  }
}

export async function init() {
  if (typeof window.liquidGlass !== 'function') {
    console.warn('[glass] vendor/liquid-glass.js missing — CSS .glass fallback stays.');
    return;
  }
  // Everything already in the DOM…
  document.querySelectorAll('.glass').forEach((el) => applyGlass(el));
  // …and everything any module creates later (settings card, confirm dialog,
  // toasts, widgets — present and future).
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList && n.classList.contains('glass')) applyGlass(n);
        if (n.querySelectorAll) n.querySelectorAll('.glass').forEach((el) => applyGlass(el));
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  console.info('[glass] liquid glass active (auto-applies to .glass)');
}
