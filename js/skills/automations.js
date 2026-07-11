// js/skills/automations.js — AUTOMATYZACJE (Jurek: „żeby sam gasił lampy itp.").
//
// A tiny time/solar-triggered rule engine the ASSISTANT owns end to end. Each
// automation fires a REAL tool call through toolRouter.dispatch() at a chosen
// time of day (or at sunset/sunrise), e.g. control_room{room:'dom',
// service:'turn_off'} every night at 23:00. The user never edits a config file —
// Gzowo creates/lists/deletes them by voice.
//
// Design mirrors build-flow.js:
//   - per-account persistence in localStorage (same ns pattern),
//   - honest results (every tool returns {ok,...}); nothing is faked,
//   - a single setInterval scheduler (20s) — cheap, tab-friendly.
//
// Trigger types:
//   { type:'time',    at:'HH:MM' }               daily at a wall-clock time
//   { type:'sunset',  offset:min }               daily at sunset (+/- offset)
//   { type:'sunrise', offset:min }               daily at sunrise (+/- offset)
//
// Action: any registered tool by name + a plain args object. The dominant case
// is lights (control_room / control_home), but set_theme / hide_widgets /
// show_weather / start_timer etc. all work — it's just a dispatch.
//
// Fire-once-per-day is guarded by lastFired = 'YYYY-MM-DD@HH:MM' persisted on the
// automation, so a restart never double-fires and a missed tick catches up inside
// a 2-minute window.

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';
import { toolRouter } from '../core/tool-router.js';
import { notifyPhone } from '../core/notify.js';

const CONFIG = window.GZOWO_CONFIG || {};

// ---- Per-account persistence (same shape as build-flow.js) ------------------
function ns() {
  const u = state.get('user');
  return 'gz.automations.' + (u && u.username ? u.username : '__anon');
}
function load() { try { return JSON.parse(localStorage.getItem(ns()) || '[]'); } catch { return []; } }
function save(list) { try { localStorage.setItem(ns(), JSON.stringify(list)); } catch (_e) { /* private mode */ } }

function slug(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[ąćęłńóśźż]/g, (c) => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' }[c] || c))
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28);
}

// ---- Time helpers -----------------------------------------------------------
function pad2(n) { return String(n).padStart(2, '0'); }
function todayStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function nowMinutes(d) { return d.getHours() * 60 + d.getMinutes(); }

/** 'HH:MM' -> minutes since midnight, or null if malformed. */
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
function minutesToHHMM(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}

// ---- Sunset / sunrise (Open-Meteo daily, cached per day) --------------------
let _solar = { day: null, sunrise: null, sunset: null };   // minutes since midnight
async function solarMinutes(kind) {
  const d = new Date();
  const day = todayStr(d);
  if (_solar.day !== day || _solar[kind] == null) {
    try {
      const lat = (CONFIG.weather && CONFIG.weather.lat) ?? 52.6154;
      const lon = (CONFIG.weather && CONFIG.weather.lon) ?? 21.0888;
      const url = 'https://api.open-meteo.com/v1/forecast' +
        `?latitude=${lat}&longitude=${lon}&daily=sunrise,sunset&timezone=auto&forecast_days=1`;
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      const sr = data.daily && data.daily.sunrise && data.daily.sunrise[0];
      const ss = data.daily && data.daily.sunset && data.daily.sunset[0];
      // ISO like '2026-07-11T04:31' — take the local HH:MM after the 'T'.
      const toMin = (iso) => {
        const t = String(iso || '').split('T')[1];
        return t ? parseHHMM(t.slice(0, 5)) : null;
      };
      _solar = { day, sunrise: toMin(sr), sunset: toMin(ss) };
    } catch (_e) {
      return null;   // no network -> solar triggers simply don't fire this tick
    }
  }
  return _solar[kind];
}

/** Target minutes-since-midnight for an automation TODAY, or null if unknown. */
async function targetMinutes(a) {
  const t = a.trigger || {};
  if (t.type === 'time') return parseHHMM(t.at);
  if (t.type === 'sunset' || t.type === 'sunrise') {
    const base = await solarMinutes(t.type === 'sunset' ? 'sunset' : 'sunrise');
    if (base == null) return null;
    return base + (Number(t.offset) || 0);
  }
  return null;
}

// ---- Firing -----------------------------------------------------------------
const FIRE_WINDOW_MIN = 2;   // catch-up window if a tick is late / app just opened

