// js/skills/printer-watch.js — background Bambu X1C watcher (Jurek #4).
// Polls bambu_status through the tool-router and fires ONE notification when the
// print finishes (GOTOWE) or errors (BŁĄD): a toast, a spoken line if a session
// is live (assistant:announce), and a phone push (ntfy) via notifyPhone. Edge-
// triggered (only on a real state change), so no spam. Silent when HA/Bambu is
// offline (bambu_status returns ok:false -> we just idle).

import { bus } from '../core/event-bus.js';
import { toolRouter } from '../core/tool-router.js';
import { notifyPhone } from '../core/notify.js';

const POLL_MS = 30000;         // 30s — printer state changes are slow
let prevStatus = null;         // last seen status ('DRUKUJE' | 'GOTOWE' | 'BŁĄD' | …)
let started = false;

// States that mean "a print was in progress" — a transition FROM one of these
// TO 'GOTOWE' is a genuine completion (not just the widget showing GOTOWE at boot).
const ACTIVE = new Set(['DRUKUJE', 'PRZYGOTOWANIE', 'NAGRZEWANIE', 'PAUZA']);

function announce(text) {
  bus.emit('toast', { text: '🖨️ ' + text, kind: 'info' });
  bus.emit('assistant:announce', { text });
  notifyPhone('Drukarka Bambu', text);   // fire-and-forget push
}

async function poll() {
  let res;
  try { res = await toolRouter.dispatch('bambu_status', {}); }
  catch { return; }
  if (!res || !res.ok || !res.status) { prevStatus = res && res.status ? res.status : prevStatus; return; }
  const status = res.status;
  const first = prevStatus === null;
  const prev = prevStatus;
  prevStatus = status;
  if (first) return;                     // don't fire on the very first reading
  if (status === prev) return;           // edge-triggered only

  if (status === 'GOTOWE' && ACTIVE.has(prev)) {
    announce('Druk gotowy' + (res.progress_pct != null ? ' (100%)' : '') + '.');
  } else if (status === 'BŁĄD') {
    announce('Błąd druku na Bambu — sprawdź drukarkę.');
  }
}

export async function init() {
  if (started) return;
  started = true;
  setInterval(poll, POLL_MS);
  setTimeout(poll, 5000);   // establish the baseline shortly after boot
}
