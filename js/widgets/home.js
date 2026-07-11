// js/widgets/home.js — DOM · HOME ASSISTANT widget + its voice tools.
// Read-only dashboard: lights on/total, temperature list, sensor count. The user
// never manipulates the widget — all control goes through voice (control_home).
//
// Owns:
//   - homeDef()               frozen widget def (registered under 'home')
//   - export async function init()  registers the widget + 3 tools on the router
//
// Honesty laws:
//   - !ha.available()  -> centered dim mono empty state ('...NIEPODŁĄCZONY' + reason)
//   - real reads only  -> never fakes data; errors degrade to an honest message
//   - color (accent '#ffd166') lives ONLY inside .widget-body, via --widget-accent.
//
// Contract honored:
//   - toolRouter.registerWidget('home', homeDef)
//   - show_home {}     -> adds the widget (honest even when HA is down) -> {ok:true}
//   - home_status {}   -> real summary, or {ok:false,error:'... — <reason>'}
//   - control_home {entity_id, service, value?} -> calls HA, {ok:true,...} | {ok:false,error}

import { defineWidget } from './widget-base.js';
import { bus } from '../core/event-bus.js';
import { layout } from '../core/layout-engine.js';
import { toolRouter } from '../core/tool-router.js';
import { ha } from '../connectors/home-assistant.js';

