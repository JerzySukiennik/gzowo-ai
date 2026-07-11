// js/skills/skills.js — SKILLS registry + the honest gating core (skills-owned).
//
// Ships FOUR real, built-in skills. There are no downloads: every capability
// already lives in the app. "Pobranie" (download) simply flips a skill ON, and
// that ON/OFF list is persisted as the 'skills' pref (cross-device via memory).
//
// The honest core:
//   - ALL skill tool declarations are registered at init() so a Live session sees
//     them at connect time.
//   - But every skill handler first checks isEnabled(ownerSkillId). If the skill
//     is OFF, it returns a truthful {ok:false, error:'… nie jest pobrany …'} — the
//     model relays that instead of faking success (persona trusts functionResponse).
//   - Management tools (install_skill / uninstall_skill) are ALWAYS active so the
//     assistant can enable a skill by voice ("pobierz skill kostka").
//
// GLOBAL RULES honored: init() never throws; results are always honest; PL copy
// is friendly + concise (no rhymes / 'Edek' / 'człowieku'); English code/comments;
// color lives ONLY inside .widget-body (the notes + countdown widgets).

import { toolRouter } from '../core/tool-router.js';
import { state } from '../core/state-manager.js';
import { layout } from '../core/layout-engine.js';
import { memory } from '../memory/firebase.js';
import { defineWidget, el } from '../widgets/widget-base.js';

// The same Firestore CDN build memory/firebase.js uses. Loaded lazily (dynamic
// import) inside the notes handlers so this module's load never depends on the
// CDN being reachable — a network hiccup degrades to the localStorage fallback,
// it does not kill the whole skills system.
const FIRESTORE_URL = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// localStorage key for the offline notes fallback.
const LS_NOTES = 'gzowo.notes';

// Countdown body accent (inside .widget-body only — chrome stays B&W).
const CDW_ACCENT = '#5ec8ff';

// ============================================================================
// The catalog — 4 real built-ins.
// ============================================================================
/** @type {{id:string,name:string,desc:string,toolNames:string[]}[]} */
const SKILLS = [
  {
    id: 'dice',
    name: 'RZUT KOSTKĄ',
    desc: 'Rzuca kośćmi — od 2 do 1000 ścian, wiele naraz — i podaje wyniki oraz sumę.',
    toolNames: ['roll_dice']
  },
  {
    id: 'calculator',
    name: 'KALKULATOR',
    desc: 'Liczy wyrażenia matematyczne: dodawanie, mnożenie, nawiasy, procenty.',
    toolNames: ['calculate']
  },
  {
    id: 'notes',
    name: 'NOTATKI',
    desc: 'Zapisuje notatki w chmurze i pokazuje ostatnie na widgecie.',
    toolNames: ['save_note', 'show_notes']
  },
  {
    id: 'countdown',
    name: 'ODLICZANIE',
    desc: 'Odlicza na żywo do wybranej daty lub wydarzenia — dni, godziny, sekundy.',
    toolNames: ['countdown_to']
  }
];

const SKILL_IDS = SKILLS.map((s) => s.id);

function skillById(id) {
  return SKILLS.find((s) => s.id === id) || null;
}

// ============================================================================
// Enabled-set helpers (state 'skills' is the single source of truth).
// ============================================================================
function enabledIds() {
  const v = state.get('skills');
  return Array.isArray(v) ? v : [];
}

/**
 * Public skills API. enable/disable ALWAYS write a brand-new array via
 * state.set('skills', …) so subscribers fire and memory persists the pref
 * automatically. No bus.emit needed — the marketplace re-renders via
 * state.subscribe('skills').
 */
export const skills = {
  /** @returns {{id:string,name:string,desc:string,enabled:boolean}[]} */
  list() {
    const on = enabledIds();
    return SKILLS.map((s) => ({
      id: s.id,
      name: s.name,
      desc: s.desc,
      enabled: on.includes(s.id)
    }));
  },

  /** @param {string} id @returns {boolean} */
  isEnabled(id) {
    return enabledIds().includes(id);
  },

  /**
   * Turn a skill ON. Ignores unknown ids. Idempotent.
   * @param {string} id
   * @returns {boolean} true if the skill exists (and is now on)
   */
  enable(id) {
    if (!SKILL_IDS.includes(id)) return false;
    const cur = enabledIds();
    if (cur.includes(id)) return true;
    state.set('skills', [...cur, id]); // NEW array -> subscribers fire, pref persists
    return true;
  },

  /**
   * Turn a skill OFF. Idempotent; safe on unknown ids.
   * @param {string} id
   * @returns {boolean}
   */
  disable(id) {
    const cur = enabledIds();
    if (!cur.includes(id)) return true;
    state.set('skills', cur.filter((x) => x !== id)); // NEW array
    return true;
  }
};

