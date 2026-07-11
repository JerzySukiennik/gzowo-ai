// js/skills/scenes.js — named light SCENES (Jurek #1: „tryb kino", „tryb start rakiety").
// A scene is an ordered list of steps run on demand through the tool-router. Each
// step targets a ROOM (control_room) or a single ENTITY (control_home), with an
// optional brightness value — or a generic {tool,args} for power moves. Persisted
// per-account in localStorage (same pattern as connectors/skills/automations).

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';
import { toolRouter } from '../core/tool-router.js';

function ns() {
  const u = state.get('user');
  return 'gz.scenes.' + (u && u.username ? u.username : '__anon');
}
function load() { try { return JSON.parse(localStorage.getItem(ns()) || '[]'); } catch { return []; } }
function save(list) { try { localStorage.setItem(ns(), JSON.stringify(list)); } catch (_e) { /* private mode */ } }
function slug(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[ąćęłńóśźż]/g, (c) => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }[c] || c))
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28);
}

// Normalize one step into {tool, args}. Accepts {room,service,value},
// {entity_id,service,value}, or explicit {tool,args}.
function stepToCall(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.tool) return { tool: String(s.tool), args: s.args || {} };
  const service = String(s.service || 'turn_on');
  if (s.room) {
    const args = { room: String(s.room), service };
    if (s.value != null) args.value = Number(s.value);
    return { tool: 'control_room', args };
  }
  if (s.entity_id) {
    const args = { entity_id: String(s.entity_id), service };
    if (s.value != null) args.value = Number(s.value);
    return { tool: 'control_home', args };
  }
  return null;
}

async function runScene(scene) {
  const steps = Array.isArray(scene.steps) ? scene.steps : [];
  const results = [];
  for (const s of steps) {
    const call = stepToCall(s);
    if (!call) { results.push({ ok: false, error: 'zły krok' }); continue; }
    const r = await toolRouter.dispatch(call.tool, call.args);
    results.push({ tool: call.tool, ok: !!(r && r.ok), error: r && r.error });
  }
  const okCount = results.filter((r) => r.ok).length;
  return { okCount, total: steps.length, results };
}

export async function init() {
  toolRouter.registerTool(
    {
      name: 'create_scene',
      description: 'Tworzy SCENĘ — nazwany zestaw akcji świateł uruchamiany jednym poleceniem ' +
        '(„tryb kino", „tryb start rakiety"). steps = JSON tablica kroków. Każdy krok: ' +
        '{"room":"salon","service":"turn_on","value":20} (value 0–100 = jasność) albo ' +
        '{"entity_id":"light.hubert","service":"turn_off"}. Pokoje z mapy Jurka. Przykład kina: ' +
        '[{"room":"salon","service":"turn_on","value":15}]. Odpalasz przez run_scene albo „włącz tryb kino".',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nazwa sceny, np. „kino".' },
          steps: { type: 'string', description: 'JSON tablica kroków (patrz opis).' }
        },
        required: ['name', 'steps']
      }
    },
    async ({ name, steps }) => {
      const id = slug(name);
      if (!id) return { ok: false, error: 'podaj nazwę sceny' };
      let parsed;
      try { parsed = typeof steps === 'object' ? steps : JSON.parse(String(steps)); }
      catch { return { ok: false, error: 'steps musi być poprawnym JSON-em (tablica kroków)' }; }
      if (!Array.isArray(parsed) || !parsed.length) return { ok: false, error: 'steps musi być niepustą tablicą' };
      const list = load().filter((s) => s.id !== id);
      list.push({ id, name: String(name).trim(), steps: parsed, created: Date.now() });
      save(list);
      bus.emit('toast', { text: '🎬 Scena „' + name + '" gotowa (' + parsed.length + ' kroków).', kind: 'info' });
      return { ok: true, created: id, steps: parsed.length };
    }
  );

  toolRouter.registerTool(
    {
      name: 'run_scene',
      description: 'Uruchamia zapisaną scenę po nazwie („włącz tryb kino", „odpal scenę start rakiety").',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nazwa sceny.' } },
        required: ['name']
      }
    },
    async ({ name }) => {
      const id = slug(name);
      const scene = load().find((s) => s.id === id) || load().find((s) => s.id.includes(id));
      if (!scene) {
        const names = load().map((s) => s.name);
        return { ok: false, error: 'nie mam sceny „' + name + '". Zapisane: ' + (names.length ? names.join(', ') : 'żadne') + '.' };
      }
      const r = await runScene(scene);
      return { ok: r.okCount > 0, scene: scene.name, done: r.okCount, total: r.total };
    }
  );

  toolRouter.registerTool(
    {
      name: 'list_scenes',
      description: 'Wylistuj sceny zbudowane przez Jurka (nazwa + liczba kroków).',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    async () => ({ ok: true, scenes: load().map((s) => ({ name: s.name, steps: (s.steps || []).length })) })
  );

  toolRouter.registerTool(
    {
      name: 'delete_scene',
      description: 'Usuwa scenę po nazwie.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nazwa sceny.' } },
        required: ['name']
      }
    },
    async ({ name }) => {
      const id = slug(name);
      const before = load();
      const after = before.filter((s) => s.id !== id);
      if (after.length === before.length) return { ok: false, error: 'nie mam sceny „' + name + '"' };
      save(after);
      return { ok: true, deleted: id };
    }
  );
}
