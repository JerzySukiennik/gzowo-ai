// js/skills/apple-notes.js — shopping list / TODO synced with Apple Notes.
// Adds a line to (or reads) a note by title through the bridge's /apple-notes
// endpoint (osascript on the Mac). The note syncs via iCloud, so it shows on
// Jurek's iPhone too. Default list = "Zakupy"; any Notes title works (e.g. TODO).
//
// Local-only (needs the Mac bridge) + gated by the local connector pass. First
// use pops a one-time macOS "control Notes" permission dialog. Honest failures.

import { bus } from '../core/event-bus.js';
import { toolRouter } from '../core/tool-router.js';
import { brainConnector, bridgeUrl } from '../connectors/brain-connector.js';

const DEFAULT_LIST = 'Zakupy';

function notActive() {
  return { ok: false, error: 'Notatki Apple wymagają aktywnego konektora lokalnego (powiedz „otwórz ustawienia").' };
}

async function notesFetch(path, init = {}) {
  let res;
  try {
    res = await fetch(bridgeUrl() + path, {
      ...init,
      headers: { 'X-Brain-Pass': brainConnector.getPass(), ...(init.headers || {}) }
    });
  } catch (_e) {
    return { ok: false, error: 'most nieosiągalny — Notatki działają tylko lokalnie (Mac z mostem)' };
  }
  if (res.status === 401) return { ok: false, error: 'zły/nieaktywny pass lokalny' };
  if (res.status === 503) return { ok: false, error: 'Notatki niedostępne (brak mostu)' };
  if (!res.ok) return { ok: false, error: 'apple-notes http ' + res.status };
  try { return await res.json(); } catch { return { ok: false, error: 'zła odpowiedź mostu' }; }
}

export async function init() {
  toolRouter.registerTool(
    {
      name: 'shopping_add',
      description: 'Dodaje pozycję do listy w Apple Notes (domyślnie notatka „Zakupy"), która ' +
        'synchronizuje się na iPhone Jurka. Użyj do „dopisz do zakupów …", „dodaj do listy …". ' +
        'Pole list pozwala celować w inną notatkę (np. „Gzowo TODO") — wtedy działa jak lista zadań.',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'Co dopisać (np. „mleko").' },
          list: { type: 'string', description: 'Nazwa notatki Apple (domyślnie „Zakupy"). Może być „Gzowo TODO".' }
        },
        required: ['item']
      }
    },
    async ({ item, list }) => {
      if (!brainConnector.isActivated()) return notActive();
      const line = String(item || '').trim();
      if (!line) return { ok: false, error: 'podaj co dopisać' };
      const note = String(list || '').trim() || DEFAULT_LIST;
      const r = await notesFetch('/apple-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note, line })
      });
      if (!r.ok) return r;
      bus.emit('toast', { text: '🛒 Dopisano do „' + note + '": ' + line, kind: 'info' });
      return { ok: true, note, added: line };
    }
  );

  toolRouter.registerTool(
    {
      name: 'shopping_read',
      description: 'Czyta listę z Apple Notes (domyślnie „Zakupy") — zwraca pozycje. Użyj do „co ' +
        'mam na liście zakupów?", „przeczytaj listę". Pole list = inna notatka (np. „Gzowo TODO").',
      parameters: {
        type: 'object',
        properties: {
          list: { type: 'string', description: 'Nazwa notatki Apple (domyślnie „Zakupy").' }
        },
        required: []
      }
    },
    async ({ list }) => {
      if (!brainConnector.isActivated()) return notActive();
      const note = String(list || '').trim() || DEFAULT_LIST;
      const r = await notesFetch('/apple-notes?note=' + encodeURIComponent(note));
      if (!r.ok) return r;
      if (r.missing) return { ok: true, note, items: [], note_missing: true, message: 'Notatka „' + note + '" jeszcze nie istnieje — dodam ją przy pierwszym wpisie.' };
      return { ok: true, note, count: (r.items || []).length, items: r.items || [] };
    }
  );
}