// ============================================================================
// Gating — the honest wrapper around every skill handler.
// ============================================================================
/**
 * Wrap a skill handler so it only runs when its owning skill is enabled.
 * Disabled -> a truthful error the model must relay verbatim.
 * @param {string} skillId
 * @param {(args:object)=>Promise<object>|object} handler
 */
function gated(skillId, handler) {
  return async (args) => {
    if (!skills.isEnabled(skillId)) {
      const s = skillById(skillId);
      const name = s ? s.name : skillId;
      return {
        ok: false,
        error: `Skill „${name}” nie jest pobrany — powiedz „pokaż marketplace”, żeby go włączyć.`
      };
    }
    return handler(args || {});
  };
}

// ============================================================================
// Small utilities.
// ============================================================================
function clampInt(v, lo, hi, fallback) {
  let n = Math.floor(Number(v));
  if (!Number.isFinite(n)) n = fallback;
  return Math.max(lo, Math.min(hi, n));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Uniform integer in [0, max) using crypto when available (rejection sampling). */
function randBelow(max) {
  if (max <= 0) return 0;
  try {
    const cryptoObj = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null;
    if (cryptoObj) {
      const UINT_MAX = 0xffffffff;
      const limit = UINT_MAX - (UINT_MAX % max); // largest multiple of max, avoids modulo bias
      const buf = new Uint32Array(1);
      let x;
      do {
        cryptoObj.getRandomValues(buf);
        x = buf[0];
      } while (x >= limit);
      return x % max;
    }
  } catch (_e) {
    /* fall through to Math.random */
  }
  return Math.floor(Math.random() * max);
}

function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function lsSet(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* storage full/disabled — best-effort mirror */
  }
}

// ---- Firestore access (v2 memory contract, defensively guarded) -------------
function getDbSafe() {
  try {
    return typeof memory.getDb === 'function' ? memory.getDb() : null;
  } catch {
    return null;
  }
}

function getUsernameSafe() {
  try {
    if (typeof memory.getUsername === 'function') {
      const u = memory.getUsername();
      if (u) return u;
    }
  } catch {
    /* ignore */
  }
  // Fallback to the shared state user record.
  try {
    const u = state.get('user');
    if (u && u.username) return u.username;
  } catch {
    /* ignore */
  }
  return null;
}

// ============================================================================
// Skill: DICE — roll_dice
// ============================================================================
async function rollDice(args) {
  const sides = clampInt(args.sides, 2, 1000, 6);
  const count = clampInt(args.count, 1, 20, 1);
  const rolls = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const r = randBelow(sides) + 1;
    rolls.push(r);
    total += r;
  }
  return { ok: true, rolls, total };
}

// ============================================================================
// Skill: CALCULATOR — calculate
// ============================================================================
function calculate(args) {
  const expr = String(args.expression == null ? '' : args.expression);
  // Whitelist ONLY digits, arithmetic operators, brackets, comma, dot, percent,
  // whitespace — and cap the length. Anything else (letters, calls) is rejected.
  if (expr.length > 120 || !/^[0-9+\-*/(),.%\s]+$/.test(expr)) {
    return { ok: false, error: 'niedozwolone znaki' };
  }
  try {
    // eslint-disable-next-line no-new-func
    const result = new Function('return (' + expr + ')')();
    if (typeof result !== 'number' || !Number.isFinite(result)) {
      return { ok: false, error: 'nie udało się policzyć tego wyrażenia' };
    }
    return { ok: true, result };
  } catch (_e) {
    return { ok: false, error: 'nie udało się policzyć tego wyrażenia' };
  }
}

// ============================================================================
// Skill: NOTES — save_note + show_notes
// ============================================================================
async function loadFirestore() {
  return import(/* @vite-ignore */ FIRESTORE_URL);
}

