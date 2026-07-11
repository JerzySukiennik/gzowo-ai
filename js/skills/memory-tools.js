// js/skills/memory-tools.js — Gzowo's long-term memory about Jurek (v4-f).
// Wraps the existing facts store (memory.saveFact/loadFacts/forgetFact) and the
// transcript log (memory.searchTranscripts) as assistant tools, so Gzowo can
// actually REMEMBER preferences ("Lubię pizzę") and recall past conversations.
//
// Facts are injected into every new session's system prompt (gemini-live reads
// memory.getFactsCached() at connect), so a remembered fact sticks across
// sessions and devices (Firestore-backed, local mirror offline).

import { bus } from '../core/event-bus.js';
import { toolRouter } from '../core/tool-router.js';
import { memory } from '../memory/firebase.js';

export async function init() {
  toolRouter.registerTool(
    {
      name: 'remember_fact',
      description: 'Zapamiętuje NA STAŁE fakt/preferencję o Jurku (działa między sesjami i ' +
        'urządzeniami). Wywołuj SAM, gdy Jurek mówi coś trwałego o sobie: upodobania („lubię ' +
        'pizzę", „nie znoszę poranków"), nawyki, ważne osoby/rzeczy, ustalenia. Pisz fakt zwięźle ' +
        'w 3. osobie, np. „Jurek lubi pizzę". Nie zapamiętuj rzeczy jednorazowych ani wrażliwych ' +
        'danych. Po zapisie tylko krótko potwierdź.',
      parameters: {
        type: 'object',
        properties: { fact: { type: 'string', description: 'Fakt o Jurku, zwięźle, 3. osoba.' } },
        required: ['fact']
      }
    },
    async ({ fact }) => {
      const clean = String(fact || '').trim();
      if (!clean) return { ok: false, error: 'pusty fakt' };
      await memory.saveFact(clean);
      bus.emit('toast', { text: '🧠 Zapamiętałem: ' + clean, kind: 'info' });
      return { ok: true, remembered: clean };
    }
  );

  toolRouter.registerTool(
    {
      name: 'list_facts',
      description: 'Zwraca to, co Gzowo zapamiętał o Jurku (lista faktów/preferencji).',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    async () => {
      const facts = await memory.loadFacts();
      return { ok: true, count: facts.length, facts };
    }
  );

  toolRouter.registerTool(
    {
      name: 'forget_fact',
      description: 'Usuwa zapamiętane fakty pasujące do frazy (np. „pizza" usunie „Jurek lubi ' +
        'pizzę"). Użyj, gdy Jurek mówi „zapomnij, że …", „to już nieaktualne".',
      parameters: {
        type: 'object',
        properties: { match: { type: 'string', description: 'Fraza — usunie zawierające ją fakty.' } },
        required: ['match']
      }
    },
    async ({ match }) => {
      const removed = await memory.forgetFact(match);
      if (!removed.length) return { ok: false, error: 'nie znalazłem faktu pasującego do „' + String(match || '').trim() + '"' };
      bus.emit('toast', { text: '🧹 Zapomniałem: ' + removed.join('; '), kind: 'info' });
      return { ok: true, removed };
    }
  );

  toolRouter.registerTool(
    {
      name: 'search_history',
      description: 'Przeszukuje historię waszych rozmów (transkrypty) po frazie — „co mówiłem o X?", ' +
        '„o czym rozmawialiśmy w sprawie …". Zwraca pasujące wypowiedzi (kto + co). Historia jest ' +
        'ograniczona do zapisanych transkryptów; jeśli pusto, powiedz wprost, że nic nie znalazłeś.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Szukana fraza.' } },
        required: ['query']
      }
    },
    async ({ query }) => {
      const q = String(query || '').trim();
      if (!q) return { ok: false, error: 'podaj czego szukać' };
      const rows = await memory.searchTranscripts(q, 12);
      return {
        ok: true,
        count: rows.length,
        results: rows.map((r) => ({ kto: r.role === 'gzowo' ? 'Gzowo' : 'Jurek', tekst: r.text }))
      };
    }
  );
}
