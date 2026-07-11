// js/skills/skill-forge.js — self-authoring skills (Jurek, v3 #16).
// Gzowo can BUILD itself a skill: a separate builder "agent" (Gemini, its own key,
// server-side in the bridge) generates JS; Jurek APPROVES a code preview; the skill
// then runs ONLY inside a locked sandboxed iframe (sandbox="allow-scripts", NO
// allow-same-origin → null origin, cannot touch the app, DOM, storage or network).
// The skill talks to nothing but its OWN iframe document via a tiny GzowoSkill API.
//
// Flow (non-blocking, like brain_draft — the 8s tool ceiling forbids awaiting a
// multi-second LLM call + a human click):
//   create_skill{description} -> returns {pending} immediately, kicks off:
//     bridge /skills/generate -> confirmDialog(code preview) -> [Zainstaluj]
//       -> persist (localStorage per account) + run in sandbox + toast
//       -> assistant:announce so the MAIN Gzowo voice says it's ready.
// Installed skills persist and can be re-run/deleted by voice.

import { bus } from '../core/event-bus.js';
import { state } from '../core/state-manager.js';
import { toolRouter } from '../core/tool-router.js';
import { layout } from '../core/layout-engine.js';
import { defineWidget } from '../widgets/widget-base.js';
import { confirmDialog } from '../ui/confirm-dialog.js';

const CONFIG = window.GZOWO_CONFIG || {};
function bridgeBase() { return ((CONFIG.bridge && CONFIG.bridge.url) || '').replace(/\/$/, ''); }

// --- Persistence (per account, localStorage) --------------------------------
function nsKey() {
  const u = state.get('user');
  return 'gz.skills.' + (u && u.username ? u.username : '__anon');
}
function loadSkills() {
  try { return JSON.parse(localStorage.getItem(nsKey()) || '[]'); } catch { return []; }
}
function saveSkills(list) {
  try { localStorage.setItem(nsKey(), JSON.stringify(list)); } catch (_e) { /* private mode */ }
}
function upsertSkill(skill) {
  const list = loadSkills().filter((s) => s.name !== skill.name);
  list.push(skill);
  saveSkills(list);
}

// --- The sandboxed runtime injected into every skill iframe -----------------
// Runs at null origin. `parent` exists but is cross-origin: the ONLY thing that
// crosses is postMessage. No fetch/import/eval of remote — the skill is inline.
function sandboxSrcdoc(code) {
  const runtime = `
    <style>html,body{margin:0;height:100%;background:transparent;color:#fff;
      font-family:system-ui,sans-serif;overflow:auto}*{box-sizing:border-box}</style>
    <body><script>
      (function(){
        var timers=[];
        function post(t,d){ try{ parent.postMessage({__gzskill:1,type:t,data:d},'*'); }catch(e){} }
        window.GzowoSkill={
          render:function(html){ try{ document.body.innerHTML=String(html); }catch(e){ post('error',String(e)); } },
          log:function(m){ post('log',String(m)); },
          onTick:function(fn,ms){ var id=setInterval(function(){ try{fn();}catch(e){post('error',String(e));} }, Math.max(60,ms||1000)); timers.push(id); return id; },
          done:function(){ timers.forEach(clearInterval); post('done',1); }
        };
        window.onerror=function(m){ post('error',String(m)); };
        try{ (function(){ 'use strict';\n${code}\n })(); post('ready',1); }
        catch(e){ post('error',String(e&&e.message||e)); }
      })();
    <\/script></body>`;
  return runtime;
}

// The single "skill stage" widget — its body is the sandboxed iframe.
function skillWidgetDef(name, code) {
  return defineWidget({
    id: 'skill',
    title: 'SKILL · ' + name.toUpperCase(),
    size: 'lg',
    render(bodyEl) {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts'); // NO allow-same-origin — hard isolation
      frame.setAttribute('referrerpolicy', 'no-referrer');
      Object.assign(frame.style, { width: '100%', height: '100%', border: '0', background: 'transparent' });
      frame.srcdoc = sandboxSrcdoc(code);

      const onMsg = (e) => {
        if (e.source !== frame.contentWindow) return;      // only THIS skill's frame
        const m = e.data;
        if (!m || m.__gzskill !== 1) return;
        if (m.type === 'error') console.warn('[skill:' + name + ']', m.data);
        else if (m.type === 'log') console.info('[skill:' + name + ']', m.data);
      };
      window.addEventListener('message', onMsg);
      bodyEl.appendChild(frame);
      return () => {
        window.removeEventListener('message', onMsg);
        try { frame.src = 'about:blank'; frame.remove(); } catch (_e) { /* ignore */ }
      };
    }
  });
}

function runSkill(name, code) {
  try {
    const w = layout.getWidgets && layout.getWidgets().some((x) => x.id === 'skill');
    if (w) layout.removeWidget('skill');
  } catch (_e) { /* stub */ }
  layout.addWidget(skillWidgetDef(name, code));
}

// --- Live preview node for the confirm dialog (v4-h) ------------------------
// The exact same locked sandbox the installed widget uses, sized to fit inside
// the dialog. Jurek approves the RENDERED widget, not its code. Sandbox messages
// (log/error/done) have no listener here — harmless, ignored.
function previewNode(code) {
  const wrap = document.createElement('div');
  Object.assign(wrap.style, {
    width: '100%', height: '260px', margin: '0 0 var(--space-5)',
    border: '1px solid var(--line-bright)', borderRadius: 'var(--glass-radius-sm)',
    overflow: 'hidden', background: 'var(--bg-raised)'
  });
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');       // NO allow-same-origin — hard isolation
  frame.setAttribute('referrerpolicy', 'no-referrer');
  Object.assign(frame.style, { width: '100%', height: '100%', border: '0', background: 'transparent' });
  frame.srcdoc = sandboxSrcdoc(code);
  wrap.appendChild(frame);
  return wrap;
}