async function saveNote(args) {
  const text = String(args.text == null ? '' : args.text).trim();
  if (!text) return { ok: false, error: 'pusta notatka' };

  const db = getDbSafe();
  const user = getUsernameSafe();
  if (db && user) {
    try {
      const { collection, addDoc } = await loadFirestore();
      await addDoc(collection(db, 'users', user, 'notes'), { text, ts: Date.now() });
      return { ok: true, stored: 'cloud' };
    } catch (_e) {
      /* fall through to local fallback — honest about where it landed */
    }
  }
  // localStorage fallback (db or user missing, or the write failed).
  const arr = lsGet(LS_NOTES, []);
  const next = Array.isArray(arr) ? arr : [];
  next.push({ text, ts: Date.now() });
  lsSet(LS_NOTES, next);
  return { ok: true, stored: 'local' };
}

/** Load newest-20 notes -> [{text, ts}], from Firestore or the local mirror. */
async function loadNotes() {
  const db = getDbSafe();
  const user = getUsernameSafe();
  if (db && user) {
    try {
      const { collection, query, orderBy, limit, getDocs } = await loadFirestore();
      const q = query(collection(db, 'users', user, 'notes'), orderBy('ts', 'desc'), limit(20));
      const snap = await getDocs(q);
      const rows = [];
      snap.forEach((d) => {
        const data = d.data() || {};
        if (typeof data.text === 'string') {
          rows.push({ text: data.text, ts: Number(data.ts) || 0 });
        }
      });
      return rows;
    } catch (_e) {
      /* fall through to local */
    }
  }
  const arr = lsGet(LS_NOTES, []);
  const rows = Array.isArray(arr) ? arr.slice() : [];
  rows.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  return rows.slice(0, 20);
}

async function showNotes() {
  const notes = await loadNotes();
  // Always reflect the latest: drop any prior notes widget, then add fresh.
  try { layout.removeWidget('notes'); } catch (_e) { /* no-op if absent */ }
  layout.addWidget(notesDef(notes));
  return { ok: true, count: notes.length };
}

// Re-render the notes widget IF it is on screen (after a delete). Silent no-op
// otherwise — deleting notes must not force the widget onto the screen.
async function refreshNotesWidgetIfVisible() {
  try {
    const visible = layout.getWidgets().some((w) => w.id === 'notes');
    if (visible) await showNotes();
  } catch (_e) { /* engine stub */ }
}

/** v4 #3: delete ONE note — newest note whose text contains the fragment. */
async function deleteNote(args) {
  const frag = String(args && args.text_fragment != null ? args.text_fragment : '').trim().toLowerCase();
  if (!frag) return { ok: false, error: 'podaj fragment treści notatki do usunięcia' };

  const db = getDbSafe();
  const user = getUsernameSafe();
  if (db && user) {
    try {
      const { collection, query, orderBy, getDocs, deleteDoc } = await loadFirestore();
      const q = query(collection(db, 'users', user, 'notes'), orderBy('ts', 'desc'));
      const snap = await getDocs(q);
      let victim = null;
      snap.forEach((d) => {
        const data = d.data() || {};
        if (!victim && typeof data.text === 'string' && data.text.toLowerCase().includes(frag)) {
          victim = { ref: d.ref, text: data.text };
        }
      });
      if (!victim) return { ok: false, error: 'nie znalazłem notatki zawierającej „' + frag + '"' };
      await deleteDoc(victim.ref);
      await refreshNotesWidgetIfVisible();
      return { ok: true, deleted: victim.text.slice(0, 80) };
    } catch (e) {
      return { ok: false, error: 'nie udało się usunąć: ' + String((e && e.message) || e) };
    }
  }
  // local fallback
  const arr = lsGet(LS_NOTES, []);
  const list = Array.isArray(arr) ? arr : [];
  const idx = list.findIndex((n) => n && typeof n.text === 'string' && n.text.toLowerCase().includes(frag));
  if (idx === -1) return { ok: false, error: 'nie znalazłem notatki zawierającej „' + frag + '"' };
  const [gone] = list.splice(idx, 1);
  lsSet(LS_NOTES, list);
  await refreshNotesWidgetIfVisible();
  return { ok: true, deleted: (gone && gone.text ? gone.text : '').slice(0, 80), stored: 'local' };
}

