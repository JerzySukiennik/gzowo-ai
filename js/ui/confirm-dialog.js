// js/ui/confirm-dialog.js — a tiny reusable confirm dialog. Returns a Promise
// that resolves true ([confirm]) or false ([cancel] / ESC / backdrop click).
// Self-contained: injects its own B&W stylesheet (tokens only), mounts on <body>
// with a high z-index so it sits above every layer. Used by brain-tools for the
// "Gzowo chce zapisać do draftów" confirmation required by CONNECTOR-2ND-BRAIN.md.
//
// GLOBAL RULES: strict B&W via design tokens; only transform/opacity animate;
// English code, PL copy from callers; never throws.

const STYLE_ID = 'gz-confirm-style';
const CSS = `
.gz-confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5);
  background: var(--scrim);
  opacity: 0;
  transition: opacity var(--t-med) var(--ease-out);
}
.gz-confirm-backdrop.is-in { opacity: 1; }
.gz-confirm-card {
  width: 92vw;
  max-width: 440px;
  max-height: 80vh;
  overflow-y: auto;
  /* Surface comes from the shared .glass recipe (liquid glass via glass.js). */
  border-radius: var(--glass-radius-sm);
  padding: var(--space-6);
  opacity: 0;
  transform: scale(0.96);
  transition:
    transform var(--t-med) var(--ease-out),
    opacity var(--t-med) var(--ease-out);
}
.gz-confirm-backdrop.is-in .gz-confirm-card { opacity: 1; transform: scale(1); }
.gz-confirm-title {
  margin: 0 0 var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  letter-spacing: var(--tracking-wide);
  text-transform: uppercase;
  color: var(--fg-dim);
}
.gz-confirm-body {
  margin: 0 0 var(--space-5);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.5;
  letter-spacing: var(--tracking);
  color: var(--fg);
  white-space: pre-wrap;
  word-break: break-word;
}
.gz-confirm-actions {
  display: flex;
  gap: var(--space-3);
  justify-content: flex-end;
}
.gz-confirm-btn {
  appearance: none;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  letter-spacing: var(--tracking-wide);
  text-transform: uppercase;
  padding: var(--space-2) var(--space-4);
  border-radius: var(--glass-radius-sm);
  border: 1px solid var(--line-bright);
  background: transparent;
  color: var(--fg);
}
.gz-confirm-btn:hover { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.gz-confirm-btn.is-primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.gz-confirm-btn.is-primary:hover { opacity: 0.85; }
@media (prefers-reduced-motion: reduce) {
  .gz-confirm-backdrop, .gz-confirm-card { transition-duration: 1ms; }
  .gz-confirm-card, .gz-confirm-backdrop.is-in .gz-confirm-card { transform: none; }
}
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/**
 * @param {{title?:string, body?:string, confirmLabel?:string, cancelLabel?:string}} opts
 * @returns {Promise<boolean>} true if confirmed, false otherwise.
 */
export function confirmDialog({ title = 'Potwierdź', body = '', confirmLabel = 'OK', cancelLabel = 'Anuluj' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    try { injectStyle(); } catch (_e) { /* styles are best-effort */ }

    const backdrop = document.createElement('div');
    backdrop.className = 'gz-confirm-backdrop';

    const card = document.createElement('div');
    card.className = 'gz-confirm-card glass';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    const titleEl = document.createElement('div');
    titleEl.className = 'gz-confirm-title';
    titleEl.textContent = title;

    const bodyEl = document.createElement('div');
    bodyEl.className = 'gz-confirm-body';
    bodyEl.textContent = body;

    const actions = document.createElement('div');
    actions.className = 'gz-confirm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'gz-confirm-btn';
    cancelBtn.textContent = cancelLabel;

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'gz-confirm-btn is-primary';
    confirmBtn.textContent = confirmLabel;

    actions.append(cancelBtn, confirmBtn);
    card.append(titleEl, bodyEl, actions);
    backdrop.appendChild(card);
    // Card clicks must not bubble to the backdrop's cancel handler.
    card.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(backdrop);

    function cleanup() {
      window.removeEventListener('keydown', onKey, true);
      backdrop.classList.remove('is-in');
      // Remove after the fade-out so it animates instead of popping.
      setTimeout(() => { try { backdrop.remove(); } catch (_e) { /* gone */ } }, 320);
    }
    function finish(val) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(val);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    }

    cancelBtn.addEventListener('click', () => finish(false));
    confirmBtn.addEventListener('click', () => finish(true));
    backdrop.addEventListener('click', () => finish(false));
    window.addEventListener('keydown', onKey, true);

    requestAnimationFrame(() => {
      backdrop.classList.add('is-in');
      try { confirmBtn.focus(); } catch (_e) { /* focus best-effort */ }
    });
  });
}
