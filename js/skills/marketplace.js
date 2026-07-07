// js/skills/marketplace.js — load-path shim (skills-owned).
//
// The real MARKETPLACE module lives at js/widgets/marketplace.js (per the module
// contract: it's a widget that styles itself inside .widget-body). The foundation
// boot orchestrator (js/main.js), however, wires the marketplace entry point at
// './skills/marketplace.js'. main.js is foundation-owned and must not be edited,
// so this file bridges the two: it re-exports the real implementation from its
// contract location, making the foundation's dynamic import resolve to the exact
// same `init` and `marketplaceDef` exports.
//
// Re-export only — zero logic, zero side effects. `export *` forwards every named
// export (init, marketplaceDef), so main.js's `marketplaceMod.init()` runs the
// real module's init exactly once.
export * from '../widgets/marketplace.js';