/** v4 #3: delete ALL notes (cloud + local mirror). The tool description makes
 *  the model confirm with Jurek first — this is irreversible. */
async function deleteAllNotes() {
  let cloudDeleted = 0;
  const db = getDbSafe();
  const user = getUsernameSafe();
  if (db && user) {
    try {
      const { collection, getDocs, deleteDoc } = await loadFirestore();
      const snap = await getDocs(collection(db, 'users', user, 'notes'));
      const jobs = [];
      snap.forEach((d) => { jobs.push(deleteDoc(d.ref)); });
      await Promise.all(jobs);
      cloudDeleted = jobs.length;
    } catch (e) {
      return { ok: false, error: 'nie udało się wyczyścić chmury: ' + String((e && e.message) || e) };
    }
  }
  lsSet(LS_NOTES, []);
  await refreshNotesWidgetIfVisible();
  return { ok: true, deleted: cloudDeleted };
}

const NOTE_TS_FMT = new Intl.DateTimeFormat('pl-PL', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
});
function fmtNoteTs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  try { return NOTE_TS_FMT.format(new Date(n)); } catch { return ''; }
}

// Scoped styles live INSIDE the body (color allowed here; chrome stays B&W).
const NTS_CSS = `
.nts { font-family: var(--font-mono); color: var(--fg); height: 100%; display: flex; flex-direction: column; gap: var(--space-3); }
.nts-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); overflow-y: auto; flex: 1; }
.nts-item { display: flex; flex-direction: column; gap: 2px; padding: var(--space-2) var(--space-3); border-left: 2px solid var(--line-bright); background: rgba(255,255,255,0.02); }
.nts-text { font-size: var(--text-sm); line-height: 1.45; color: var(--fg); white-space: pre-wrap; word-break: break-word; }
.nts-ts { font-size: var(--text-xs); color: var(--fg-faint); letter-spacing: var(--tracking); }
.nts-empty { font-size: var(--text-sm); color: var(--fg-dim); line-height: 1.5; }
`;

function styleEl(css) {
  const s = document.createElement('style');
  s.textContent = css;
  return s;
}

/**
 * Read-only notes list (newest 20). No buttons — user never manipulates it.
 * @param {{text:string,ts:number}[]} notes
 */
function notesDef(notes) {
  const snapshot = Array.isArray(notes) ? notes : [];
  return defineWidget({
    id: 'notes',
    title: 'NOTATKI',
    color: null, // restrained: notes stay monochrome (dim timestamps)
    size: 'md',
    render(bodyEl) {
      bodyEl.append(styleEl(NTS_CSS));
      const wrap = el('div', 'nts');
      if (snapshot.length === 0) {
        wrap.append(el('div', 'nts-empty', 'Brak notatek. Powiedz „zapisz notatkę…”, żeby dodać pierwszą.'));
      } else {
        const list = el('ul', 'nts-list');
        for (const n of snapshot) {
          const li = el('li', 'nts-item');
          li.append(el('div', 'nts-text', String(n.text == null ? '' : n.text)));
          const ts = fmtNoteTs(n.ts);
          if (ts) li.append(el('div', 'nts-ts', ts));
          list.append(li);
        }
        wrap.append(list);
      }
      bodyEl.append(wrap);
      // Nothing to tear down.
      return () => {};
    }
  });
}

// ============================================================================
// Skill: COUNTDOWN — countdown_to
// ============================================================================
/**
 * Parse 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM[:SS]' (space or 'T') into a LOCAL Date.
 * Rejects impossible dates (e.g. 2026-13-40) by verifying the components survive
 * the Date construction (no silent roll-over). Returns null on any failure.
 */
function parseTargetDate(raw) {
  if (!raw) return null;
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const y = Number(m[1]); const mo = Number(m[2]); const day = Number(m[3]);
    const d = new Date(y, mo - 1, day, 0, 0, 0, 0);
    if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return null;
    return d;
  }
  m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const y = Number(m[1]); const mo = Number(m[2]); const day = Number(m[3]);
    const hh = Number(m[4]); const mm = Number(m[5]); const ss = Number(m[6] || 0);
    const d = new Date(y, mo - 1, day, hh, mm, ss, 0);
    if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day ||
        d.getHours() !== hh || d.getMinutes() !== mm) return null;
    return d;
  }
  return null;
}