const ACCENT = '#ffd166';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Round to at most one decimal, trimming a trailing '.0'.
function fmtNum(v) {
  const n = Math.round(Number(v) * 10) / 10;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// Turn a thrown bridge/HA error into an honest, short PL message.
function friendlyErr(err) {
  if (err && err.offline) return 'most jest offline';
  if (err && typeof err.error === 'string' && err.error) return err.error;
  if (err && err.status) return 'błąd ' + err.status;
  if (err && err.message) return String(err.message);
  return 'nieznany błąd';
}

// ---------------------------------------------------------------------------
// Scoped widget styles — injected INTO .widget-body (color allowed here only).
// ---------------------------------------------------------------------------
const HAW_CSS = `
.haw {
  width: 100%; height: 100%;
  display: flex; box-sizing: border-box;
  font-family: var(--font-mono);
  color: var(--fg);
}
.haw *, .haw *::before, .haw *::after { box-sizing: border-box; }

/* Empty / disconnected / error — centered dim mono */
.haw-empty {
  margin: auto; text-align: center;
  padding: var(--space-5);
  display: flex; flex-direction: column; gap: var(--space-2);
}
.haw-empty-title {
  font-size: var(--text-sm);
  letter-spacing: var(--tracking-wide);
  text-transform: uppercase;
  color: var(--fg-dim);
}
.haw-empty-reason {
  font-size: var(--text-sm);
  line-height: 1.55;
  color: var(--fg-faint);
}

/* Connected dashboard */
.haw-dash {
  width: 100%; height: 100%;
  display: flex; flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-1);
  min-height: 0;
}
.haw-lights {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--line);
}
.haw-lights-label {
  font-size: var(--text-xs);
  letter-spacing: var(--tracking-wide);
  color: var(--fg-dim);
}
.haw-lights-count {
  display: flex; align-items: baseline; gap: var(--space-2);
  line-height: 1;
  font-size: var(--text-2xl);
  color: var(--widget-accent, ${ACCENT});
}
.haw-lights-count b { font-weight: 600; }
.haw-lights-total { font-size: var(--text-lg); color: var(--fg-dim); }
.haw-lights-sub {
  font-size: var(--text-xs);
  letter-spacing: var(--tracking);
  color: var(--fg-faint);
}

.haw-section {
  display: flex; flex-direction: column; gap: var(--space-2);
  flex: 1; min-height: 0;
}
.haw-section-title {
  font-size: var(--text-xs);
  letter-spacing: var(--tracking-wide);
  color: var(--fg-dim);
}
.haw-temps {
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-direction: column;
  overflow-y: auto; min-height: 0;
}
.haw-temp {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--line);
  font-size: var(--text-md);
}
.haw-temp-name {
  color: var(--fg-dim);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding-right: var(--space-3);
}
.haw-temp-val {
  color: var(--fg);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.haw-unit { color: var(--fg-faint); font-size: var(--text-sm); margin-left: 2px; }
.haw-temp-none { color: var(--fg-faint); justify-content: center; border-bottom: 0; }
.haw-foot {
  font-size: var(--text-xs);
  letter-spacing: var(--tracking);
  color: var(--fg-faint);
}
`;

// ---------------------------------------------------------------------------
// Widget definition
// ---------------------------------------------------------------------------
export function homeDef() {
  return defineWidget({
    id: 'home',
    title: 'DOM · HOME ASSISTANT',
    color: ACCENT,
    size: 'lg',
    render(bodyEl) {
      let alive = true;
      let refreshTimer = null;
      const unsubs = [];

      // Inject scoped styles once (safe: body is freshly cleared on each render).
      const styleEl = document.createElement('style');
      styleEl.textContent = HAW_CSS;
      bodyEl.appendChild(styleEl);

      const root = document.createElement('div');
      root.className = 'haw';
      bodyEl.appendChild(root);

      function renderDisconnected() {
        root.innerHTML =
          '<div class="haw-empty">' +
            '<div class="haw-empty-title">HOME ASSISTANT NIEPODŁĄCZONY</div>' +
            `<div class="haw-empty-reason">${escapeHTML(ha.reason())}</div>` +
          '</div>';
      }

      function renderLoading() {
        root.innerHTML =
          '<div class="haw-empty">' +
            '<div class="haw-empty-reason">czytam stan domu…</div>' +
          '</div>';
      }

      function renderError(msg) {
        root.innerHTML =
          '<div class="haw-empty">' +
            '<div class="haw-empty-title">BŁĄD ODCZYTU</div>' +
            `<div class="haw-empty-reason">${escapeHTML(msg)}</div>` +
          '</div>';
      }

      function renderDashboard(summary) {
        const lights = summary.lights || { on: 0, total: 0 };
        const temps = Array.isArray(summary.temperatures) ? summary.temperatures : [];
        const sensors = Number(summary.sensors || 0);

        const tempRows = temps.length
          ? temps.map((t) =>
              '<li class="haw-temp">' +
                `<span class="haw-temp-name">${escapeHTML(t.name)}</span>` +
                '<span class="haw-temp-val">' +
                  `${escapeHTML(fmtNum(t.value))}` +
                  `<span class="haw-unit">${escapeHTML(t.unit || '')}</span>` +
                '</span>' +
              '</li>').join('')
          : '<li class="haw-temp haw-temp-none">brak czujników temperatury</li>';

        root.innerHTML =
          '<div class="haw-dash">' +
            '<div class="haw-lights">' +
              '<div class="haw-lights-label">ŚWIATŁA</div>' +
              '<div class="haw-lights-count">' +
                `<b>${lights.on}</b><span class="haw-lights-total">/ ${lights.total}</span>` +
              '</div>' +
              '<div class="haw-lights-sub">włączone</div>' +
            '</div>' +
            '<div class="haw-section">' +
              '<div class="haw-section-title">TEMPERATURY</div>' +
              `<ul class="haw-temps">${tempRows}</ul>` +
            '</div>' +
            `<div class="haw-foot">${sensors} czujników</div>` +
          '</div>';
      }

      async function load(showLoading) {
        if (!alive) return;
        if (!ha.available()) { renderDisconnected(); return; }
        if (showLoading) renderLoading();
        try {
          const summary = await ha.summary();
          if (!alive) return;
          renderDashboard(summary);
        } catch (err) {
          if (!alive) return;
          renderError(friendlyErr(err));
        }
      }

      // Re-evaluate connection whenever the bridge reports in (connect/disconnect).
      unsubs.push(bus.on('bridge:status', () => { if (alive) load(true); }));

      load(true);
      // Live refresh while mounted — silent (no loading flash) once we have data.
      refreshTimer = setInterval(() => {
        if (alive && ha.available()) load(false);
      }, 15000);

      // Cleanup: kill the interval + drop bus subs (no ticking after removal).
      return () => {
        alive = false;
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
        for (const u of unsubs) { try { u(); } catch (_e) { /* ignore */ } }
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Tool declarations + handlers (Gemini functionDeclarations, PL descriptions)
// ---------------------------------------------------------------------------
const showHomeDecl = {
  name: 'show_home',
  description: 'Pokazuje na ekranie widget DOM z panelem Home Assistant (tylko do odczytu: ' +
    'światła, temperatury, liczba czujników). Użyj, gdy Jurek chce zobaczyć stan domu.',
  parameters: { type: 'object', properties: {}, required: [] }
};

async function showHomeHandler() {
  layout.addWidget(homeDef());
  if (!ha.available()) {
    return { ok: true, note: 'Widget dodany, ale Home Assistant niepodłączony — ' + ha.reason() };
  }
  return { ok: true };
}

const homeStatusDecl = {
  name: 'home_status',
  description: 'Zwraca REALNY, aktualny stan Home Assistant (liczba włączonych świateł, ' +
    'temperatury z czujników, liczniki). Użyj, gdy Jurek pyta o stan domu, i mów wyłącznie to, ' +
    'co jest w odpowiedzi — nie zmyślaj danych. Gdy HA jest niepodłączone, powiedz to wprost.',
  parameters: { type: 'object', properties: {}, required: [] }
};

async function homeStatusHandler() {
  if (!ha.available()) {
    return { ok: false, error: 'Home Assistant niepodłączony — ' + ha.reason() };
  }
  try {
    const summary = await ha.summary();
    return { ok: true, summary };
  } catch (err) {
    return { ok: false, error: 'Nie udało się odczytać stanu: ' + friendlyErr(err) };
  }
}

// --- home_devices: entity discovery so the model NEVER asks Jurek for ids -----
const homeDevicesDecl = {
  name: 'home_devices',
  description: 'Zwraca listę sterowalnych urządzeń Home Assistant (światła, przełączniki, ' +
    'sceny): entity_id + nazwa + stan. ZAWSZE wywołaj to NAJPIERW, gdy Jurek prosi o ' +
    'włączenie/wyłączenie czegoś — dopasuj urządzenie po nazwie/pokoju z tej listy i użyj jego ' +
    'entity_id w control_home. NIGDY nie proś Jurka o entity_id. Jeśli pasuje kilka, zapytaj ' +
    'które (podając nazwy).',
  parameters: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: 'Opcjonalny filtr: light | switch | scene. Bez filtra zwraca wszystkie trzy.'
      }
    },
    required: []
  }
};

// v4-b #9: the user-maintained light↔room map (bridge/ha-rooms.json via /ha/rooms).
async function loadRoomMap() {
  try {
    const base = ((window.GZOWO_CONFIG || {}).bridge || {}).url || '';
    const res = await fetch(base.replace(/\/$/, '') + '/ha/rooms', { cache: 'no-store' });
    const data = await res.json();
    return Array.isArray(data.lights) ? data.lights : [];
  } catch (_e) { return []; }
}

async function homeDevicesHandler(args = {}) {
  if (!ha.available()) {
    return { ok: false, error: 'Home Assistant niepodłączony — ' + ha.reason() };
  }
  const domains = ['light', 'switch', 'scene'];
  const wanted = typeof args.domain === 'string' && domains.includes(args.domain)
    ? [args.domain] : domains;
  // Most `switch.*` entities are device CONFIG toggles (LED, auto-off, child-lock…),
  // not lamps — including all 300+ drowned the real lamp-switches. Drop the config
  // ones; keep switches in the room map, named like a lamp, or with no sub-suffix.
  const SWITCH_NOISE = /_led$|_auto_off|_auto_update|_enabled$|_overload|_cloud|_signal|_consumption|_voltage|_current$|_power_protection|_child_lock|_inching|_indicator|_backlight|_do_not_disturb|_power_on|_relay_status|_night_light|_status_led/i;
  try {
    const [lists, roomMap] = await Promise.all([
      Promise.all(wanted.map((d) => ha.listByDomain(d))),
      loadRoomMap()
    ]);
    const rooms = new Map(roomMap.map((r) => [r.entity_id, r.rooms || []]));
    const inMap = new Set(roomMap.map((r) => r.entity_id));
    const devices = lists.flat().filter((s) => {
      if (!String(s.entity_id).startsWith('switch.')) return true;   // lights/scenes: keep all
      if (inMap.has(s.entity_id)) return true;                       // user marked it a lamp
      if (SWITCH_NOISE.test(s.entity_id)) return false;              // config sub-entity
      const n = ((s.attributes && s.attributes.friendly_name) || '').toLowerCase();
      return /lamp|świat|swiat|żyrand|zyrand|kinkiet|sufit|taśm|tasm/.test(n);
    }).map((s) => ({
      entity_id: s.entity_id,
      name: (s.attributes && s.attributes.friendly_name) || s.entity_id,
      state: s.state,
      rooms: rooms.get(s.entity_id) || []
    }));
    return { ok: true, count: devices.length, devices };
  } catch (err) {
    return { ok: false, error: friendlyErr(err) };
  }
}

const controlRoomDecl = {
  name: 'control_room',
  description: 'Włącza/wyłącza/ŚCIEMNIA WSZYSTKIE światła w danym POKOJU/MIEJSCU (np. „zapal wszystkie ' +
    'światła w salonie", „przygaś dom do 20%"). Miejsca z mapy Jurka (ha-rooms.json). service: ' +
    'turn_on/turn_off. Opcjonalnie value 0–100 = jasność (przy turn_on) — użyj do ściemniania. ' +
    'Jeśli mapa pusta albo pokój nieznany — powiedz to wprost.',
  parameters: {
    type: 'object',
    properties: {
      room: { type: 'string', description: 'Nazwa pokoju/miejsca, np. "salon", "dom".' },
      service: { type: 'string', description: 'turn_on albo turn_off.' },
      value: { type: 'number', description: 'Opcjonalnie 0–100: jasność (brightness_pct) przy turn_on.' }
    },
    required: ['room', 'service']
  }
};

async function controlRoomHandler(args = {}) {
  const room = String(args.room || '').toLowerCase().trim();
  const service = String(args.service || '').trim();
  const value = args.value;
  if (!room) return { ok: false, error: 'podaj pokój/miejsce' };
  if (service !== 'turn_on' && service !== 'turn_off') {
    return { ok: false, error: 'service musi być turn_on albo turn_off' };
  }
  if (!ha.available()) return { ok: false, error: 'Home Assistant niepodłączony — ' + ha.reason() };

  const map = await loadRoomMap();
  if (!map.length) {
    return { ok: false, error: 'Mapa pokoi jest pusta — Jurek musi uzupełnić bridge/ha-rooms.json (pola rooms).' };
  }
  const targets = map.filter((r) => (r.rooms || []).some((x) => String(x).toLowerCase().trim() === room));
  if (!targets.length) {
    const known = [...new Set(map.flatMap((r) => r.rooms || []))];
    return { ok: false, error: 'Nie znam miejsca „' + room + '". Znane: ' + (known.join(', ') || 'brak') + '.' };
  }
  // brightness_pct only applies to lights on turn_on; switches ignore it.
  const useBright = service === 'turn_on' && value != null && Number.isFinite(Number(value));
  const results = [];
  for (const t of targets) {
    const domain = t.entity_id.includes('.') ? t.entity_id.slice(0, t.entity_id.indexOf('.')) : 'light';
    const data = { entity_id: t.entity_id };
    if (useBright && domain === 'light') data.brightness_pct = Math.max(0, Math.min(100, Number(value)));
    try {
      await ha.callService(domain, service, data);
      results.push({ entity_id: t.entity_id, name: t.name, ok: true });
    } catch (_e) {
      results.push({ entity_id: t.entity_id, name: t.name, ok: false });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return {
    ok: okCount > 0,
    room,
    service,
    affected: okCount,
    total: targets.length,
    lights: results.map((r) => r.name)
  };
}

// --- learn_lamp: remember a lamp Jurek named that wasn't in the map (v4-g) ------
const learnLampDecl = {
  name: 'learn_lamp',
  description: 'ZAPAMIĘTUJE NA STAŁE lampę, której nie było na liście urządzeń. Użyj, gdy home_devices ' +
    'jej nie pokazało, a Jurek podał jej entity_id (albo powiedział „to jest ta lampa") i sterowanie ' +
    'zadziałało — wtedy dopisz ją do mapy, żeby na przyszłość była widoczna i łapały ją komendy ' +
    'pokojowe. Podaj entity_id (light.* lub switch.*), name (przyjazna nazwa) i rooms (miejsca, ' +
    'np. ["salon","dom"]) jeśli Jurek je powiedział. Po zapisie krótko potwierdź, że zapamiętałeś.',
  parameters: {
    type: 'object',
    properties: {
      entity_id: { type: 'string', description: 'Encja HA lampy, np. "switch.lampa_biurko".' },
      name: { type: 'string', description: 'Przyjazna nazwa, np. „Lampka biurko".' },
      rooms: { type: 'array', items: { type: 'string' }, description: 'Miejsca, np. ["salon","dom"].' }
    },
    required: ['entity_id']
  }
};

async function learnLampHandler(args = {}) {
  const entity_id = String(args.entity_id || '').trim();
  if (!/^(light|switch)\.[a-z0-9_]+$/i.test(entity_id)) {
    return { ok: false, error: 'entity_id musi być light.* albo switch.*' };
  }
  const base = ((window.GZOWO_CONFIG || {}).bridge || {}).url || '';
  let res;
  try {
    res = await fetch(base.replace(/\/$/, '') + '/ha/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id, name: args.name, rooms: args.rooms })
    });
  } catch (_e) {
    return { ok: false, error: 'most nieosiągalny — nie zapisałem lampy' };
  }
  let data = null;
  try { data = await res.json(); } catch (_e) { /* non-JSON */ }
  if (!res.ok || !data || !data.ok) {
    return { ok: false, error: (data && data.error) || 'nie udało się zapisać lampy' };
  }
  bus.emit('toast', { text: '💡 Zapamiętałem lampę: ' + (data.name || entity_id) +
    (data.rooms && data.rooms.length ? ' (' + data.rooms.join(', ') + ')' : ''), kind: 'info' });
  return { ok: true, learned: data.learned, name: data.name, rooms: data.rooms, is_new: data.is_new };
}

const controlHomeDecl = {
  name: 'control_home',
  description: 'Steruje encją Home Assistant (np. światłem). entity_id weź z home_devices ' +
    '(dopasuj po nazwie — NIE pytaj Jurka o id), service: turn_on / turn_off / toggle, ' +
    'opcjonalnie value 0–100 dla jasności. NIE DOPYTUJ o to, co Jurek już powiedział: ' +
    '„zapal/włącz" = turn_on, „zgaś/wyłącz" = turn_off — wykonuj od razu, bez pytania ' +
    '„włączyć czy wyłączyć?". Wynik ma verified_state = realny stan po akcji (z odczekaniem, ' +
    'bo HA raportuje z opóźnieniem); changed:true = zadziałało, powiedz krótko „zapalone". ' +
    'Gdy changed:false, zobacz pole note — nie strasz Jurka pytaniami o prąd. ZAWSZE potwierdź ' +
    'akcję nieodwracalną/niebezpieczną (zamek, brama, ogrzewanie, silnik).',
  parameters: {
    type: 'object',
    properties: {
      entity_id: { type: 'string', description: 'Encja HA z home_devices, np. "light.salon".' },
      service: { type: 'string', description: 'Usługa HA: turn_on, turn_off, toggle itp.' },
      value: { type: 'number', description: 'Opcjonalnie 0–100: jasność (brightness_pct).' }
    },
    required: ['entity_id', 'service']
  }
};

// Read back the entity's REAL state after a service call (single source of truth
// for what the model may claim). Returns the trimmed state object or null.
async function readEntity(entityId) {
  const domain = entityId.includes('.') ? entityId.slice(0, entityId.indexOf('.')) : entityId;
  const states = await ha.listByDomain(domain);
  return (Array.isArray(states) ? states : [])
    .find((s) => s && s.entity_id === entityId) || null;
}

async function controlHomeHandler(args = {}) {
  const entityId = args.entity_id;
  const service = args.service;
  const value = args.value;

  if (typeof entityId !== 'string' || !entityId) {
    return { ok: false, error: 'Brak entity_id — najpierw wywołaj home_devices i dopasuj po nazwie.' };
  }
  if (typeof service !== 'string' || !service) {
    return { ok: false, error: 'Brak nazwy usługi (service).' };
  }
  if (!ha.available()) {
    return { ok: false, error: 'Home Assistant niepodłączony — ' + ha.reason() };
  }

  // Domain is the entity_id prefix ('light.salon' -> 'light').
  const domain = entityId.includes('.') ? entityId.slice(0, entityId.indexOf('.')) : entityId;
  const data = { entity_id: entityId };
  if (value != null) data.brightness_pct = value;

  try {
    // HA answers 200 with an empty changed-states array even for a NONEXISTENT
    // entity — that used to read as success and made Gzowo lie ("zapaliłem").
    // Truth now comes from re-reading the entity itself.
    const before = await readEntity(entityId);
    if (!before) {
      return {
        ok: false,
        error: 'Encja "' + entityId + '" nie istnieje w HA — wywołaj home_devices i dopasuj po nazwie.'
      };
    }
    await ha.callService(domain, service, data);
    // v4 #11: HA often reports the new state with a LAG (integrations push it a
    // beat later) — an instant read said "off", Gzowo told Jurek the light didn't
    // turn on while it visibly did. Poll up to ~2.5s until the state changes.
    let after = null;
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 250 : 550));
      after = await readEntity(entityId);
      if (after && after.state !== before.state) break;
    }
    return {
      ok: true,
      entity_id: entityId,
      service,
      previous_state: before.state,
      verified_state: after ? after.state : 'unknown',
      changed: Boolean(after && after.state !== before.state),
      note: (after && after.state === before.state)
        ? 'Stan w HA się nie zmienił w 2.5s — ale HA bywa opóźnione; jeśli Jurek mówi, że światło się zmieniło, uwierz Jurkowi.'
        : undefined
    };
  } catch (err) {
    return { ok: false, error: friendlyErr(err) };
  }
}

// ---------------------------------------------------------------------------
// init — register the widget + tools on the shared router (idempotent).
// ---------------------------------------------------------------------------
export async function init() {
  toolRouter.registerWidget('home', homeDef);
  toolRouter.registerTool(showHomeDecl, showHomeHandler);
  toolRouter.registerTool(homeStatusDecl, homeStatusHandler);
  toolRouter.registerTool(homeDevicesDecl, homeDevicesHandler);
  toolRouter.registerTool(controlHomeDecl, controlHomeHandler);
  toolRouter.registerTool(controlRoomDecl, controlRoomHandler);
  toolRouter.registerTool(learnLampDecl, learnLampHandler);
}
