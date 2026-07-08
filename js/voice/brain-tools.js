// js/voice/brain-tools.js — "Jurek's 2nd Brain" connector (client side).
// Registers brain_index / brain_read / brain_draft with the tool-router so Gzowo
// (Gemini) can READ Jurek's ClaudeMemory vault and PROPOSE drafts. Every call goes
// through the bridge (local only) with the X-Brain-Pass header. Read-only except
// brain_draft (append to inbox/gzowoai-drafts.md). Honest failure — never fakes.
//
// The pass is a home/LAN password (default '2010', overridable via CONFIG.brain.pass),
// enforced by the bridge on every request. Deployed/lite (no bridge) -> 503 -> the
// tools honestly report "mózg niedostępny".

import { bus } from '../core/event-bus.js';
import { toolRouter } from '../core/tool-router.js';

const CONFIG = window.GZOWO_CONFIG || {};
function pass() { return (CONFIG.brain && CONFIG.brain.pass) || '2010'; }
function bridgeUrl() { return (CONFIG.bridge && CONFIG.bridge.url) || ''; }

async function brainFetch(path, init = {}) {
  let res;
  try {
    res = await fetch(bridgeUrl() + path, {
      ...init,
      headers: { 'X-Brain-Pass': pass(), ...(init.headers || {}) }
    });
  } catch (_e) {
    return { ok: false, error: 'most nieosiągalny — odpal go, żeby mieć dostęp do mózgu' };
  }
  if (res.status === 401) return { ok: false, error: 'złe hasło do mózgu' };
  if (res.status === 503) return { ok: false, error: 'mózg niedostępny (brak mostu lub vaulta)' };
  if (!res.ok) return { ok: false, error: 'brain http ' + res.status };
  try { return { ok: true, data: await res.json() }; }
  catch { return { ok: false, error: 'zła odpowiedź mostu' }; }
}

export async function init() {
  toolRouter.registerTool(
    {
      name: 'brain_index',
      description: 'Wylistuj pliki .md w drugim mózgu Jurka (vault ClaudeMemory: projekty, notatki, wiki, instrukcje). Użyj zanim odpowiesz na pytanie o jego projekty/wiedzę.',
      parameters: { type: 'object', properties: {} }
    },
    async () => {
      const r = await brainFetch('/brain/index');
      if (!r.ok) return r;
      const files = (r.data && r.data.files) || [];
      return { ok: true, count: files.length, files: files.slice(0, 200).map((f) => f.path) };
    }
  );

  toolRouter.registerTool(
    {
      name: 'brain_read',
      description: 'Przeczytaj jeden plik .md z drugiego mózgu Jurka. Podaj ścieżkę względną z brain_index (np. "projects/gsp.md").',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'ścieżka względna .md w vaulcie' } },
        required: ['path']
      }
    },
    async ({ path }) => {
      const r = await brainFetch('/brain/file?path=' + encodeURIComponent(String(path || '')));
      if (!r.ok) return r;
      return { ok: true, path: r.data.path, content: r.data.content };
    }
  );

  toolRouter.registerTool(
    {
      name: 'brain_draft',
      description: 'Zaproponuj wpis do drugiego mózgu Jurka — dopisuje do inbox/gzowoai-drafts.md. Użyj, gdy Jurek prosi o zapisanie/zmianę notatki lub instrukcji: NIE edytujesz plików wprost, tylko dopisujesz draft, który Claude Code rozpisze przy najbliższej sesji.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'krótki temat wpisu' },
          text: { type: 'string', description: 'treść notatki po polsku, zwięźle, z konkretami' }
        },
        required: ['text']
      }
    },
    async ({ topic, text }) => {
      const r = await brainFetch('/brain/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, text })
      });
      if (!r.ok) return r;
      bus.emit('toast', { text: '📝 Zapisano draft do mózgu: „' + String(topic || 'notatka').slice(0, 40) + '”', kind: 'info' });
      return { ok: true, saved: true };
    }
  );
}