function countdownTo(args) {
  const raw = String(args.date == null ? '' : args.date).trim();
  const target = parseTargetDate(raw);
  if (!target) {
    return { ok: false, error: 'nie rozumiem tej daty — użyj formatu RRRR-MM-DD (opcjonalnie z godziną HH:MM)' };
  }
  const now = Date.now();
  if (target.getTime() <= now) {
    return { ok: false, error: 'ta data już minęła — podaj datę w przyszłości' };
  }
  const label = args.label ? String(args.label).trim() : '';
  try { layout.removeWidget('countdown'); } catch (_e) { /* no-op if absent */ }
  layout.addWidget(countdownDef(target.getTime(), label));
  const days_left = Math.floor((target.getTime() - now) / 86400000);
  return { ok: true, days_left };
}

const CDW_CSS = `
.cdw { font-family: var(--font-mono); color: var(--fg); height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-3); text-align: center; padding: var(--space-3); }
.cdw-time { font-size: var(--text-2xl); letter-spacing: var(--tracking); color: var(--widget-accent); font-variant-numeric: tabular-nums; line-height: 1; }
.cdw-time.is-done { color: var(--widget-accent); }
.cdw-label { font-size: var(--text-sm); color: var(--fg-dim); letter-spacing: var(--tracking); text-transform: uppercase; }
`;

/**
 * Live countdown widget. Ticks every 1s; the interval is cleared on cleanup.
 * @param {number} targetMs epoch ms of the target moment (already validated future)
 * @param {string} label    optional event label (rendered via textContent — safe)
 */
function countdownDef(targetMs, label) {
  return defineWidget({
    id: 'countdown',
    title: 'ODLICZANIE',
    color: CDW_ACCENT, // accent exposed as --widget-accent, used only in the body
    size: 'md',
    render(bodyEl) {
      bodyEl.append(styleEl(CDW_CSS));
      const wrap = el('div', 'cdw');
      const timeEl = el('div', 'cdw-time', '—');
      wrap.append(timeEl);
      let labelEl = null;
      if (label) {
        labelEl = el('div', 'cdw-label', 'do ' + label);
        wrap.append(labelEl);
      }
      bodyEl.append(wrap);

      let alive = true;
      let timer = null;

      function tick() {
        if (!alive) return;
        const rem = targetMs - Date.now();
        if (rem <= 0) {
          timeEl.textContent = '00:00:00';
          timeEl.classList.add('is-done');
          if (timer) { clearInterval(timer); timer = null; }
          return;
        }
        const totalSec = Math.floor(rem / 1000);
        const days = Math.floor(totalSec / 86400);
        const h = Math.floor((totalSec % 86400) / 3600);
        const mnt = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        timeEl.textContent = `${days}d ${pad2(h)}:${pad2(mnt)}:${pad2(s)}`;
      }

      tick();
      timer = setInterval(tick, 1000);

      return () => {
        alive = false;
        if (timer) { clearInterval(timer); timer = null; }
      };
    }
  });
}

// ============================================================================
// Management tools — ALWAYS active (never gated).
// ============================================================================
function installSkill(args) {
  const id = String(args.id == null ? '' : args.id).trim();
  const s = skillById(id);
  if (!s) return { ok: false, error: 'nie ma takiego skilla' };
  if (skills.isEnabled(id)) return { ok: true, note: 'już pobrany' };
  skills.enable(id);
  return { ok: true, skill: s.name };
}

function uninstallSkill(args) {
  const id = String(args.id == null ? '' : args.id).trim();
  skills.disable(id);
  return { ok: true };
}