async function fireAutomation(a, reason) {
  let result;
  try {
    result = await toolRouter.dispatch(a.action.tool, a.action.args || {});
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e) };
  }
  const ok = !!(result && result.ok);
  const label = a.name || a.id;
  // Toast always (it may fire with no voice session, e.g. 23:00). Speak only when
  // a session is live (assistant:announce is a no-op without an open session).
  const say = a.say && String(a.say).trim();
  if (ok) {
    bus.emit('toast', { text: '⏰ ' + label + (say ? ' — ' + say : ''), kind: 'info' });
    if (say) bus.emit('assistant:announce', { text: say });
    // Push to the phone too, so a 23:00 rule reaches Jurek even away from the app.
    if (reason !== 'manual') notifyPhone('Automatyzacja: ' + label, say || 'Wykonano.');
  } else {
    const why = (result && result.error) ? ' (' + result.error + ')' : '';
    bus.emit('toast', { text: '⏰ ' + label + ' — nie udało się' + why, kind: 'warn' });
  }
  bus.emit('automation:fired', { id: a.id, ok, reason: reason || 'schedule' });
  return { ok, result };
}

// ---- Scheduler --------------------------------------------------------------
let _timer = null;
let _ticking = false;

async function tick() {
  if (_ticking) return;
  _ticking = true;
  try {
    const list = load();
    if (!list.length) return;
    const d = new Date();
    const nowMin = nowMinutes(d);
    const stamp = todayStr(d);
    let dirty = false;

    for (const a of list) {
      if (!a || a.enabled === false || !a.action || !a.action.tool) continue;
      const tgt = await targetMinutes(a);
      if (tgt == null) continue;
      const key = stamp + '@' + minutesToHHMM(tgt);
      if (a.lastFired === key) continue;                 // already fired today
      const delta = nowMin - tgt;
      if (delta < 0 || delta >= FIRE_WINDOW_MIN) continue; // not in the fire window
      a.lastFired = key;                                  // mark BEFORE firing (no double)
      dirty = true;
      fireAutomation(a, 'schedule');                      // fire-and-forget
    }
    if (dirty) save(list);
  } catch (e) {
    console.warn('[automations] tick failed', e);
  } finally {
    _ticking = false;
  }
}

function startScheduler() {
  if (_timer) return;
  _timer = setInterval(tick, 20000);   // 20s — minute-resolution triggers, cheap
  setTimeout(tick, 3000);              // one early check after boot
}

// ---- Public summary (for list/description) ----------------------------------
function describeTrigger(t) {
  if (!t) return '—';
  if (t.type === 'time') return 'codziennie ' + t.at;
  const off = Number(t.offset) || 0;
  const base = t.type === 'sunset' ? 'zachód słońca' : 'wschód słońca';
  if (!off) return 'codziennie o ' + base;
  return 'codziennie ' + (off > 0 ? off + ' min po ' : Math.abs(off) + ' min przed ') + base;
}

