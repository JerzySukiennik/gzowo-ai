// bridge/notify.js — push to Jurek's phone via ntfy.sh (free, no account).
// The bridge publishes to https://ntfy.sh/<NTFY_TOPIC>; Jurek subscribes to that
// topic in the ntfy iOS app. Topic lives in bridge/.env only (kept off the client).
// Empty topic -> honest {ok:false}. Never throws.

const NTFY_BASE = 'https://ntfy.sh';

export function notifyConfigured() {
  return Boolean((process.env.NTFY_TOPIC || '').trim());
}

/**
 * Send a push. title optional; message required.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function pushNotify(title, message) {
  const topic = (process.env.NTFY_TOPIC || '').trim();
  if (!topic) return { ok: false, error: 'push nieskonfigurowany (NTFY_TOPIC w bridge/.env)' };
  const msg = String(message == null ? '' : message).trim();
  if (!msg) return { ok: false, error: 'pusta wiadomość' };
  const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
  const t = String(title || '').trim();
  if (t) {
    // ntfy title header must be latin-1 safe; strip non-ASCII to avoid a 400.
    const ascii = t.replace(/[^\x20-\x7E]/g, '').trim();
    if (ascii) headers.Title = ascii;
  }
  try {
    const res = await fetch(NTFY_BASE + '/' + encodeURIComponent(topic), {
      method: 'POST',
      headers,
      body: msg,
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return { ok: false, error: 'ntfy http ' + res.status };
    return { ok: true, topic };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
