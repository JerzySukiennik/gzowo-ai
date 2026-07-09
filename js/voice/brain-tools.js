// js/voice/brain-tools.js — "Jurek's 2nd Brain" connector (client side).
// Registers brain_index / brain_read / brain_draft with the tool-router so Gzowo
// (Gemini) can READ Jurek's ClaudeMemory vault and PROPOSE drafts. Every call goes
// through the bridge (local only) with the X-Brain-Pass header. Read-only except
// brain_draft (append to inbox/gzowoai-drafts.md). Honest failure — never fakes.
//
// Activation: the connector is INACTIVE until Jurek activates it with the LAN pass
// in Settings (brain-connector.js is the shared source of truth). While inactive,
// all three tools honestly report "connector nieaktywny". The pass is enforced by
// the bridge on every request too. Deployed/lite (no bridge) -> 503 -> honest fail.
//
// Draft safety (CONNECTOR-2ND-BRAIN.md): a write is NEVER silent. brain_draft does
// NOT block on the confirm dialog (the tool-router has an 8s handler ceiling) — it
// returns immediately as {pending:true} and opens a "[Zapisz]/[Anuluj]" dialog; the
// actual POST fires only after Jurek confirms. The tool description tells the model
// to say it is AWAITING confirmation, never to claim it already saved.

import { bus } from '../core/event-bus.js';
import { toolRouter } from '../core/tool-router.js';
import { brainConnector, bridgeUrl } from '../connectors/brain-connector.js';
import { confirmDialog } from '../ui/confirm-dialog.js';

// Shared "connector not activated yet" result. Guides the model to point Jurek at
// Settings instead of retrying blindly.
function notActivated() {
  return {
    ok: false,
    error: 'Connector „Jurek\'s 2nd Brain” jest nieaktywny. Jurek musi go aktywować hasłem w Ustawieniach (powiedz „otwórz ustawienia”).'
  };
}

async function brainFetch(path, init = {}) {
  let res;
  try {
    res = await fetch(bridgeUrl() + path, {
      ...init,
      headers: { 'X-Brain-Pass': brainConnector.getPass(), ...(init.headers || {}) }
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

// Non-blocking draft confirmation: opens the dialog, POSTs only on [Zapisz], and
// reports the true outcome via a toast. Fire-and-forget from brain_draft.
async function confirmAndSaveDraft(topic, text) {
  let ok = false;
  try {
    ok = await confirmDialog({
      title: 'Zapis do 2nd Brain',
      body: (topic ? 'Temat: ' + topic + '\n\n' : '') + text,
      confirmLabel: 'Zapisz',
      cancelLabel: 'Anuluj'
    });
  } catch (_e) { ok = false; }

  if (!ok) { bus.emit('toast', { text: 'Anulowano zapis draftu.', kind: 'info' }); return; }

  const r = await brainFetch('/brain/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, text })
  });
  if (!r.ok) { bus.emit('toast', { text: 'Nie zapisano draftu: ' + (r.error || 'błąd'), kind: 'warn' }); return; }
  bus.emit('toast', { text: '📝 Zapisano draft do mózgu: „' + String(topic || 'notatka').slice(0, 40) + '”', kind: 'info' });
}

export async function init() {
  toolRouter.registerTool(
    {
      name: 'brain_index',
      description: 'Wylistuj pliki .md w drugim mózgu Jurka (vault ClaudeMemory: projekty, notatki, wiki, instrukcje). Użyj zanim odpowiesz na pytanie o jego projekty/wiedzę.',
      parameters: { type: 'object', properties: {} }
    },
    async () => {
      if (!brainConnector.isActivated()) return notActivated();
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
      if (!brainConnector.isActivated()) return notActivated();
      const r = await brainFetch('/brain/file?path=' + encodeURIComponent(String(path || '')));
      if (!r.ok) return r;
      return { ok: true, path: r.data.path, content: r.data.content };
    }
  );

  toolRouter.registerTool(
    {
      name: 'brain_draft',
      description: 'Zaproponuj wpis do drugiego mózgu Jurka (dopisze do inbox/gzowoai-drafts.md). Użyj, gdy Jurek prosi o zapisanie/zmianę notatki lub instrukcji: NIE edytujesz plików wprost. WAŻNE: zapis wymaga potwierdzenia Jurka w osobnym oknie — po wywołaniu tego narzędzia powiedz, że przygotowałeś draft i CZEKASZ na jego potwierdzenie; NIE mów, że już zapisałeś.',
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
      if (!brainConnector.isActivated()) return notActivated();
      const clean = String(text || '').trim();
      if (!clean) return { ok: false, error: 'pusty draft — nie ma czego zapisać' };
      // Fire-and-forget: the dialog + POST outlive this handler so we never hit the
      // 8s dispatch ceiling waiting for a human click.
      confirmAndSaveDraft(topic, clean);
      return {
        ok: true,
        pending: true,
        message: 'Draft przygotowany — czeka na potwierdzenie Jurka w oknie. Powiedz, że czekasz na jego OK.'
      };
    }
  );
}