// --- Build pipeline (non-blocking) ------------------------------------------
async function buildAndInstall(description, nameHint) {
  const base = bridgeBase();
  let data;
  try {
    const res = await fetch(base + '/skills/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description })
    });
    data = await res.json();
  } catch (_e) {
    bus.emit('toast', { text: 'Builder widgetów nieosiągalny — odpal most.', kind: 'warn' });
    bus.emit('assistant:announce', { text: 'Nie udało się zbudować widgetu — most jest offline.' });
    return;
  }
  if (!data || !data.ok || !data.code) {
    bus.emit('toast', { text: 'Nie zbudowano widgetu: ' + ((data && data.error) || 'błąd'), kind: 'warn' });
    bus.emit('assistant:announce', { text: 'Budowa widgetu się nie udała: ' + ((data && data.error) || 'nieznany błąd') + '.' });
    return;
  }
  const name = (nameHint || description).toLowerCase().replace(/[^a-z0-9ąćęłńóśźż ]/gi, '').trim().slice(0, 28) || 'skill';

  // v4-g: Settings toggle can skip the confirmation. The skill still runs only
  // inside the locked sandbox, so "install directly" stays safe.
  if (state.get('widgetConfirm') !== false) {
    // v4-h: show a LIVE PREVIEW of the widget (same locked sandbox as the real
    // one) instead of raw code — Jurek approves what he actually sees.
    const ok = await confirmDialog({
      title: 'Nowy widget: ' + name,
      body: 'Podgląd na żywo — zainstalować?',
      bodyNode: previewNode(data.code),
      confirmLabel: 'Zainstaluj', cancelLabel: 'Odrzuć'
    });
    if (!ok) {
      bus.emit('toast', { text: 'Widget odrzucony.', kind: 'info' });
      bus.emit('assistant:announce', { text: 'Widget „' + name + '" został odrzucony.' });
      return;
    }
  }
  upsertSkill({ name, code: data.code, created: Date.now() });
  runSkill(name, data.code);
  bus.emit('toast', { text: '🧩 Widget „' + name + '" zainstalowany i uruchomiony.', kind: 'info' });
  bus.emit('assistant:announce', { text: 'Widget „' + name + '" jest gotowy, zainstalowany i już działa na ekranie.' });
}

export async function init() {
  toolRouter.registerTool(
    {
      name: 'create_custom_widget',
      description: 'Zbuduj NOWY WIDGET (mini-program na ekranie) z opisu Jurka — element ' +
        'przepływu „zbudujmy coś" (rodzaj: Widget). Osobny builder-agent generuje kod W TLE; ' +
        'potrwa chwilę i wymaga zatwierdzenia przez Jurka. WAŻNE: po wywołaniu powiedz, że ' +
        'budujesz widget w tle i dasz znać jak gotowy — NIE mów, że już zrobiony. Ogłoszę ' +
        'gotowość osobno. Opcjonalny theme dopasowuje wygląd do motywu.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Co widget ma robić/pokazywać, po polsku, konkretnie.' },
          name: { type: 'string', description: 'Opcjonalna krótka nazwa widgetu.' },
          theme: { type: 'string', description: 'Opcjonalnie: motyw do dopasowania wyglądu (mono/nature/water/…).' }
        },
        required: ['description']
      }
    },
    async ({ description, name, theme }) => {
      let desc = String(description || '').trim();
      if (!desc) return { ok: false, error: 'Podaj opis, co widget ma robić.' };
      if (theme) desc += ' WYGLĄD: dopasuj kolorystykę i klimat do motywu „' + String(theme) + '" aplikacji Gzowo.';
      buildAndInstall(desc, name);  // fire-and-forget (avoids the 8s tool ceiling)
      return { ok: true, pending: true, message: 'Buduję widget w tle — dam znać, gdy będzie gotowy do zatwierdzenia.' };
    }
  );

  toolRouter.registerTool(
    {
      name: 'list_custom_widgets',
      description: 'Wylistuj zbudowane własne widgety Jurka (nazwy).',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    async () => {
      const list = loadSkills();
      return { ok: true, count: list.length, skills: list.map((s) => s.name) };
    }
  );

  toolRouter.registerTool(
    {
      name: 'run_custom_widget',
      description: 'Uruchom zbudowany własny widget po nazwie (pokaże się na ekranie).',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nazwa skilla z list_skills.' } },
        required: ['name']
      }
    },
    async ({ name }) => {
      const q = String(name || '').toLowerCase().trim();
      const s = loadSkills().find((x) => x.name.toLowerCase() === q) ||
        loadSkills().find((x) => x.name.toLowerCase().includes(q));
      if (!s) return { ok: false, error: 'Nie mam widgetu „' + name + '". Zbuduj go przez create_custom_widget.' };
      runSkill(s.name, s.code);
      return { ok: true, running: s.name };
    }
  );

  toolRouter.registerTool(
    {
      name: 'delete_custom_widget',
      description: 'Usuń zbudowany własny widget po nazwie.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nazwa skilla do usunięcia.' } },
        required: ['name']
      }
    },
    async ({ name }) => {
      const q = String(name || '').toLowerCase().trim();
      const before = loadSkills();
      const after = before.filter((x) => x.name.toLowerCase() !== q);
      if (after.length === before.length) return { ok: false, error: 'Nie znalazłem skilla „' + name + '".' };
      saveSkills(after);
      return { ok: true, deleted: name };
    }
  );
}