// ============================================================================
// init() — register every declaration (gated skill tools + management tools).
// Live sessions read declarations at connect, so registration happens here.
// NEVER throws.
// ============================================================================
export async function init() {
  try {
    // --- DICE ---------------------------------------------------------------
    toolRouter.registerTool(
      {
        name: 'roll_dice',
        description: 'Rzuca kośćmi i zwraca wyniki oraz sumę. Skill „RZUT KOSTKĄ”.',
        parameters: {
          type: 'object',
          properties: {
            sides: { type: 'number', description: 'Liczba ścian kości (2–1000). Domyślnie 6.' },
            count: { type: 'number', description: 'Ile kości rzucić (1–20). Domyślnie 1.' }
          }
        }
      },
      gated('dice', rollDice)
    );

    // --- CALCULATOR ---------------------------------------------------------
    toolRouter.registerTool(
      {
        name: 'calculate',
        description: 'Liczy wyrażenie matematyczne, np. „2+2*3” albo „(10-4)/2”. Skill „KALKULATOR”.',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'Wyrażenie do obliczenia (tylko liczby i operatory).' }
          },
          required: ['expression']
        }
      },
      gated('calculator', calculate)
    );

    // --- NOTES --------------------------------------------------------------
    // v4 #8 disambiguation: these are the QUICK APP NOTES (the NOTATKI widget,
    // Firestore per-account) — NOT Jurek's second brain. The vault is served by
    // the brain_* tools only; every description says so to stop the mix-ups.
    toolRouter.registerTool(
      {
        name: 'save_note',
        description: 'Zapisuje SZYBKĄ NOTATKĘ w aplikacji (widget NOTATKI, chmura konta). ' +
          'To NIE jest second brain Jurka — do vaulta/notatek z Obsidiana służy brain_draft. ' +
          'Skill „NOTATKI”.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Treść notatki do zapisania.' }
          },
          required: ['text']
        }
      },
      gated('notes', saveNote)
    );
    toolRouter.registerTool(
      {
        name: 'show_notes',
        description: 'Pokazuje widget NOTATKI (szybkie notatki aplikacji — NIE second brain; ' +
          'vault czytasz przez brain_index/brain_read). Skill „NOTATKI”.',
        parameters: { type: 'object', properties: {} }
      },
      gated('notes', showNotes)
    );
    toolRouter.registerTool(
      {
        name: 'delete_note',
        description: 'Usuwa JEDNĄ szybką notatkę z aplikacji — najnowszą, której treść zawiera ' +
          'podany fragment. Dotyczy widgetu NOTATKI, nie second braina. Skill „NOTATKI”.',
        parameters: {
          type: 'object',
          properties: {
            text_fragment: { type: 'string', description: 'Fragment treści notatki do usunięcia.' }
          },
          required: ['text_fragment']
        }
      },
      gated('notes', deleteNote)
    );
    toolRouter.registerTool(
      {
        name: 'delete_all_notes',
        description: 'Usuwa WSZYSTKIE szybkie notatki z aplikacji (nieodwracalne!). ZAWSZE ' +
          'najpierw potwierdź z Jurkiem („na pewno usunąć wszystkie notatki?"). Nie dotyka ' +
          'second braina. Skill „NOTATKI”.',
        parameters: { type: 'object', properties: {} }
      },
      gated('notes', deleteAllNotes)
    );

    // --- COUNTDOWN ----------------------------------------------------------
    toolRouter.registerTool(
      {
        name: 'countdown_to',
        description: 'Uruchamia widget odliczający na żywo do podanej daty. Skill „ODLICZANIE”.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Data docelowa w formacie RRRR-MM-DD, opcjonalnie z godziną „RRRR-MM-DD HH:MM”.' },
            label: { type: 'string', description: 'Nazwa wydarzenia (opcjonalnie), np. „urodziny”.' }
          },
          required: ['date']
        }
      },
      gated('countdown', countdownTo)
    );

    // --- MANAGEMENT (always active) -----------------------------------------
    const idParam = {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          enum: SKILL_IDS,
          description: 'ID skilla: dice (kostka), calculator (kalkulator), notes (notatki), countdown (odliczanie).'
        }
      },
      required: ['id']
    };
    toolRouter.registerTool(
      {
        name: 'install_skill',
        description: 'Pobiera (włącza) skill po ID, żeby zaczął działać. Np. „pobierz skill kostka”.',
        parameters: idParam
      },
      installSkill
    );
    toolRouter.registerTool(
      {
        name: 'uninstall_skill',
        description: 'Usuwa (wyłącza) skill po ID.',
        parameters: idParam
      },
      uninstallSkill
    );
  } catch (e) {
    console.error('[skills] init failed', e);
  }
}
