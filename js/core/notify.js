// js/core/notify.js — push to Jurek's phone via the bridge's /notify (ntfy).
// Shared helper: notifyPhone(title, message) is called by automations, the printer
// watcher, and the notify_phone tool. Gated by the local connector pass (same as
// the 2nd-brain writes) so a random site can't ping the phone. Deployed/no-bridge
// or inactive connector -> honest {ok:false}, never throws.

import { bus } from './event-bus.js';
import { toolRouter } from './tool-router.js';
import { brainConnector, bridgeUrl } from '../connectors/brain-connector.js';

/**
 * Fire a push notification. Silent no-op result when unavailable (returns the
 * honest object; callers may ignore it).
 * @param {string} title
 * @param {string} message
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function notifyPhone(title, message) {
  const msg = String(message == null ? '' : message).trim();
  if (!msg) return { ok: false, error: 'pusta wiadomość' };
  if (!brainConnector.isActivated || !brainConnector.isActivated()) {
    return { ok: false, error: 'push wymaga aktywnego konektora lokalnego (Ustawienia)' };
  }
  let res;
  try {
    res = await fetch(bridgeUrl() + '/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Brain-Pass': brainConnector.getPass() },
      body: JSON.stringify({ title: title || 'Gzowo AI', message: msg })
    });
  } catch (_e) {
    return { ok: false, error: 'most nieosiągalny' };
  }
  if (res.status === 401) return { ok: false, error: 'zły/nieaktywny pass lokalny' };
  if (res.status === 503) return { ok: false, error: 'push niedostępny (brak mostu)' };
  if (!res.ok) return { ok: false, error: 'notify http ' + res.status };
  try {
    const data = await res.json();
    return data && data.ok ? { ok: true } : { ok: false, error: (data && data.error) || 'push nie wyszedł' };
  } catch { return { ok: false, error: 'zła odpowiedź mostu' }; }
}

export async function init() {
  toolRouter.registerTool(
    {
      name: 'notify_phone',
      description: 'Wysyła powiadomienie na telefon Jurka (push przez ntfy). Użyj, gdy Jurek prosi ' +
        '„wyślij mi na telefon …", albo gdy chce dostać przypomnienie/alert poza aplikacją. ' +
        'Wymaga aktywnego konektora lokalnego i zasubskrybowanego tematu w appce ntfy.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Opcjonalny tytuł powiadomienia.' },
          message: { type: 'string', description: 'Treść powiadomienia.' }
        },
        required: ['message']
      }
    },
    async ({ title, message }) => {
      const r = await notifyPhone(title, message);
      if (r.ok) bus.emit('toast', { text: '📲 Wysłano na telefon.', kind: 'info' });
      return r;
    }
  );
}
