// js/core/tool-router.js — foundation-owned, NEW shared infra.
// The backbone that fixes the "says it hid the widgets but didn't" bug: every
// assistant tool call runs through dispatch(), which returns the REAL result of
// the handler. gemini-live sends that real object back as the functionResponse,
// so the model can never claim a success the handler didn't confirm.
//
// GLOBAL RULES honored: logic only (no DOM/color); English comments; every method
// is idempotent-safe and dispatch() NEVER throws or rejects.
//
// -------- Registration example --------
//   import { toolRouter } from '../core/tool-router.js';
//
//   toolRouter.registerTool(
//     {
//       name: 'hide_widgets',
//       description: 'Chowa wszystkie widgety pokazane na ekranie.',
//       parameters: { type: 'object', properties: {}, required: [] }
//     },
//     async () => {
//       const { hidden } = layout.clear({ toTrash: true, all: true });
//       return { ok: true, hidden };            // REAL result -> functionResponse
//     }
//   );
//
//   toolRouter.registerWidget('weather', () => weatherWidgetDef);
//
// gemini-live at connect time calls toolRouter.getDeclarations(), so every module
// MUST register its tools/widgets during its own init().

import { bus } from './event-bus.js';

// Hard ceiling on how long a single tool handler may run before we give up on it.
const DISPATCH_TIMEOUT_MS = 8000;

/** @type {Map<string, {declaration: object, handler: (args:object)=>Promise<object>|object}>} */
const tools = new Map();
/** @type {Map<string, Function>} */
const widgetFactories = new Map();

/**
 * Register (or overwrite) an assistant-callable tool.
 * @param {{name:string, description?:string, parameters?:object}} declaration
 *        A Gemini functionDeclaration.
 * @param {(args:object)=>Promise<object>|object} handler
 *        Async handler returning a plain JSON result object, e.g.
 *        {ok:true,hidden:3} or {ok:false,error:'po polsku'}.
 */
function registerTool(declaration, handler) {
  if (!declaration || typeof declaration.name !== 'string' || !declaration.name) {
    console.error('[tool-router] registerTool: declaration.name is required', declaration);
    return;
  }
  if (typeof handler !== 'function') {
    console.error('[tool-router] registerTool: handler must be a function for', declaration.name);
    return;
  }
  if (tools.has(declaration.name)) {
    console.warn('[tool-router] tool overwritten:', declaration.name);
  }
  tools.set(declaration.name, { declaration, handler });
}

/**
 * Register (or overwrite) a widget factory by name.
 * @param {string} name
 * @param {Function} factory  factory() -> frozen def from defineWidget()
 */
function registerWidget(name, factory) {
  if (typeof name !== 'string' || !name) {
    console.error('[tool-router] registerWidget: name is required', name);
    return;
  }
  if (typeof factory !== 'function') {
    console.error('[tool-router] registerWidget: factory must be a function for', name);
    return;
  }
  if (widgetFactories.has(name)) {
    console.warn('[tool-router] widget overwritten:', name);
  }
  widgetFactories.set(name, factory);
}

/**
 * @param {string} name
 * @returns {Function|null} the factory, or null if unregistered.
 */
function getWidgetFactory(name) {
  return widgetFactories.get(name) || null;
}

/** @returns {string[]} names of all registered widgets. */
function listWidgets() {
  return [...widgetFactories.keys()];
}

/**
 * Build the Gemini `tools` array fresh on every call, so gemini-live always sees
 * whatever is registered at connect time (modules register during their init()).
 * @returns {[{functionDeclarations: object[]}]}
 */
function getDeclarations() {
  return [{
    functionDeclarations: [...tools.values()].map((t) => t.declaration)
  }];
}

/**
 * Run a tool and return its REAL result. NEVER throws, NEVER rejects.
 *   - unknown name        -> {ok:false, error:'unknown-tool'}
 *   - handler throws       -> {ok:false, error:String(message)}
 *   - runs past 8s         -> {ok:false, error:'timeout'}
 *   - non-object result    -> wrapped as {ok:true, value:result}
 * After settling, broadcasts 'assistant:tool' {name, args} for informational UI.
 * @param {string} name
 * @param {object} [args]
 * @returns {Promise<object>}
 */
async function dispatch(name, args = {}) {
  const safeArgs = args || {};
  const entry = tools.get(name);
  let result;

  if (!entry) {
    result = { ok: false, error: 'unknown-tool' };
  } else {
    let timer = 0;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), DISPATCH_TIMEOUT_MS);
    });
    try {
      // Promise.resolve().then(...) turns a synchronous throw in the handler into
      // a rejection that this try/catch can absorb.
      const run = Promise.resolve().then(() => entry.handler(safeArgs));
      result = await Promise.race([run, timeout]);
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
    // Coerce any non-object result into an object so it is always safe to send as
    // a Gemini functionResponse.
    if (result === null || typeof result !== 'object') {
      result = { ok: true, value: result };
    }
  }

  try {
    bus.emit('assistant:tool', { name, args: safeArgs });
  } catch (_e) {
    /* bus.emit is already isolated; guard anyway so dispatch never rejects */
  }
  return result;
}

export const toolRouter = {
  registerTool,
  registerWidget,
  getWidgetFactory,
  listWidgets,
  getDeclarations,
  dispatch
};