// ============================================================================
// Tools
// ============================================================================
export async function init() {
  toolRouter.registerTool(
    {
      name: 'create_automation',
      description: 'Tworzy AUTOMATYZACJĘ: o wybranej porze dnia (albo o wschodzie/zachodzie słońca) ' +
        'Gzowo SAMO wykona akcję — najczęściej zgaszenie/zapalenie świateł. Podaj name + kiedy ' +
        '(time="HH:MM" ALBO event="sunset"/"sunrise", opcjonalnie offset_min) + co (tool = nazwa ' +
        'narzędzia, args = jego argumenty). Przykłady: gaszenie na noc → tool:"control_room", ' +
        'args:{room:"dom",service:"turn_off"}, time:"23:00"; zapalenie latarni o zmroku → ' +
        'tool:"control_room", args:{room:"latarnie",service:"turn_on"}, event:"sunset"; poranny ' +
        'motyw → tool:"set_theme", args:{theme:"nature"}, time:"07:00". Pole say = krótkie zdanie, ' +
        'które Gzowo powie/pokaże przy odpaleniu (np. „Gaszę światła, dobranoc"). Działa też, gdy ' +
        'nie rozmawiacie (pokaże powiadomienie). Do świateł używaj control_room (pokoje z mapy Jurka).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nazwa automatyzacji, np. "Gaszenie na noc".' },
          time: { type: 'string', description: 'Godzina "HH:MM" (gdy wyzwalacz to pora dnia).' },
          event: { type: 'string', enum: ['sunset', 'sunrise'], description: 'Zamiast time: zachód/wschód słońca.' },
          offset_min: { type: 'number', description: 'Przesunięcie w minutach dla sunset/sunrise (np. -15 = 15 min przed).' },
          tool: { type: 'string', description: 'Nazwa narzędzia do wykonania, np. "control_room", "set_theme".' },
          args: { type: 'string', description: 'Argumenty narzędzia jako JSON, np. {"room":"dom","service":"turn_off"}.' },
          say: { type: 'string', description: 'Opcjonalne zdanie wypowiadane/pokazywane przy odpaleniu.' }
        },
        required: ['name', 'tool']
      }
    },
    async (a) => {
      const name = String((a && a.name) || '').trim();
      const id = slug(name);
      if (!id) return { ok: false, error: 'podaj nazwę automatyzacji' };

      // Trigger — exactly one of time / event.
      let trigger = null;
      if (a.time) {
        if (parseHHMM(a.time) == null) return { ok: false, error: 'time musi być w formacie HH:MM (0–23:00–59)' };
        trigger = { type: 'time', at: /^\d:/.test(a.time) ? '0' + a.time : a.time };
      } else if (a.event === 'sunset' || a.event === 'sunrise') {
        trigger = { type: a.event, offset: Number(a.offset_min) || 0 };
      } else {
        return { ok: false, error: 'podaj kiedy: time="HH:MM" albo event="sunset"/"sunrise"' };
      }

      // Action — tool + parsed args.
      const tool = String(a.tool || '').trim();
      if (!tool) return { ok: false, error: 'podaj tool (nazwę narzędzia do wykonania)' };
      let args = {};
      if (a.args != null) {
        if (typeof a.args === 'object') { args = a.args; }
        else {
          try { args = JSON.parse(String(a.args)); }
          catch (_e) { return { ok: false, error: 'args musi być poprawnym JSON-em, np. {"room":"dom","service":"turn_off"}' }; }
        }
      }

      const auto = {
        id,
        name: name,
        enabled: true,
        trigger,
        action: { tool, args },
        say: (a.say && String(a.say).trim()) || '',
        created: (function () { try { return new Date().toISOString(); } catch { return ''; } })(),
        lastFired: null
      };
      const list = load().filter((x) => x.id !== id);
      list.push(auto);
      save(list);
      startScheduler();
      bus.emit('toast', { text: '🤖 Automatyzacja „' + name + '" — ' + describeTrigger(trigger) + '.', kind: 'info' });
      return { ok: true, created: id, when: describeTrigger(trigger), runs: tool };
    }
  );

  toolRouter.registerTool(
    {
      name: 'list_automations',
      description: 'Wylistuj automatyzacje Jurka: nazwa, kiedy się odpala, co robi, czy włączona.',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    async () => ({
      ok: true,
      automations: load().map((a) => ({
        name: a.name,
        when: describeTrigger(a.trigger),
        does: a.action ? a.action.tool : '—',
        enabled: a.enabled !== false
      }))
    })
  );

  toolRouter.registerTool(
    {
      name: 'delete_automation',
      description: 'Usuwa automatyzację po nazwie.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nazwa automatyzacji.' } },
        required: ['name']
      }
    },
    async ({ name }) => {
      const id = slug(name);
      const before = load();
      const after = before.filter((a) => a.id !== id);
      if (after.length === before.length) return { ok: false, error: 'nie mam automatyzacji „' + name + '"' };
      save(after);
      return { ok: true, deleted: id };
    }
  );

  toolRouter.registerTool(
    {
      name: 'toggle_automation',
      description: 'Włącza lub wyłącza automatyzację (bez usuwania). enabled=true/false.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nazwa automatyzacji.' },
          enabled: { type: 'boolean', description: 'true = włącz, false = wyłącz.' }
        },
        required: ['name', 'enabled']
      }
    },
    async ({ name, enabled }) => {
      const id = slug(name);
      const list = load();
      const a = list.find((x) => x.id === id);
      if (!a) return { ok: false, error: 'nie mam automatyzacji „' + name + '"' };
      a.enabled = !!enabled;
      save(list);
      return { ok: true, name: a.name, enabled: a.enabled };
    }
  );

  toolRouter.registerTool(
    {
      name: 'run_automation',
      description: 'Odpala automatyzację TERAZ (test — „przetestuj/uruchom automatyzację X"), niezależnie od pory.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nazwa automatyzacji.' } },
        required: ['name']
      }
    },
    async ({ name }) => {
      const id = slug(name);
      const a = load().find((x) => x.id === id);
      if (!a) return { ok: false, error: 'nie mam automatyzacji „' + name + '"' };
      const { ok, result } = await fireAutomation(a, 'manual');
      return { ok, ran: a.action.tool, result };
    }
  );

  // Start the scheduler if the user already has automations saved.
  if (load().length) startScheduler();
}
