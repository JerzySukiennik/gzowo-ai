// js/widgets/widget-base.js — layout-owned, FINAL.
// Data-only helpers for the layout engine. NO init(): widget modules import
// defineWidget() to describe a widget, then hand the frozen def to
// layout.addWidget(def). The engine (layout-engine.js) is the sole builder of
// the DOM frame (<section class="widget"> … </section>); this file only
// normalizes + freezes definitions and exposes a tiny DOM helper `el`.
//
// B&W law: the frame chrome (header, controls) is strict grayscale from tokens.
// Color is allowed ONLY inside .widget-body, which def.render() fills.

/**
 * Normalize + freeze a widget definition for layout.addWidget().
 *
 * @param {object}   spec
 * @param {string}   spec.id              stable unique id (duplicate add -> pulse)
 * @param {string}   spec.title           header label (rendered uppercase, mono)
 * @param {string|null} [spec.color]      optional accent used INSIDE the body only
 * @param {'sm'|'md'|'lg'} [spec.size]    hint; the engine still owns final geometry
 * @param {(bodyEl:HTMLElement, ctx:{bus,state,refresh:()=>void}) => (void|(()=>void))} spec.render
 *        Fills the body element. May return a cleanup fn, called on remove.
 * @returns {Readonly<{id:string,title:string,color:string|null,size:string,render:Function}>}
 */
export function defineWidget({ id, title, color = null, size = 'md', render }) {
  if (!id || typeof id !== 'string') {
    throw new Error('[widget-base] defineWidget: `id` (non-empty string) is required');
  }
  if (typeof render !== 'function') {
    throw new Error(`[widget-base] defineWidget(${id}): \`render\` must be a function`);
  }
  const SIZES = ['sm', 'md', 'lg'];
  const normalizedSize = SIZES.includes(size) ? size : 'md';
  return Object.freeze({
    id: String(id),
    title: title == null ? '' : String(title),
    color: color == null ? null : String(color),
    size: normalizedSize,
    render
  });
}

/**
 * Tiny DOM helper. Creates an element, optionally sets a className and text.
 * Uses textContent only — never innerHTML — so it is injection-safe.
 *
 * @param {string} tag                e.g. 'div', 'span', 'button'
 * @param {string} [className]        space-separated class list (or '')
 * @param {string} [text]             textContent
 * @returns {HTMLElement}
 */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
